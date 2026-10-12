/**
 * Renderer CSP contract: the page must allow blob: module scripts.
 *
 * Extension-contributed slot components reach the GUI as daemon-compiled ESM
 * text (extensions.list → blob: URL → dynamic import, see slot-host.tsx
 * SlotComponentMount). The CSP in index.html gates script execution, and a
 * policy without `script-src blob:` rejects exactly those imports with
 * "TypeError: Failed to fetch dynamically imported module: blob:…" — the
 * first third-party plugin panel (musepi-auth-hub's settings.extensions
 * panel) is what surfaced it, because the built-in units' hosts never
 * blob-imported under the old policy.
 *
 * Source-grep guard per AGENTS.md: this reads an index.html the build emits
 * into the page (a host artifact, not implementation source) and asserts the
 * security contract the renderer runs under. A regression here is silent in
 * every unit test — the component load just fails at runtime.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1];

function directive(name: string): string | null {
	if (!csp) return null;
	const dir = csp
		.split(";")
		.map(d => d.trim())
		.find(d => d.startsWith(name));
	return dir ?? null;
}

describe("renderer Content-Security-Policy", () => {
	it("declares a CSP at all", () => {
		expect(csp).toBeTruthy();
	});

	it("allows blob: module scripts (extension slot components are blob-imported)", () => {
		const scriptSrc = directive("script-src");
		expect(scriptSrc).toBeTruthy();
		expect(scriptSrc!.split(/\s+/)).toContain("blob:");
	});

	it("still refuses eval (no unsafe-eval in script-src)", () => {
		const scriptSrc = directive("script-src");
		expect(scriptSrc).toBeTruthy();
		expect(scriptSrc!.split(/\s+/)).not.toContain("'unsafe-eval'");
	});
});
