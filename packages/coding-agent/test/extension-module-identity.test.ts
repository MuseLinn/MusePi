/**
 * Extension module-identity contract.
 *
 * Bun caches ESM by specifier and offers exactly two behaviours: a bare
 * `import(path)` serves the cached module, while `import(path?tag)` re-evaluates
 * it as a NEW instance. There is no "re-evaluate but keep identity" option.
 *
 * A plugin system needs BOTH, in different places, so the loader exposes them
 * as one option (`fresh`) rather than baking one in:
 *
 * - **first load (`fresh` absent)** must SHARE identity. Every consumer — a
 *   live session, the artifact compiler serving `ext.call`, the cordis runtime —
 *   then holds the same module object, so module-level state is one value. The
 *   bug this fixed: each loader produced its own copy, and a plugin that
 *   captured the session context in a module variable answered `null` through
 *   its own RPC.
 * - **reload (`fresh: true`)** must RE-EVALUATE, or new bytes on disk never
 *   take effect — that is HMR's whole precondition.
 *
 * These tests pin both halves against a real temp extension, because the failure
 * mode on either side is silent: a shared-but-stale module looks like "the edit
 * did nothing", and a per-load instance looks like "the plugin forgot its state".
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { loadExtensions } from "../src/extensibility/extensions/loader";

/** Reset the probe counters a temp extension writes to. */
function clearProbes(): void {
	const g = globalThis as {
		__identEvals?: { n: number };
		__versionSeen?: { v: string };
	};
	delete g.__identEvals;
	delete g.__versionSeen;
}

afterEach(clearProbes);

/** Write a temp extension whose module body counts its own evaluations. */
async function evalCountingExtension(): Promise<{ entry: string; dir: string; evals: () => number }> {
	const dir = await mkdtemp(path.join(tmpdir(), "ext-ident-"));
	const entry = path.join(dir, "index.ts");
	await writeFile(
		entry,
		`const box = ((globalThis as any).__identEvals ??= { n: 0 });
box.n += 1;
export default function (pi: any): void { pi.on("session_start", () => {}); }
`,
	);
	clearProbes();
	return {
		entry,
		dir,
		evals: () => (globalThis as { __identEvals?: { n: number } }).__identEvals?.n ?? 0,
	};
}

describe("module identity", () => {
	test("two independent loads SHARE one module instance", async () => {
		// This is what makes plugin state coherent across the session loader, the
		// ext.call compiler and the cordis runtime: one module object, one value.
		const ext = await evalCountingExtension();
		try {
			await loadExtensions([ext.entry], process.cwd());
			await loadExtensions([ext.entry], process.cwd());
			expect(ext.evals()).toBe(1);
		} finally {
			await rm(ext.dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("a fresh load RE-EVALUATES the module", async () => {
		// HMR's precondition: the reload path must not be served a cached copy.
		// Without this, an edited plugin keeps running its old code forever.
		const ext = await evalCountingExtension();
		try {
			await loadExtensions([ext.entry], process.cwd());
			expect(ext.evals()).toBe(1);
			await loadExtensions([ext.entry], process.cwd(), undefined, { fresh: true });
			expect(ext.evals()).toBe(2);
		} finally {
			await rm(ext.dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("a fresh load picks up edited bytes; a plain one keeps the old ones", async () => {
		// The end-to-end HMR contract: editing the file and reloading must run the
		// new code, and only the fresh path can do it.
		const dir = await mkdtemp(path.join(tmpdir(), "ext-version-"));
		const entry = path.join(dir, "index.ts");
		const body = (version: string): string => `export const VERSION = "${version}";
export default function (pi: any): void {
	((globalThis as any).__versionSeen ??= { v: "" }).v = VERSION;
	pi.on("session_start", () => {});
}
`;
		clearProbes();
		try {
			await writeFile(entry, body("v1"));
			await loadExtensions([entry], process.cwd());
			const seen = (): string => (globalThis as { __versionSeen?: { v: string } }).__versionSeen?.v ?? "";
			expect(seen()).toBe("v1");

			await writeFile(entry, body("v2"));
			// A non-fresh load is served from cache: this is WHY reload must be fresh.
			await loadExtensions([entry], process.cwd());
			expect(seen()).toBe("v1");

			await loadExtensions([entry], process.cwd(), undefined, { fresh: true });
			expect(seen()).toBe("v2");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("bundled plugin packages are no longer a separate load class", async () => {
		// The old `isBundledPluginPath` branch gave the host's own plugin tree a
		// different import semantic (plain import, no graph snapshot), splitting
		// plugin identity into two classes. Shipping the package is not a reason
		// to load it differently — the shared path must accept it like any other.
		const dir = await mkdtemp(path.join(tmpdir(), "bundled-like-"));
		// A path that RESEMBLES the bundled tree, to prove the check is gone
		// rather than merely unused for real bundled entries.
		const nested = path.join(dir, "src", "bundled-plugins", "demo");
		await mkdirp(nested);
		const entry = path.join(nested, "index.ts");
		await writeFile(
			entry,
			`const box = ((globalThis as any).__identEvals ??= { n: 0 });
box.n += 1;
export default function (pi: any): void { pi.on("session_start", () => {}); }
`,
		);
		clearProbes();
		try {
			const first = await loadExtensions([entry], process.cwd());
			expect(first.errors).toEqual([]);
			expect(first.extensions).toHaveLength(1);
			// The shared-identity rule applies to it too — no second class.
			await loadExtensions([entry], process.cwd());
			expect((globalThis as { __identEvals?: { n: number } }).__identEvals?.n ?? 0).toBe(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);
});

/** `mkdir -p` without importing fs/promises' recursive option at every site. */
async function mkdirp(dir: string): Promise<void> {
	const { mkdir } = await import("node:fs/promises");
	await mkdir(dir, { recursive: true });
}
