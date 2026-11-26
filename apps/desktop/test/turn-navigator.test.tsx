import "./happy-dom-shim"; // MUST be first: component module graphs define HTMLElement subclasses at evaluation time.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { setLocale, type TurnIndexItem } from "@musepi/client-core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TurnNavigator, type TurnNavigatorDataSource } from "../src/components/TurnNavigator";

/**
 * Turn navigator contracts: one fixed-pitch mark per turn inside a scrollable
 * frame, hover/focus previews the prompt, click navigates, and the active mark
 * follows reading (near the bottom the latest turn is active; otherwise the
 * last turn above the reading line). The load-more control pages history and
 * is the only condition the daemon may raise.
 */

setLocale("zh-CN");
afterAll(() => {
	setLocale("en-US");
});

const roots = new Set<Root>();
afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots.clear();
	document.body.innerHTML = "";
});

const turn = (i: number): TurnIndexItem => ({
	startIdx: i * 2,
	entryId: `e${i}`,
	timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
	summary: `turn ${i}`,
	kind: "user",
});

function dataSource(over: Partial<TurnNavigatorDataSource> & { turnCount?: number } = {}): TurnNavigatorDataSource {
	const { turnCount = 3, ...rest } = over;
	return {
		turns: Array.from({ length: turnCount }, (_, i) => turn(i)),
		hasMoreAbove: false,
		loadingOlder: false,
		...rest,
	};
}

/** A stand-in transcript scroller: the active rule reads these three metrics. */
function scroller(metrics: { scrollHeight?: number; clientHeight?: number; scrollTop?: number } = {}): HTMLDivElement {
	const root = document.createElement("div");
	Object.defineProperty(root, "scrollHeight", { configurable: true, value: metrics.scrollHeight ?? 1000 });
	Object.defineProperty(root, "clientHeight", { configurable: true, value: metrics.clientHeight ?? 500 });
	Object.defineProperty(root, "scrollTop", {
		configurable: true,
		writable: true,
		value: metrics.scrollTop ?? 0,
	});
	root.getBoundingClientRect = () =>
		({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
	root.querySelectorAll = (() => []) as never;
	return root;
}

async function render(props: Parameters<typeof TurnNavigator>[0]): Promise<HTMLElement> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.add(root);
	await act(async () => {
		root.render(createElement(TurnNavigator, props));
	});
	await act(async () => {
		await Promise.resolve();
	});
	return host;
}

const pointer = (type: string, init: MouseEventInit = {}): MouseEvent =>
	new MouseEvent(type, { bubbles: true, cancelable: true, ...init });

describe("TurnNavigator load-more control", () => {
	test("appears with an accessible label when the daemon has older history", async () => {
		const host = await render({ rootRef: { current: null }, turnsData: dataSource({ hasMoreAbove: true }) });
		const button = host.querySelector<HTMLButtonElement>(".gui-turn-loadmore");
		expect(button !== null).toBe(true);
		expect(button!.getAttribute("aria-label")).toBe("加载更多提示");
		expect(button!.getAttribute("title")).toBe("加载更多提示");
		expect(host.querySelectorAll(".gui-turn-mark").length).toBe(3);
	});

	test("is absent when there is nothing older to load", async () => {
		const host = await render({ rootRef: { current: null }, turnsData: dataSource({ hasMoreAbove: false }) });
		expect(host.querySelector(".gui-turn-loadmore") === null).toBe(true);
		expect(host.querySelector(".gui-turn-frame") !== null).toBe(true);
	});

	test("refuses a second page while one is in flight", async () => {
		const host = await render({
			rootRef: { current: null },
			turnsData: dataSource({ hasMoreAbove: true, loadingOlder: true }),
		});
		expect(host.querySelector<HTMLButtonElement>(".gui-turn-loadmore")!.disabled).toBe(true);
	});

	test("a click pages older history", async () => {
		let calls = 0;
		const host = await render({
			rootRef: { current: null },
			turnsData: dataSource({
				hasMoreAbove: true,
				onRequestOlder: () => {
					calls += 1;
				},
			}),
		});
		await act(async () => host.querySelector<HTMLButtonElement>(".gui-turn-loadmore")!.click());
		expect(calls).toBe(1);
	});

	test("is absent when the navigator itself is empty", async () => {
		const host = await render({
			rootRef: { current: null },
			turnsData: dataSource({ turnCount: 0, hasMoreAbove: true }),
		});
		expect(host.querySelector(".gui-turn-loadmore") === null).toBe(true);
		expect(host.querySelector(".gui-turn-nav") === null).toBe(true);
	});
});

describe("TurnNavigator marks and preview", () => {
	test("renders one mark per turn and jumps by entry id", async () => {
		const jumps: string[] = [];
		const host = await render({
			rootRef: { current: scroller() },
			turnsData: dataSource({ turnCount: 4 }),
			onJumpToTurn: entryId => jumps.push(entryId),
		});
		const marks = host.querySelectorAll<HTMLElement>(".gui-turn-mark");
		expect(marks.length).toBe(4);
		await act(async () => marks[1]!.click());
		expect(jumps).toEqual(["e1"]);
	});

	test("hover previews the prompt and leaving the rail clears it", async () => {
		const host = await render({ rootRef: { current: scroller() }, turnsData: dataSource({ turnCount: 4 }) });
		const mark = host.querySelectorAll<HTMLElement>(".gui-turn-mark")[2]!;
		await act(async () => mark.dispatchEvent(pointer("pointerover")));
		await act(async () => {
			await Promise.resolve();
		});
		expect(host.querySelector(".gui-turn-preview")?.textContent).toContain("turn 2");

		const rail = host.querySelector<HTMLElement>(".gui-turn-nav")!;
		await act(async () => rail.dispatchEvent(pointer("pointerout", { relatedTarget: document.body })));
		await act(async () => {
			await Promise.resolve();
		});
		expect(host.querySelector(".gui-turn-preview") === null).toBe(true);
	});

	test("the previewed mark is the active descendant, and Enter jumps", async () => {
		const jumps: string[] = [];
		const host = await render({
			rootRef: { current: scroller() },
			turnsData: dataSource({ turnCount: 3 }),
			onJumpToTurn: entryId => jumps.push(entryId),
		});
		const frame = host.querySelector<HTMLElement>(".gui-turn-frame")!;
		await act(async () => frame.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
		expect(frame.getAttribute("aria-activedescendant")).toBe("gui-turn-mark-1");
		await act(async () => frame.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
		expect(jumps).toEqual(["e1"]);
	});

	test("canvas mode hands the node to the caller instead of jumping the transcript", async () => {
		const selected: string[] = [];
		const host = await render({
			rootRef: { current: null },
			nodeTurns: [
				{ id: "n0", summary: "one" },
				{ id: "n1", summary: "two" },
			],
			activeTurnIndex: 1,
			onSelectNode: id => selected.push(id),
		});
		const marks = host.querySelectorAll<HTMLElement>(".gui-turn-mark");
		expect(marks[1]!.getAttribute("aria-current")).toBe("true");
		await act(async () => marks[0]!.click());
		expect(selected).toEqual(["n0"]);
	});
});

describe("TurnNavigator active turn", () => {
	test("near the bottom the latest turn is active, even when its row is below the reading line", async () => {
		// remaining = 1000 - 500 - 500 = 0 <= 32 → follow the tail.
		const host = await render({
			rootRef: { current: scroller({ scrollTop: 500 }) },
			turnsData: dataSource({ turnCount: 3 }),
		});
		const marks = host.querySelectorAll<HTMLElement>(".gui-turn-mark");
		expect(marks[2]!.getAttribute("aria-current")).toBe("true");
		expect(marks[0]!.getAttribute("aria-current")).toBeNull();
	});

	test("away from the bottom the first turn is the default when no row is above the reading line", async () => {
		const host = await render({
			rootRef: { current: scroller({ scrollTop: 0 }) },
			turnsData: dataSource({ turnCount: 3 }),
		});
		const marks = host.querySelectorAll<HTMLElement>(".gui-turn-mark");
		expect(marks[0]!.getAttribute("aria-current")).toBe("true");
	});
});

describe("TurnNavigator geometry", () => {
	test("the rail clears the native scrollbar by its layout width", () => {
		const css = readFileSync(path.resolve(import.meta.dir, "../src/styles/gui-workspace.css"), "utf8");
		expect(css).toContain("right: calc(4px + var(--mp-scrollbar-width");
	});
});
