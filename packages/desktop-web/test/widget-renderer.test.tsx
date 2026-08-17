/**
 * Inline widget renderer tests: the tool result payload arrives as
 * `result.details` ({type, data, title?} — the widget tool's
 * WidgetToolDetails), never as a flat `result.type`/`result.data` (that
 * flat shape was the renderer's original assumption and rendered every
 * inline widget empty). Covers unknown-type fallback, data passthrough,
 * error-text surfacing, and the late-data adopt guard.
 */
import { describe, expect, it } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WidgetErrorBoundary } from "../src/widgets/error-boundary";
import type { ToolRenderProps } from "../src/tool-render/types";
import { widgetRenderer, widgetDataEq } from "../src/tool-render/tools/widget";
import { collectWidgetPayloads, latestWidgetFromEntries } from "../src/components/transcript/widget-standalone";
import { widgetHostTheme } from "../src/widgets/html";

// widgetRenderer always ships both renderers; the shared ToolRenderer type
// marks Body optional (other renderers may omit it) and ComponentType is a
// class|function union TS refuses to invoke directly — alias to a plain
// function shape for direct calls in these SSR tests.
const renderBody = widgetRenderer.Body as (props: ToolRenderProps) => ReactNode;

/** Wire-shaped widget tool result: content + details, isError when failed. */
function widgetResult(type: string, data: Record<string, unknown>, title?: string): ToolRenderProps["result"] {
	return {
		content: [{ type: "text", text: `Rendered ${type} widget.` }],
		details: { type, data, ...(title !== undefined ? { title } : {}) },
	};
}

describe("inline widget renderer", () => {
	it("renders a calc widget from result.details with merged data", () => {
		const html = renderToStaticMarkup(
			renderBody({
				args: { type: "calc", data: { amount: 2000 } },
				result: widgetResult("calc", { mode: "post", amount: 2000 }),
			} as never),
		);
		expect(html).toContain("tv-widget");
		expect(html).toContain("calc");
		expect(html).toContain("2000");
	});

	it("falls back to the unknown-type note when the type is stale", () => {
		const html = renderToStaticMarkup(
			renderBody({
				args: { type: "nope" },
				result: widgetResult("nope", {}),
			} as never),
		);
		expect(html).not.toContain("tv-widget");
		expect(html).toContain("Unknown widget");
	});

	it("uses the type's i18n name as the default title", () => {
		const html = renderToStaticMarkup(
			renderBody({
				args: { type: "pomodoro" },
				result: widgetResult("pomodoro", {}),
			} as never),
		);
		expect(html).toContain("tv-widget-title");
	});

	it("passes details data through to the shared component untouched", () => {
		const html = renderToStaticMarkup(
			renderBody({
				args: { type: "ticker", data: { label: "USD / CNY" } },
				result: widgetResult("ticker", { label: "USD / CNY", value: "6.7634" }),
			} as never),
		);
		expect(html).toContain("USD / CNY");
		expect(html).toContain("6.7634");
	});

	it("renders the custom HTML face with the injected html in the sandbox srcdoc", () => {
		const html = renderToStaticMarkup(
			renderBody({
				args: { type: "html" },
				result: widgetResult("html", { html: "<div class=\"plot\">档案潜行</div>", data: { plot: "起" } }),
			} as never),
		);
		expect(html).toContain("gui-widget-html");
		expect(html).toContain("档案潜行");
	});

	it("injects the host theme into the sandbox srcdoc (theme adaptation)", () => {
		const html = renderToStaticMarkup(
			renderBody({
				args: { type: "html" },
				result: widgetResult("html", { html: "<div class=\"plot\">x</div>", data: {} }),
			} as never),
		);
		// SSR has no document → the dark default; the class + global give the
		// face both CSS and JS hooks to adapt to the host scheme (the srcDoc
		// attribute is HTML-escaped by React — decoded in the live iframe).
		expect(html).toContain("omp-theme-dark");
		expect(html).toContain("__WIDGET_THEME__");
		expect(html).toContain("color-scheme:dark");
		expect(html).toContain("color-scheme:light");
	});

	it("surfaces the error text instead of a blank card when the call failed", () => {
		const html = renderToStaticMarkup(
			renderBody({
				args: { type: "html" },
				result: {
					content: [
						{ type: "text", text: 'Validation failed for tool "widget":\n  - data: data must be Widget data fields per type' },
					],
					details: { type: "html", data: {} },
					isError: true,
				},
			} as never),
		);
		expect(html).toContain("Validation failed");
		expect(html).not.toContain("gui-widget-html");
	});

	it("flags widget failures via the error boundary (client-side catch)", () => {
		// SSR cannot exercise componentDidCatch, but the boundary's static
		// transition is the contract the client relies on: any widget
		// render error degrades to the note, never crashing the transcript.
		const state = WidgetErrorBoundary.getDerivedStateFromError(new Error("boom"));
		expect(state.failed).toBe(true);
	});
});

describe("widgetDataEq (late-data adopt guard)", () => {
	it("treats two empty records as equal (running-state placeholder churn)", () => {
		expect(widgetDataEq({}, {})).toBe(true);
	});

	it("detects the real payload landing after the empty placeholder", () => {
		expect(widgetDataEq({}, { html: "<div>x</div>", data: {} })).toBe(false);
		// Nested values compare by reference — a rebuilt equivalent object
		// differs, the same object (the stable result reference) is equal.
		const data = { html: "<div>x</div>", data: { plot: "起" } };
		expect(widgetDataEq(data, data)).toBe(true);
		expect(widgetDataEq({ html: "<div>x</div>" }, data)).toBe(false);
	});

	it("compares keys and values", () => {
		expect(widgetDataEq({ a: 1 }, { a: 1, b: 2 })).toBe(false);
		expect(widgetDataEq({ a: 1 }, { a: 2 })).toBe(false);
		expect(widgetDataEq({ a: "x" }, { a: "x" })).toBe(true);
	});
});

describe("widgetHostTheme (html face theme source)", () => {
	it("defaults to dark without a document (SSR/export)", () => {
		const saved = globalThis.document;
		// @ts-expect-error test seam — SSR has no document
		globalThis.document = undefined;
		try {
			expect(widgetHostTheme()).toBe("dark");
		} finally {
			globalThis.document = saved;
		}
	});

	it("reads data-color-scheme first, then legacy data-theme", () => {
		const saved = globalThis.document;
		try {
			globalThis.document = { documentElement: { dataset: { colorScheme: "light", theme: "dark" } } } as never;
			expect(widgetHostTheme()).toBe("light");
			globalThis.document = { documentElement: { dataset: { theme: "light" } } } as never;
			expect(widgetHostTheme()).toBe("light");
			globalThis.document = { documentElement: { dataset: {} } } as never;
			expect(widgetHostTheme()).toBe("dark");
		} finally {
			globalThis.document = saved;
		}
	});
});

describe("widget standalone payload extraction", () => {
	function call(id: string, name: string): { type: "toolCall"; id: string; name: string } {
		return { type: "toolCall", id, name };
	}
	function result(id: string, details: unknown, isError = false) {
		return { id, content: [], details, isError };
	}

	it("collects successful widget payloads from an assistant message", () => {
		const content = [call("a", "widget"), call("b", "bash")];
		const results = new Map([
			[result("a", { type: "calc", data: { amount: 2000 }, title: "个税" }).id, result("a", { type: "calc", data: { amount: 2000 }, title: "个税" })],
			[result("b", { type: "bash", data: {} }).id, result("b", { type: "bash", data: {} })],
		] as never);
		const payloads = collectWidgetPayloads(content as never, results as never);
		expect(payloads).toHaveLength(1);
		expect(payloads[0]!.type).toBe("calc");
		expect(payloads[0]!.data).toEqual({ amount: 2000 });
		expect(payloads[0]!.title).toBe("个税");
	});

	it("dedupes re-renders of the same widget (last wins)", () => {
		const content = [call("a", "widget"), call("b", "widget")];
		const first = { type: "html", data: { html: "<div>x</div>" } };
		const second = { type: "html", data: { html: "<div>x</div>" } };
		const results = new Map([
			[result("a", first).id, result("a", first)],
			[result("b", second).id, result("b", second)],
		] as never);
		const payloads = collectWidgetPayloads(content as never, results as never);
		expect(payloads).toHaveLength(1);
	});

	it("skips failed widget calls", () => {
		const content = [call("a", "widget")];
		const results = new Map([
			[result("a", { type: "html", data: {} }, true).id, result("a", { type: "html", data: {} }, true)],
		] as never);
		expect(collectWidgetPayloads(content as never, results as never)).toHaveLength(0);
	});

	it("finds the latest widget across session entries (sidebar tab)", () => {
		const entries = [
			{ type: "message", message: { role: "toolResult", toolName: "calc", details: { type: "calc", data: { amount: 1 } } } },
			{ type: "message", message: { role: "toolResult", toolName: "widget", details: { type: "ticker", data: { label: "EUR" } } } },
			{ type: "message", message: { role: "toolResult", toolName: "widget", details: { type: "html", data: { html: "<p>新</p>" } } } },
		];
		const payload = latestWidgetFromEntries(entries);
		expect(payload?.type).toBe("html");
		expect(payload?.data).toEqual({ html: "<p>新</p>" });
	});

	it("skips errored and non-widget entries in the sidebar scan", () => {
		const entries = [
			{ type: "message", message: { role: "toolResult", toolName: "widget", details: { type: "html", data: {} }, isError: true } },
			{ type: "message", message: { role: "user", content: "hi" } },
		];
		expect(latestWidgetFromEntries(entries)).toBeNull();
	});
});
