/**
 * The catalog must reach the shipped shell, not just a test's props.
 *
 * Round 2's P1: the picker was gated on `catalog.length > 0`, and every call
 * site omitted the prop — so the surface tests passed on an injected value
 * while the packaged shell rendered the plain manual form. A render test cannot
 * catch that (it supplies the prop itself), so this asserts the wiring where it
 * lives: every call site passes the one catalog the shell reads.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (rel: string): string => readFileSync(join(import.meta.dir, "..", "src", rel), "utf8");

const appSource = src("app.tsx");
const gateSource = src("components/ConnectionGate.tsx");

/**
 * Every `<Component …>` opening tag in one file.
 *
 * Scanned by hand rather than by regex: a JSX tag spans newlines and contains
 * `>` inside nested expressions, so a lazy `.*?>` stops at the first one.
 */
function tags(source: string, component: string): string[] {
	const out: string[] = [];
	const needle = `<${component}`;
	let from = 0;
	for (;;) {
		const start = source.indexOf(needle, from);
		if (start === -1) return out;
		// The tag ends at the first `>` that is not inside braces or quotes.
		let depth = 0;
		let quote: string | null = null;
		for (let i = start; i < source.length; i++) {
			const char = source[i];
			if (quote) {
				if (char === quote) quote = null;
				continue;
			}
			if (char === '"' || char === "'") {
				quote = char;
				continue;
			}
			if (char === "{") depth++;
			else if (char === "}") depth--;
			else if (char === ">" && depth === 0) {
				out.push(source.slice(start, i + 1));
				from = i + 1;
				break;
			}
		}
		if (from <= start) return out;
	}
}

describe("catalog wiring in the shell", () => {
	test("app.tsx reads the catalog once", () => {
		expect(appSource).toContain("useHostCatalog()");
		expect(appSource).toContain("catalog={hostCatalog}");
	});

	test("every ConnectDialog call site receives it", () => {
		const sites = tags(appSource, "ConnectDialog");
		expect(sites.length).toBeGreaterThan(0);
		for (const site of sites) expect(site).toContain("catalog={hostCatalog}");
	});

	test("the gate forwards it rather than swallowing it", () => {
		// The gate is the entrance the boot/failure surfaces use; without the
		// prop there, those surfaces render the manual form while the avatar menu
		// renders the picker.
		expect(gateSource).toContain("catalog?: readonly CatalogHost[]");
		const sites = tags(gateSource, "ConnectionManager");
		expect(sites.length).toBeGreaterThan(0);
		for (const site of sites) expect(site).toContain("catalog={catalog}");
	});

	test("the gate's own call site in app.tsx passes it", () => {
		const sites = tags(appSource, "ConnectionGate");
		expect(sites.length).toBeGreaterThan(0);
		for (const site of sites) expect(site).toContain("catalog={hostCatalog}");
	});
});
