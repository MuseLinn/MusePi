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
import { collectWidgetPayloads, latestWidgetFromEntries } from "../src/components/transcript/widget-standalone";
import { widgetDataEq, widgetRenderer } from "../src/tool-render/tools/widget";
import type { ToolRenderProps } from "../src/tool-render/types";
import { WidgetErrorBoundary } from "../src/widgets/error-boundary";
import { createAnswerGate, readFaceTokens, readWidgetFaceMessage, widgetHostTheme } from "../src/widgets/html";

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
				result: widgetResult("html", { html: '<div class="plot">档案潜行</div>', data: { plot: "起" } }),
			} as never),
		);
		expect(html).toContain("gui-widget-html");
		expect(html).toContain("档案潜行");
	});

	it("injects the host theme into the sandbox srcdoc (theme adaptation)", () => {
		const html = renderToStaticMarkup(
			renderBody({
				args: { type: "html" },
				result: widgetResult("html", { html: '<div class="plot">x</div>', data: {} }),
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
						{
							type: "text",
							text: 'Validation failed for tool "widget":\n  - data: data must be Widget data fields per type',
						},
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
			[
				result("a", { type: "calc", data: { amount: 2000 }, title: "个税" }).id,
				result("a", { type: "calc", data: { amount: 2000 }, title: "个税" }),
			],
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
			{
				type: "message",
				message: { role: "toolResult", toolName: "calc", details: { type: "calc", data: { amount: 1 } } },
			},
			{
				type: "message",
				message: { role: "toolResult", toolName: "widget", details: { type: "ticker", data: { label: "EUR" } } },
			},
			{
				type: "message",
				message: { role: "toolResult", toolName: "widget", details: { type: "html", data: { html: "<p>新</p>" } } },
			},
		];
		const payload = latestWidgetFromEntries(entries);
		expect(payload?.type).toBe("html");
		expect(payload?.data).toEqual({ html: "<p>新</p>" });
	});

	it("skips errored and non-widget entries in the sidebar scan", () => {
		const entries = [
			{
				type: "message",
				message: { role: "toolResult", toolName: "widget", details: { type: "html", data: {} }, isError: true },
			},
			{ type: "message", message: { role: "user", content: "hi" } },
		];
		expect(latestWidgetFromEntries(entries)).toBeNull();
	});
});

/**
 * The sandbox face's answer channel. A face is model-authored HTML, so the
 * contract that matters is what the host refuses: a submit only counts when
 * it came from this card's own frame, and what it says is bounded.
 */
describe("sandbox face answer channel", () => {
	const own = {} as MessageEventSource;
	const foreign = {} as MessageEventSource;

	it("routes a submit from the card's own frame to the host", () => {
		expect(readWidgetFaceMessage(own, own, { type: "musepi-widget-submit", text: "A 档" })).toEqual({
			kind: "submit",
			text: "A 档",
		});
	});

	it("ignores a submit forged by another window on the page", () => {
		// Without the source check any frame in the app could inject text
		// into the conversation through a widget card.
		expect(readWidgetFaceMessage(foreign, own, { type: "musepi-widget-submit", text: "injected" })).toBeNull();
	});

	it("ignores a resize forged by another window on the page", () => {
		expect(readWidgetFaceMessage(foreign, own, { type: "musepi-widget-resize", height: 9999 })).toBeNull();
	});

	it("acts on nothing while the card has no frame yet", () => {
		expect(readWidgetFaceMessage(own, null, { type: "musepi-widget-submit", text: "x" })).toBeNull();
		expect(readWidgetFaceMessage(own, null, { type: "musepi-widget-resize", height: 10 })).toBeNull();
	});

	it("caps what one face may say into the conversation", () => {
		const msg = readWidgetFaceMessage(own, own, { type: "musepi-widget-submit", text: "x".repeat(50_000) });
		expect(msg).toEqual({ kind: "submit", text: "x".repeat(8_000) });
	});

	it("drops empty, malformed and unknown shapes", () => {
		expect(readWidgetFaceMessage(own, own, { type: "musepi-widget-submit", text: "" })).toBeNull();
		expect(readWidgetFaceMessage(own, own, { type: "musepi-widget-submit" })).toBeNull();
		expect(readWidgetFaceMessage(own, own, { type: "omp-widget-submit", text: "x" })).toBeNull();
		expect(readWidgetFaceMessage(own, own, null)).toBeNull();
		expect(readWidgetFaceMessage(own, own, "a string")).toBeNull();
	});

	it("still carries the auto-height report the card already depended on", () => {
		expect(readWidgetFaceMessage(own, own, { type: "musepi-widget-resize", height: 412 })).toEqual({
			kind: "resize",
			height: 412,
		});
	});

	it("refuses an oversized face rather than rendering half a document", () => {
		const html = renderToStaticMarkup(
			renderBody({
				args: { type: "html" },
				result: widgetResult("html", { html: `<p>${"y".repeat(70_000)}</p>`, data: {} }),
			} as never),
		);
		expect(html).toContain("gui-widget-html-empty");
		expect(html).not.toContain("yyyyyy");
	});

	it("exposes the submit helper to the face inside the sandbox", () => {
		const html = renderToStaticMarkup(
			renderBody({
				args: { type: "html" },
				result: widgetResult("html", { html: '<div class="plot">x</div>', data: {} }),
			} as never),
		);
		// A face must be able to reach the channel; the legacy alias stays
		// because faces written before the rename bind to it.
		expect(html).toContain("musepiSubmit");
		expect(html).toContain("musepi-widget-submit");
		expect(html).toContain("musepi-theme-dark");
	});
});

describe("one card answers at most once", () => {
	it("claims the first answer and refuses every later one", () => {
		const gate = createAnswerGate();
		expect(gate.claim("A 档")).toBe("A 档");
		// A double-click, or a face that re-posts on re-render, must not turn one
		// choice into two identical user messages the agent then has to reconcile.
		expect(gate.claim("A 档")).toBeNull();
		expect(gate.claim("B 档")).toBeNull();
		expect(gate.answered).toBe(true);
	});

	it("reports un-answered until the first claim", () => {
		const gate = createAnswerGate();
		expect(gate.answered).toBe(false);
		gate.claim("x");
		expect(gate.answered).toBe(true);
	});

	it("hands out no tokens where there is no document to read them from", () => {
		expect(readFaceTokens()).toEqual({});
	});
});

describe("faces get a ready-made option card and a settled state", () => {
	function srcdoc(): string {
		return renderToStaticMarkup(
			renderBody({
				args: { type: "html" },
				result: widgetResult("html", { html: '<div class="musepi-options">x</div>', data: {} }),
			} as never),
		);
	}

	it("ships the option-card and button classes instead of making faces write them", () => {
		const doc = srcdoc();
		expect(doc).toContain(".musepi-options");
		expect(doc).toContain(".musepi-option");
		// The selected state a face marks by hand. Asserted without the value:
		// React HTML-escapes the srcdoc attribute, so the quotes around "true"
		// reach the static markup as &quot;.
		expect(doc).toContain(".musepi-option[aria-pressed=");
		expect(doc).toContain(".musepi-button");
	});

	it("dims and blocks the face's controls once the answer has landed", () => {
		// Without this a face that ignores the event still accepts a second click,
		// which is the duplicate-message case the gate is there to prevent.
		expect(srcdoc()).toContain("data-musepi-answered");
	});

	it("tells the face it has answered, and exposes the flag it can read", () => {
		const doc = srcdoc();
		expect(doc).toContain("musepi-widget-answered");
		expect(doc).toContain("musepiWidgetAnswered");
	});

	it("refuses to queue a second submit from inside the face", () => {
		expect(srcdoc()).toContain("if (window.musepiWidgetAnswered) return;");
	});
});
