import { describe, expect, test } from "bun:test";
import { widgetRenderer } from "./widget";

/**
 * The collapsed row's parenthetical. A widget names itself with its title; the
 * type tag is the fallback for an untitled card, and nothing renders while the
 * call has neither (the chrome then hides the empty paren pair).
 */
function summary(args: unknown, result: unknown): string {
	// `Summary` is a ComponentType; this renderer declares it as a plain
	// function, and the test calls it directly to check the string it returns.
	const render = widgetRenderer.Summary as unknown as (props: { args: unknown; result: unknown }) => string;
	return render({ args, result });
}

describe("widget tool summary", () => {
	test("prefers the widget title over the type tag", () => {
		expect(summary({}, { details: { type: "html", title: "Alice × Bob 五轮对话", data: {} } })).toBe(
			"Alice × Bob 五轮对话",
		);
	});

	test("uses the title from args while the call is still running", () => {
		expect(summary({ action: "page", title: "Compare plans" }, undefined)).toBe("Compare plans");
	});

	test("falls back to the widget type when there is no title", () => {
		expect(summary({}, { details: { type: "calc", data: {} } })).toBe("calc");
	});

	test("renders nothing when the payload has not arrived", () => {
		expect(summary({}, undefined)).toBe("");
	});
});
