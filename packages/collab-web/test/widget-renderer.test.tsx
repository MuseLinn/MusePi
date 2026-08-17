/**
 * Inline widget renderer tests: unknown-type fallback, data passthrough,
 * defaults rendering, and error-boundary degradation on malformed data.
 */
import { describe, expect, it } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WidgetErrorBoundary } from "../src/widgets/error-boundary";
import type { ToolRenderProps } from "../src/tool-render/types";
import { widgetRenderer } from "../src/tool-render/tools/widget";

// widgetRenderer always ships both renderers; the shared ToolRenderer type
// marks Body optional (other renderers may omit it) and ComponentType is a
// class|function union TS refuses to invoke directly — alias to a plain
// function shape for direct calls in these SSR tests.
const renderBody = widgetRenderer.Body as (props: ToolRenderProps) => ReactNode;

describe("inline widget renderer", () => {
	it("renders a calc widget with merged data", () => {
		const html = renderToStaticMarkup(
			renderBody({
				args: { type: "calc", data: { amount: 2000 } },
				result: { type: "calc", data: { mode: "post", amount: 2000 } },
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
				result: { type: "nope" },
			} as never),
		);
		expect(html).not.toContain("tv-widget");
		expect(html).toContain("widget unknown");
	});

	it("uses the type's i18n name as the default title", () => {
		const html = renderToStaticMarkup(
			renderBody({
				args: { type: "pomodoro" },
				result: { type: "pomodoro", data: {} },
			} as never),
		);
		expect(html).toContain("tv-widget-title");
	});

	it("passes data through to the shared component untouched", () => {
		const html = renderToStaticMarkup(
			renderBody({
				args: { type: "ticker", data: { label: "USD / CNY", value: "6.7634" } },
				result: { type: "ticker", data: { label: "USD / CNY", value: "6.7634" } },
			} as never),
		);
		expect(html).toContain("USD / CNY");
		expect(html).toContain("6.7634");
	});

	it("flags widget failures via the error boundary (client-side catch)", () => {
		// SSR cannot exercise componentDidCatch, but the boundary's static
		// transition is the contract the client relies on: any widget
		// render error degrades to the note, never crashing the transcript.
		const state = WidgetErrorBoundary.getDerivedStateFromError(new Error("boom"));
		expect(state.failed).toBe(true);
	});
});
