import "./transcript-dom-shim";
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardPanel, BoardWidgetCard } from "../src/components/panels/BoardPanel";
import type { SessionClient } from "../src/lib/client";
import type { BoardWidget } from "../src/widgets/registry";

/** Board panel (guest view): widgets render through the shared registry —
 *  the "desktop calls the board correctly" contract. BoardWidgetCard is a
 *  pure render (no effects) so it tests synchronously; BoardPanel itself
 *  gates on the async board.list (loading/error/empty states). */
describe("BoardPanel (board.list -> shared widget registry)", () => {
	it("renders a known widget type through the registry", () => {
		const widget: BoardWidget = {
			id: "w1",
			type: "metric",
			title: "温度",
			pos: { x: 0, y: 0, w: 172, h: 88 },
			data: { label: "Room", value: 24.5, delta: 0.3 },
		};
		const html = renderToStaticMarkup(
			<BoardWidgetCard widget={widget} update={() => {}} />,
		);
		expect(html).toContain("温度");
		// Renders through the shared registry (metric card body) + the
		// board chrome (widget head/tone).
		expect(html).toContain("gui-widget-metric");
		expect(html).toContain("data-tone");
	});

	it("renders nothing for an unknown widget type (registry fallback, no crash)", () => {
		const widget: BoardWidget = {
			id: "x",
			type: "no-such-widget",
			title: "ghost",
			pos: { x: 0, y: 0, w: 172, h: 88 },
			data: {},
		};
		expect(renderToStaticMarkup(<BoardWidgetCard widget={widget} update={() => {}} />)).toBe("");
	});

	it("shows the loading state before board.list resolves (async gate)", () => {
		// BoardPanel's data comes from client.rpc("board.list") in an effect;
		// renderToStaticMarkup (SSR) never runs effects, so the panel renders
		// its loading gate — the async contract is the loading branch.
		const client = { rpc: async () => ({ boards: [] }) } as unknown as SessionClient;
		const html = renderToStaticMarkup(<BoardPanel client={client} />);
		expect(html).toMatch(/loading/i);
	});
});
