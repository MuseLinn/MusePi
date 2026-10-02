import "./happy-dom-shim"; // MUST be first: component module graphs define HTMLElement subclasses at evaluation time.
import { afterAll, describe, expect, test } from "bun:test";
import { setLocale, type TurnIndexItem } from "@musepi/client-core";
import { act, createElement, createRef } from "react";
import { createRoot } from "react-dom/client";
import { TurnRail, type TurnRailDataSource } from "../src/components/TurnRail";

/**
 * Rail load-more control (openchamber PromptNavigatorRail parity).
 *
 * The rail already paged older history in on a top-edge hover, but that
 * gesture has no visual affordance at all — nothing on screen says older turns
 * exist, and the only other paging signal is the transcript's aria-hidden
 * loading bar at the far end of the scroll. This control is the clickable,
 * discoverable form of the same call, so the contracts a reader depends on are:
 *
 *   - it appears exactly when the daemon reports older history, labelled;
 *   - it refuses a second page while one is in flight;
 *   - the rail's OWN "more ticks above the window" (carousel paging) never
 *     raises it — reading that flag instead conjures a pager that loads nothing.
 *
 * Rendered through a real root because TurnRail derives its ticks in an
 * effect (data-driven ticks arrive via setTurns), so static markup renders
 * nothing and would pass vacuously.
 */

setLocale("zh-CN");
afterAll(() => {
	setLocale("en-US");
});

const turn = (i: number): TurnIndexItem => ({
	startIdx: i * 2,
	entryId: `e${i}`,
	timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
	summary: `turn ${i}`,
	kind: "user",
});

/** `turnCount` rather than `turns`: the data source's own field is the built
 *  array, so a same-named option would intersect to `array & number`. */
function dataSource(over: Partial<TurnRailDataSource> & { turnCount?: number } = {}): TurnRailDataSource {
	const { turnCount = 3, ...rest } = over;
	return {
		turns: Array.from({ length: turnCount }, (_, i) => turn(i)),
		hasMoreAbove: false,
		loadingOlder: false,
		...rest,
	};
}

async function render(turnsData: TurnRailDataSource): Promise<HTMLElement> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			createElement(TurnRail, {
				rootRef: createRef<HTMLDivElement>(),
				entryCount: 0,
				turnsData,
			}),
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
	return host;
}

describe("TurnRail load-more control", () => {
	test("appears with an accessible label when the daemon has older history", async () => {
		const host = await render(dataSource({ hasMoreAbove: true }));
		const button = host.querySelector<HTMLButtonElement>(".gui-turn-loadmore");
		expect(button).not.toBeNull();
		// Not just an icon: reachable by keyboard and announced, not hover-only.
		expect(button!.getAttribute("aria-label")).toBe("加载更多提示");
		expect(button!.getAttribute("title")).toBe("加载更多提示");
		// And the ticks are still there — the control is an addition, not a
		// replacement for the rail's own navigation.
		expect(host.querySelectorAll(".gui-turn-tick").length).toBe(3);
	});

	test("is absent when there is nothing older to load", async () => {
		// A permanently visible pager would be a dead control the user learns to
		// distrust; only the daemon's verdict may raise it.
		const host = await render(dataSource({ hasMoreAbove: false }));
		expect(host.querySelector(".gui-turn-loadmore")).toBeNull();
		expect(host.querySelector(".gui-turn-track")).not.toBeNull();
	});

	test("refuses a second page while one is in flight", async () => {
		const host = await render(dataSource({ hasMoreAbove: true, loadingOlder: true }));
		const button = host.querySelector<HTMLButtonElement>(".gui-turn-loadmore");
		expect(button).not.toBeNull();
		expect(button!.disabled).toBe(true);
	});

	test("a click pages older history, and the pending state stops a repeat", async () => {
		let calls = 0;
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		const props = {
			rootRef: createRef<HTMLDivElement>(),
			entryCount: 0,
			turnsData: dataSource({
				hasMoreAbove: true,
				onRequestOlder: () => {
					calls += 1;
				},
			}),
		};
		await act(async () => {
			root.render(createElement(TurnRail, props));
		});
		await act(async () => {
			await Promise.resolve();
		});
		const button = host.querySelector<HTMLButtonElement>(".gui-turn-loadmore")!;
		await act(async () => {
			button.click();
		});
		expect(calls).toBe(1);
		// Re-render as the caller would mid-flight: the control must go dead so
		// a second page cannot be issued against the same cursor.
		await act(async () => {
			root.render(
				createElement(TurnRail, {
					...props,
					turnsData: dataSource({
						hasMoreAbove: true,
						loadingOlder: true,
						onRequestOlder: () => {
							calls += 1;
						},
					}),
				}),
			);
		});
		const busy = host.querySelector<HTMLButtonElement>(".gui-turn-loadmore")!;
		expect(busy.disabled).toBe(true);
		await act(async () => {
			busy.click();
		});
		expect(calls).toBe(1);
	});

	test("is not raised by a long tick window alone", async () => {
		// 40 turns exceeds MAX_VISIBLE_TICKS, so the rail's own "more ticks
		// above" (carousel paging within the tick window) is a DIFFERENT
		// condition from the daemon's paging state.
		const host = await render(dataSource({ turnCount: 40, hasMoreAbove: false }));
		expect(host.querySelector(".gui-turn-track")).not.toBeNull();
		expect(host.querySelector(".gui-turn-loadmore")).toBeNull();
	});

	test("is absent when the rail itself is empty", async () => {
		// No ticks means no rail at all — the control must not become the only
		// thing rendered for a session with no loaded turns.
		const host = await render(dataSource({ turnCount: 0, hasMoreAbove: true }));
		expect(host.querySelector(".gui-turn-loadmore")).toBeNull();
	});
});
