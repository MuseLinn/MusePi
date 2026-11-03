/**
 * The page kit is a contract between the stylesheet the sandbox receives and
 * the class list the model is told about. A class in one and not the other is
 * either an unstyled element or dead CSS, so both are pinned here.
 */
import { describe, expect, it } from "bun:test";
import { PAGE_KIT_CLASSES, PAGE_KIT_CSS } from "../src/widgets/page-kit";

describe("page kit", () => {
	it("styles every class it documents", () => {
		for (const row of PAGE_KIT_CLASSES) {
			const selectors = row.split(" — ")[0] ?? "";
			for (const className of selectors.matchAll(/\.(musepi-[a-z-]+)/g)) {
				expect(PAGE_KIT_CSS, className[1]).toContain(`.${className[1]}`);
			}
		}
	});

	it("carries the chart series the prompt names", () => {
		for (let i = 1; i <= 5; i += 1) expect(PAGE_KIT_CSS).toContain(`--chart-${i}:`);
	});

	it("gives the primary button a readable foreground", () => {
		// Inheriting the page's text color on an accent fill was the contrast bug
		// the old inline kit shipped.
		expect(PAGE_KIT_CSS).toContain("color:var(--accent-fg");
		expect(PAGE_KIT_CSS).toContain("background:var(--accent)");
	});

	it("sizes text from the injected root size", () => {
		expect(PAGE_KIT_CSS).toContain("font-size:var(--page-rem,14px)");
		expect(PAGE_KIT_CSS).toContain("font-size:1rem");
	});

	it("keeps the answered state dimming", () => {
		expect(PAGE_KIT_CSS).toContain("html[data-musepi-answered]");
	});
});
