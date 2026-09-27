import { afterAll, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { AssistantMessage, SessionEntry } from "@musepi/pi-wire";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Transcript } from "../src/components/transcript/Transcript";

// The assertions below are INTERACTION-driven (wheel release, card toggle,
// virtualized remount), which bun:test's default environment cannot do —
// register happy-dom globally for this file, as the other effect-driven
// suites do.
GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
	GlobalRegistrator.unregister();
});

function assistantUsage(): AssistantMessage["usage"] {
	return { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } };
}

function userEntry(timestamp: number, id = `user-${timestamp}`): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-07-09T00:00:00Z",
		message: { role: "user", content: "do it", timestamp },
	};
}

function assistantText(timestamp: number, text = "done"): SessionEntry {
	return {
		type: "message",
		id: `assistant-${timestamp}`,
		parentId: null,
		timestamp: "2026-07-09T00:00:00Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			model: "test/model",
			usage: assistantUsage(),
			stopReason: "stop",
			timestamp,
		},
	};
}

function assistantToolCall(id: string): SessionEntry {
	return {
		type: "message",
		id: `assistant-tool-${id}`,
		parentId: null,
		timestamp: "2026-07-09T00:00:00Z",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id, name: "read", arguments: {} }],
			model: "test/model",
			usage: assistantUsage(),
			stopReason: "stop",
			timestamp: 3,
		},
	};
}

function toolResult(toolCallId: string): SessionEntry {
	return {
		type: "message",
		id: `result-${toolCallId}`,
		parentId: null,
		timestamp: "2026-07-09T00:00:00Z",
		message: {
			role: "toolResult",
			toolCallId,
			toolName: "read",
			content: [{ type: "text", text: "file contents" }],
			isError: false,
			timestamp: 4,
		},
	};
}

/** One completed round: user → tool work → reply (derives a round fold). */
function toolRound(): SessionEntry[] {
	return [userEntry(1), assistantToolCall("c1"), toolResult("c1"), assistantText(5)];
}

/** A persisted advisor card with more than 3 notes (collapsed shows 3). */
function advisorEntry(noteCount: number): SessionEntry {
	return {
		type: "custom_message",
		id: "advisor-1",
		parentId: null,
		timestamp: "2026-07-09T00:00:01Z",
		customType: "advisor",
		content: "x",
		display: true,
		details: {
			notes: Array.from({ length: noteCount }, (_, i) => ({ note: `note ${i + 1}`, severity: "nit" })),
		},
	};
}

function transcriptEl(entries: readonly SessionEntry[]): ReactNode {
	return createElement(Transcript, {
		entries,
		stream: null,
		streamDone: true,
		activeTools: new Map(),
		working: false,
	});
}

interface Mounted {
	container: HTMLElement;
	root: Root;
}

async function mount(element: ReactNode): Promise<Mounted> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	// Act flushes effects AND the state updates those effects schedule, so
	// assertions observe the settled render rather than the first paint.
	await act(async () => {
		root.render(element);
	});
	return { container, root };
}

/** The transcript's scroller in these tests is its own .tr-root (no outer
 *  .gui-transcript). happy-dom reports zero sizes, so pin the geometry the
 *  scroll-anchor state machine reads. */
function defineScrollerGeometry(
	scroller: HTMLElement,
	geometry: { scrollTop: number; clientHeight: number; scrollHeight: number },
): void {
	Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: geometry.scrollTop });
	Object.defineProperty(scroller, "clientHeight", { configurable: true, value: geometry.clientHeight });
	Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: geometry.scrollHeight });
}

function wheelUp(scroller: HTMLElement): void {
	scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
}

function fireScroll(scroller: HTMLElement): void {
	scroller.dispatchEvent(new Event("scroll"));
}

describe("back-to-bottom affordance geometry (fold-collapse lingering button)", () => {
	it("stays hidden when a wheel-up releases intent over a pane that cannot scroll", async () => {
		// Contract: the button needs BOTH the released intent AND live
		// geometry. A wheel-up over a pane whose content fits releases
		// `following` synchronously, and no scroll event ever re-adjudicates
		// it — intent alone used to render the button over a static pane
		// (user: 折叠消息后内容已不超出视口,按钮却仍显示). A regression to
		// intent-only visibility renders .tr-back-bottom here and fails.
		const { container, root } = await mount(transcriptEl([userEntry(1), assistantText(2)]));
		const scroller = container.querySelector<HTMLElement>(".tr-root");
		expect(scroller).not.toBeNull();
		// happy-dom sizes are 0/0: the pane cannot scroll away from bottom.
		await act(async () => {
			wheelUp(scroller!);
		});
		expect(container.querySelector(".tr-back-bottom")).toBeNull();
		await act(async () => root.unmount());
	});

	it("shows while genuinely scrolled away, and hides again once content no longer overflows", async () => {
		const { container, root } = await mount(transcriptEl([userEntry(1), assistantText(2)]));
		const scroller = container.querySelector<HTMLElement>(".tr-root")!;
		defineScrollerGeometry(scroller, { scrollTop: 400, clientHeight: 800, scrollHeight: 2000 });

		await act(async () => {
			wheelUp(scroller);
		});
		await act(async () => {
			fireScroll(scroller);
		});
		expect(container.querySelector(".tr-back-bottom")).not.toBeNull();

		// A fold collapse shrinks the content below the viewport: the pane
		// can no longer scroll away, so the affordance must drop — even
		// though no user gesture re-armed the following intent yet.
		defineScrollerGeometry(scroller, { scrollTop: 0, clientHeight: 800, scrollHeight: 700 });
		await act(async () => {
			fireScroll(scroller);
		});
		expect(container.querySelector(".tr-back-bottom")).toBeNull();
		await act(async () => root.unmount());
	});
});

describe("advisor-card manual expansion survives row remounts", () => {
	it("keeps the entryId-keyed expansion when the row unmounts and remounts", async () => {
		// Contract: transcript rows are virtualized — scrolling a card out of
		// the overscan window unmounts it. The manual expansion must live at
		// the transcript level keyed by the ENTRY ID; component-local useState
		// reset it on remount (user: 手动展开顾问卡,滚动离开再回来被折叠).
		const entries = [userEntry(1), advisorEntry(5), assistantText(9)];
		const { container, root } = await mount(transcriptEl(entries));

		const head = (): HTMLElement | null => container.querySelector<HTMLElement>(".tr-advisor-head");
		expect(head()?.getAttribute("aria-expanded")).toBe("false");
		expect(container.querySelectorAll(".tr-advisor-note").length).toBe(3);

		await act(async () => {
			head()?.click();
		});
		expect(head()?.getAttribute("aria-expanded")).toBe("true");
		expect(container.querySelectorAll(".tr-advisor-note").length).toBe(5);

		// Simulate the virtualizer dropping the row (scrolled out) and
		// mounting it again: remove the entry, then restore the list.
		await act(async () => {
			root.render(transcriptEl([userEntry(1), assistantText(9)]));
		});
		expect(container.querySelector(".tr-advisor")).toBeNull();
		await act(async () => {
			root.render(transcriptEl(entries));
		});

		// The remounted card must still be expanded — all 5 notes visible.
		expect(head()?.getAttribute("aria-expanded")).toBe("true");
		expect(container.querySelectorAll(".tr-advisor-note").length).toBe(5);
		await act(async () => root.unmount());
	});
});

describe("round-fold manual expansion is not overwritten by re-derivation", () => {
	it("stays open across a history prepend that shifts every row index", async () => {
		// Contract: the fold's open state is a user deviation keyed by the
		// round's user-message ENTRY ID. Re-deriving turns (a history
		// page-in prepends entries and shifts all indexes) must not re-apply
		// the auto-collapse over the user's manual expansion — index-keyed
		// state silently dropped it.
		const round = toolRound();
		const { container, root } = await mount(transcriptEl(round));

		const foldHead = (): HTMLElement | null => container.querySelector<HTMLElement>(".tr-round-fold");
		expect(foldHead()).not.toBeNull();
		expect(foldHead()?.classList.contains("tr-round-fold--open")).toBe(false);

		await act(async () => {
			foldHead()?.click();
		});
		expect(foldHead()?.classList.contains("tr-round-fold--open")).toBe(true);

		// History page-in: an older user message prepends; every absolute
		// index shifts by one.
		const older = userEntry(0, "user-older-page");
		await act(async () => {
			root.render(transcriptEl([older, ...round]));
		});

		expect(foldHead()?.classList.contains("tr-round-fold--open")).toBe(true);
		// The expanded fold renders its hidden-span rows again.
		expect(container.querySelector(".tr-fold-slot--open")).not.toBeNull();
		await act(async () => root.unmount());
	});
});
