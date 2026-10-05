import { beforeAll, describe, expect, test } from "bun:test";
import { ErrorBannerComponent } from "../src/modes/components/error-banner";
import { formatErrorBlock } from "../src/modes/components/error-block";
import { initTheme } from "../src/modes/theme/theme";

beforeAll(async () => {
	// The banner and the style helpers read the active theme; without this the
	// component throws on theme.fg rather than failing an assertion.
	await initTheme(false);
});

/**
 * The regression these guard: a provider error arrives as one long line, and its
 * tail is where the provider's own explanation sits. The old path truncated each
 * line at a fixed column before rendering, so on a narrow terminal the text was
 * cut twice — once at the column limit, then again by the renderer's wrap — and
 * the part that says what went wrong never reached the screen.
 */
const style = (line: string): string => line;
const hint = (hidden: number): string => `… +${hidden} more lines`;

describe("formatErrorBlock", () => {
	test("wraps a long single line instead of cutting it", () => {
		const body = `400 {"error":{"message":"The requested model is not supported.","type":"invalid_request_error","param":"model","code":"model_not_supported","request_id":"req_01J8Z4K2P7XQ3M9N5R6T7V8W9Y"}}`;
		const rendered = formatErrorBlock(body, 60, Number.POSITIVE_INFINITY, style, hint);

		// The tail survives the wrap — this is the whole point.
		expect(rendered).toContain("model_not_supported");
		expect(rendered.replace(/\s+/g, "")).toContain("request_id");
		// And no row exceeds the width it was given.
		for (const row of rendered.split("\n")) {
			expect(Bun.stringWidth(row)).toBeLessThanOrEqual(60);
		}
	});

	test("clamps by wrapped rows, not by source lines", () => {
		// Ten short source lines would fit under a source-line clamp of 4 but wrap
		// to far more than 4 rows once each is measured against the real width.
		const body = Array.from({ length: 10 }, (_, i) => `line number ${i} with some padding text`).join("\n");
		const rendered = formatErrorBlock(body, 30, 4, style, hint);

		const rows = rendered.split("\n");
		expect(rows).toHaveLength(5); // 4 kept + the overflow hint
		expect(rows[4]).toContain("more lines");
	});

	test("reports how many rows were hidden, counting wrapped rows", () => {
		const body = "x".repeat(400);
		const rendered = formatErrorBlock(body, 20, 2, style, hint);
		const rows = rendered.split("\n");

		// 400 chars at ~18 usable columns is 23 rows; 2 kept, so 21 hidden.
		expect(rows[2]).toMatch(/\+(\d+) more lines/);
		const hidden = Number(rows[2]!.match(/\+(\d+) more lines/)![1]);
		expect(hidden).toBeGreaterThan(1);
	});

	test("drops blank lines rather than spending rows on them", () => {
		const rendered = formatErrorBlock("first\n\n\n  \nsecond", 80, 4, style, hint);
		expect(rendered).toBe("first\nsecond");
	});

	test("falls back when there is no content at all", () => {
		const rendered = formatErrorBlock("   \n  ", 80, 4, style, hint);
		expect(rendered.length).toBeGreaterThan(0);
	});

	test("keeps styling per source line rather than bleeding it across the fold", () => {
		// Two differently-marked lines; the marker for the first must not appear on
		// a wrapped row belonging to the second.
		const rendered = formatErrorBlock(
			"aaaa bbbb cccc dddd eeee\n1111 2222 3333 4444 5555",
			16,
			Number.POSITIVE_INFINITY,
			(line, index) => (index === 0 ? `<A>${line}` : `<B>${line}`),
			hint,
		);
		const rows = rendered.split("\n");
		for (const row of rows) {
			if (row.includes("1111") || row.includes("2222")) {
				expect(row).toContain("<B>");
				expect(row).not.toContain("<A>");
			}
		}
	});
});

describe("ErrorBannerComponent", () => {
	test("renders a long provider error without dropping its tail", () => {
		const body = `400 {"error":{"message":"The requested model is not supported.","type":"invalid_request_error","code":"model_not_supported","request_id":"req_01J8Z4K2P7XQ3M9N5R6T7V8W9Y"}}`;
		const banner = new ErrorBannerComponent(body);
		const rendered = Bun.stripANSI(banner.render(60).join("\n"));

		// The regression: this used to truncate at 110 columns, so the provider
		// message was gone before wrapping ever happened.
		expect(rendered.replace(/\s+/g, "")).toContain("request_id");
	});
});
