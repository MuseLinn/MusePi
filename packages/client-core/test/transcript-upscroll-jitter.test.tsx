import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { AssistantMessage, SessionEntry } from "@musepi/pi-wire";
import * as reactVirtual from "@tanstack/react-virtual";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Transcript } from "../src/components/transcript/Transcript";

// Upscroll-jitter repro: drives the REAL virtualizer + scroll-anchor state
// machine through a wheel-up sequence over a long expanded advisor card
// into the previous (folded) round. happy-dom has no layout engine, so the
// harness IS the layout: a per-entry height table backs offsetHeight,
// resizeItem() simulates the browser's ResizeObserver batch, and the wheel/
// RO beats are split into separate paints so a one-frame content shift —
// invisible to scrollTop arithmetic — is observable through the content
// anchor identity (which entry + offset sits at the viewport top).

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const VIEWPORT_H = 800;

/** Real layout height per entry index (what a browser would paint). */
let rowHeights: number[] = [];

/** Latest virtualizer total size — backs the scroller's scrollHeight. */
let totalSizeFn: (() => number) | null = null;

/** Per-element scrollTop storage (prototype-backed accessor). */
const scrollTopStore = new WeakMap<HTMLElement, number>();

const proto = HTMLElement.prototype as HTMLElement & Record<string, unknown>;
const descOffsetHeight = Object.getOwnPropertyDescriptor(proto, "offsetHeight");
const descClientHeight = Object.getOwnPropertyDescriptor(proto, "clientHeight");
const origScrollTo = proto.scrollTo;

function isScroller(el: HTMLElement): boolean {
	return el.classList?.contains("tr-root") === true;
}

beforeAll(() => {
	Object.defineProperty(proto, "offsetHeight", {
		configurable: true,
		get(this: HTMLElement) {
			const idx = this.getAttribute("data-index");
			if (idx !== null) return rowHeights[Number(idx)] ?? 0;
			if (isScroller(this)) return VIEWPORT_H;
			return descOffsetHeight?.get?.call(this) ?? 0;
		},
	});
	Object.defineProperty(proto, "clientHeight", {
		configurable: true,
		get(this: HTMLElement) {
			if (isScroller(this)) return VIEWPORT_H;
			return descClientHeight?.get?.call(this) ?? 0;
		},
	});
	Object.defineProperty(proto, "scrollHeight", {
		configurable: true,
		get(this: HTMLElement) {
			if (isScroller(this)) return totalSizeFn?.() ?? 0;
			return 0;
		},
	});
	Object.defineProperty(proto, "scrollTop", {
		configurable: true,
		get(this: HTMLElement) {
			return scrollTopStore.get(this) ?? 0;
		},
		set(this: HTMLElement, v: number) {
			const max = Math.max(0, (totalSizeFn?.() ?? 0) - VIEWPORT_H);
			const next = Math.max(0, Math.min(v, max));
			const changed = next !== scrollTopStore.get(this);
			scrollTopStore.set(this, next);
			// A real browser queues a scroll event on every scrollTop change
			// (including programmatic writes) — tanstack's offset observer and
			// the transcript's own listener both depend on it.
			if (changed) this.dispatchEvent(new Event("scroll"));
		},
	});
	// tanstack's elementScroll writes via scrollTo({top}); a real browser
	// applies the write and queues a scroll event — mirror that here.
	proto.scrollTo = function (this: HTMLElement, opts: unknown) {
		const top = (opts as { top?: number })?.top;
		if (typeof top === "number") {
			this.scrollTop = top;
			this.dispatchEvent(new Event("scroll"));
		}
	};
});

afterAll(() => {
	if (descOffsetHeight) Object.defineProperty(proto, "offsetHeight", descOffsetHeight);
	else delete (proto as Record<string, unknown>).offsetHeight;
	if (descClientHeight) Object.defineProperty(proto, "clientHeight", descClientHeight);
	else delete (proto as Record<string, unknown>).clientHeight;
	delete (proto as Record<string, unknown>).scrollHeight;
	delete (proto as Record<string, unknown>).scrollTop;
	proto.scrollTo = origScrollTo;
	GlobalRegistrator.unregister();
});

function assistantUsage(): AssistantMessage["usage"] {
	return { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } };
}

function userEntry(id: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-07-09T00:00:00Z",
		message: { role: "user", content: `prompt ${id}`, timestamp: 1 },
	};
}

function assistantText(id: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-07-09T00:00:00Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			model: "test/model",
			usage: assistantUsage(),
			stopReason: "stop",
			timestamp: 2,
		},
	};
}

function assistantToolCall(id: string): SessionEntry {
	return {
		type: "message",
		id,
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

/** A long expanded advisor card (custom_message, display:true). */
function advisorEntry(id: string, noteCount: number): SessionEntry {
	return {
		type: "custom_message",
		id,
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

/**
 * Session shape mirroring the bug report:
 *   [10 filler rounds]                           ← initial window lands here
 *   [previous round: user, tool×2, LONG reply]   ← folds (hidden rows ~2px)
 *   [advisor round: user, EXPANDED long card, reply]
 *   [8 filler rounds]                            ← tail
 * Every entry starts at the virtualizer's generic estimate; rows outside the
 * initial mount window are measured only when they mount mid-scroll — the
 * fresh-session condition the jitter report describes.
 */
function buildSession(): { entries: SessionEntry[]; heights: number[] } {
	const entries: SessionEntry[] = [];
	const heights: number[] = [];
	const push = (e: SessionEntry, h: number): void => {
		entries.push(e);
		heights.push(h);
	};
	for (let i = 0; i < 10; i++) {
		push(userEntry(`head-${i}-user`), 124); // turn header + row
		push(assistantText(`head-${i}-reply`, "ok"), 120);
	}
	// Previous round — long reply, folds after completion.
	push(userEntry("prev-user"), 124);
	push(assistantToolCall("pt1"), 2); // folded hidden span
	push(toolResult("pt1"), 2); // folded hidden span
	push(assistantText("prev-reply", "long answer ".repeat(60)), 400);
	// Advisor round — the long expanded card.
	push(userEntry("adv-user"), 124);
	push(advisorEntry("advisor-1", 30), 1500);
	push(assistantText("adv-reply", "ack"), 120);
	for (let i = 0; i < 14; i++) {
		push(userEntry(`tail-${i}-user`), 124);
		push(assistantText(`tail-${i}-reply`, "ok"), 120);
	}
	return { entries, heights };
}

interface AnchorIdentity {
	/** Entry id of the row whose box contains the viewport-top doc position. */
	key: string;
	/** Offset of the doc position inside that row's box, px. */
	offset: number;
}

interface Harness {
	container: HTMLElement;
	root: Root;
	scroller: HTMLElement;
	virtualizer: reactVirtual.Virtualizer<HTMLElement, Element>;
	/** Entry count and stable keys of the mounted session (layout truth). */
	entryCount: number;
	keys: string[];
	scrollTop(): number;
}

const virtualizerRef: { current: reactVirtual.Virtualizer<HTMLElement, Element> | null } = { current: null };

async function mountTranscript(entries: readonly SessionEntry[]): Promise<Harness> {
	virtualizerRef.current = null;
	totalSizeFn = () => virtualizerRef.current?.getTotalSize() ?? 0;
	const originalUseVirtualizer = reactVirtual.useVirtualizer;
	const hookSpy = spyOn(reactVirtual, "useVirtualizer");
	hookSpy.mockImplementation(((options: unknown) => {
		const v = (originalUseVirtualizer as (o: unknown) => reactVirtual.Virtualizer<HTMLElement, Element>)(options);
		virtualizerRef.current = v;
		return v;
	}) as typeof reactVirtual.useVirtualizer);

	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	try {
		await act(async () => {
			root.render(
				createElement(Transcript, {
					entries,
					stream: null,
					streamDone: true,
					activeTools: new Map(),
					working: false,
					sessionKey: "s1",
				}),
			);
		});
	} finally {
		hookSpy.mockRestore();
	}
	const scroller = container.querySelector<HTMLElement>(".tr-root");
	if (!scroller) throw new Error("no scroller");
	if (!virtualizerRef.current) throw new Error("no virtualizer captured");
	return {
		container,
		root,
		scroller,
		virtualizer: virtualizerRef.current,
		entryCount: entries.length,
		keys: entries.map(e => String(e.id)),
		scrollTop: () => scrollTopStore.get(scroller) ?? 0,
	};
}

/** The virtualizer's model size for an entry, rebuilt from PUBLIC state only
 *  (mirrors virtual-core `measure()`: itemSizeCache ?? estimateSize). The
 *  private measurements table is intentionally not touched. */
function modelSize(h: Harness, i: number): number {
	const key = h.virtualizer.options.getItemKey(i);
	return h.virtualizer.itemSizeCache.get(key) ?? h.virtualizer.options.estimateSize(i);
}

/** DOM-truth heights: mounted rows paint their real height, unmounted rows
 *  contribute the model (estimate/measured) size through the spacers. */
function domHeights(h: Harness): number[] {
	const mounted = new Set<number>();
	for (const el of h.container.querySelectorAll<HTMLElement>(".tr-vrow[data-index]")) {
		mounted.add(Number(el.dataset.index));
	}
	return Array.from({ length: h.entryCount }, (_, i) =>
		mounted.has(i) ? (rowHeights[i] ?? modelSize(h, i)) : modelSize(h, i),
	);
}

/** Content identity at a doc position under the CURRENT DOM truth: which
 *  entry box contains it and at what offset. */
function identityAt(h: Harness, docPos: number): AnchorIdentity | null {
	const heights = domHeights(h);
	let acc = 0;
	for (let i = 0; i < heights.length; i++) {
		const end = acc + heights[i];
		if (docPos < end) return { key: h.keys[i], offset: docPos - acc };
		acc = end;
	}
	return null;
}

/** Frame N+1: the browser's ResizeObserver batch — re-measure mounted rows. */
async function roBatch(h: Harness): Promise<void> {
	await act(async () => {
		for (const el of Array.from(h.container.querySelectorAll<HTMLElement>(".tr-vrow[data-index]"))) {
			const i = Number(el.dataset.index);
			const height = rowHeights[i];
			if (height !== undefined) h.virtualizer.resizeItem(i, height);
		}
	});
}

/** DOM-truth doc position of (key, offset) under a height table. */
function posUnder(heights: number[], keys: string[], key: string, offset: number): number | null {
	const i = keys.indexOf(key);
	if (i < 0) return null;
	let acc = 0;
	for (let j = 0; j < i; j++) acc += heights[j];
	return acc + offset;
}

interface StepResult {
	/** Signed content drift at the mount paint, px: how far the viewport top
	 *  deviates from the content the wheel should have landed on. */
	mountPaintDrift: number;
	/** Signed content drift after the RO/compensation paint. */
	roPaintDrift: number;
}

/**
 * One wheel notch as TWO paints, like a real browser:
 *  - paint 1: wheel → scroll event → React commit (window shift, new rows
 *    mount) → paint. Any estimate→actual delta the mount applies to the
 *    document is VISIBLE now if the first measure was deferred.
 *  - paint 2: ResizeObserver delivers → measure compensation → paint.
 */
async function wheelStep(h: Harness, deltaY: number): Promise<StepResult> {
	const before = h.scrollTop();
	const expected = identityAt(h, before + deltaY);
	await act(async () => {
		h.scroller.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true }));
		h.scroller.scrollTop = before + deltaY;
		h.scroller.dispatchEvent(new Event("scroll"));
	});
	const mountPaintDrift = signedDrift(h, expected);
	await roBatch(h);
	const roPaintDrift = signedDrift(h, expected);
	return { mountPaintDrift, roPaintDrift };
}

/** Where the expected content sits NOW vs where the viewport top is. */
function signedDrift(h: Harness, expected: AnchorIdentity | null): number {
	if (expected === null) return 0;
	const now = posUnder(domHeights(h), h.keys, expected.key, expected.offset);
	if (now === null) return Number.POSITIVE_INFINITY;
	return h.scrollTop() - now;
}

async function driveUp(h: Harness, notches: number): Promise<StepResult[]> {
	const results: StepResult[] = [];
	for (let i = 0; i < notches; i++) {
		if (h.scrollTop() === 0) break;
		if (h.scrollTop() - 120 < 0) break;
		results.push(await wheelStep(h, -120));
	}
	return results;
}

describe("upscroll over a long expanded advisor card", () => {
	it("keeps the content anchor identical across every mount paint (no one-frame shift)", async () => {
		// Contract: while the user wheels up, the entry under the viewport top
		// advances by exactly the wheel delta at EVERY paint. A regression that
		// defers the first row measurement out of the mount commit (stock ref
		// gate skips measureElement while isScrolling; ResizeObserver delivers
		// a frame later) paints the estimate→actual document shift for one
		// frame and snaps it back on the RO frame — the 跨轮边界 jump over a
		// long advisor card. mountPaintDrift below is exactly that shift.
		const { entries, heights } = buildSession();
		rowHeights = heights;
		const h = await mountTranscript(entries);
		// Leave the open-grace window so scroll adjudication is fully live.
		await act(async () => {
			await new Promise(r => setTimeout(r, 1300));
		});
		// Settle beat (not recorded): one full wheel step so stale initial-window
		// measurements flush out before the recorded beats begin.
		await wheelStep(h, -120);

		const results = await driveUp(h, 60);
		await act(async () => h.root.unmount());

		const worstMount = Math.max(...results.map(r => Math.abs(r.mountPaintDrift)));
		const worstRo = Math.max(...results.map(r => Math.abs(r.roPaintDrift)));
		// The mount paint must show exactly the wheel delta — a non-zero drift
		// here is the user's visible jump (one wrong frame per correction).
		expect(worstMount).toBeLessThanOrEqual(1);
		// Sanity on the harness itself: the RO/compensation frame must fully
		// restore the anchor, or the assertion above is vacuous.
		expect(worstRo).toBeLessThanOrEqual(1);
	}, 20000);
});
