/**
 * The widget face runs in a `srcdoc` iframe, which inherits the host page's
 * CSP. That policy allows `'unsafe-inline'` but not `'unsafe-eval'`, so an
 * `eval()` in the injected bootstrap is silently blocked by the renderer —
 * the annotation entry then reported a null result and the button looked
 * dead. Source-grep guard: the bootstrap must reach the overlay through an
 * inline `<script>`, never through eval.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";

const source = fs.readFileSync(new URL("../src/widgets/html.tsx", import.meta.url), "utf8");

describe("widget sandbox bootstrap", () => {
	it("never evaluates code (the inherited CSP has no unsafe-eval)", () => {
		expect(source).not.toMatch(/\beval\s*\(/);
	});

	it("injects the annotation overlay as an inline script, which the CSP allows", () => {
		expect(source).toContain('createElement("script")');
		expect(source).toContain("__musepiAnnotationResult");
	});
});
