#!/usr/bin/env bun
/**
 * Generate an electronAPI stub by PARSING electron/preload.cjs.
 *
 * Hand-maintaining a stub next to a 100+ method preload is a drift trap: the
 * day someone adds `electronAPI.foo()` the stub silently lacks it and the
 * renderer throws "foo is not a function" — which is exactly the failure this
 * script exists to prevent.
 *
 * So the stub is DERIVED from the preload's own source: every top-level
 * `name:` in the object literal passed to exposeInMainWorld becomes a method
 * on the stub. Methods return a resolved promise (or undefined for event
 * subscriptions, which must return an unsubscribe function).
 *
 * Usage:
 *   bun packages/desktop-app/scripts/capture-marketing-shots.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..");
const PRELOAD = join(APP_DIR, "electron", "preload.cjs");

/**
 * Event-subscription methods: the renderer does `const unsub = api.onX(cb)`
 * and later calls `unsub()`. A stub that returns undefined breaks that
 * contract, so these return an unsubscribe function.
 *
 * Detected by name convention (`on…` / `check…` are ambiguous, so only `on*`
 * and the known listener names count).
 */
function isSubscription(name) {
	return /^on[A-Z]/.test(name);
}

/**
 * Extract the top-level keys of the object literal passed to
 * exposeInMainWorld("electronAPI", { … }).
 *
 * A real parser would be overkill; the preload is a hand-written literal with
 * one key per line, so matching `^\t(\w+):` at the literal's indentation is
 * reliable. Nested objects (trayMenu) are handled separately.
 */
export function extractApiNames(source) {
	const start = source.indexOf('exposeInMainWorld("electronAPI", {');
	if (start < 0) throw new Error("preload.cjs: electronAPI literal not found");
	const body = source.slice(start);

	const names = new Set();
	// Top-level keys sit at one tab of indentation inside the literal.
	for (const line of body.split("\n")) {
		const match = /^\t(\w+):/.exec(line);
		if (match) names.add(match[1]);
	}
	return [...names];
}

/** Nested namespaces the renderer reaches through (e.g. electronAPI.trayMenu). */
export function extractNestedNames(source) {
	const start = source.indexOf('exposeInMainWorld("electronAPI", {');
	const body = source.slice(start);
	const nested = new Map();
	const lines = body.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const open = /^\t(\w+): \{$/.exec(lines[i]);
		if (!open) continue;
		const inner = new Set();
		for (let j = i + 1; j < lines.length; j++) {
			if (/^\t\},?$/.test(lines[j])) break;
			const key = /^\t\t(\w+):/.exec(lines[j]);
			if (key) inner.add(key[1]);
		}
		nested.set(open[1], [...inner]);
	}
	return nested;
}

/** Build the browser-side stub source. */
export function buildStub(names, nested) {
	const parts = [];
	for (const name of names) {
		if (isSubscription(name)) {
			parts.push(`${name}: (cb) => { window.__shotSubs.push([${JSON.stringify(name)}, cb]); return () => {}; }`);
		} else if (nested.has(name)) {
			const inner = nested.get(name);
			const innerEntries = inner
				.map(key =>
					isSubscription(key)
						? `${key}: (cb) => { window.__shotSubs.push([${JSON.stringify(name)}.${JSON.stringify(key)}, cb]); return () => {}; }`
						: `${key}: () => undefined`,
				)
				.join(", ");
			parts.push(`${name}: { ${innerEntries} }`);
		} else {
			parts.push(`${name}: () => undefined`);
		}
	}

	return `(() => {
  const noop = () => {};
  window.__shotSubs = [];
  const api = {
    platform: "win32",
    getAppVersion: () => Promise.resolve("0.5.6"),
    probeDaemonPort: () => Promise.resolve(null),
    startDaemon: () => Promise.resolve(null),
    getDroppedFilePath: () => "",
    ${parts.join(",\n    ")},
  };
  // Any method the preload does not define still resolves to a no-op instead of
  // throwing, so a future preload addition cannot break the capture.
  window.electronAPI = new Proxy(api, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === "string") return noop;
      return undefined;
    },
  });
  window.__MUSEPI_SHOT__ = true;
})();`;
}

if (import.meta.main) {
	const source = readFileSync(PRELOAD, "utf8");
	const names = extractApiNames(source);
	const nested = extractNestedNames(source);
	console.log(`[stub] ${names.length} api names, ${nested.size} namespaces`);
	console.log(`[stub] subscriptions: ${names.filter(isSubscription).length}`);
	console.log(`[stub] namespaces: ${[...nested.keys()].join(", ")}`);
}
