import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeScrollEdgeState, SCROLL_EDGE_THRESHOLD } from "@musepi/client-ui-primitives/client";
import type { SessionEntry } from "@musepi/pi-wire";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChatView, TRANSCRIPT_HEAD_INSET } from "../src/components/ChatView";
import type { RpcClient } from "../src/lib/rpc";
import { GuiSessionStore } from "../src/lib/session-store";

/**
 * Top feather contract for the transcript.
 *
 * The transcript reserves 52px above its first row for the floating chat head.
 * Until the content has scrolled that far, the feather would cover only the
 * empty reserved strip — a bright band along the container's top edge, which
 * the user reported as "the list has a highlight on the container's top edge
 * when it is at the top". The top feather therefore appears only once rows are
 * really sliding under the head; the bottom edge, the jump-to-bottom button
 * and TurnNavigator keep their plain edge semantics.
 *
 * happy-dom has no layout engine, so the geometry is driven through the same
 * data attributes the scroller writes: scrollHeight/clientHeight are defined
 * on the element, scroll events are dispatched, and the attribute is read back.
 */

const V = { clientHeight: 400, scrollHeight: 2000 };
const H = { clientWidth: 400, scrollWidth: 400 };

function entry(id: string, parentId: string | null, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(1_700_000_000_000 + Number(id.slice(-1)) * 1000).toISOString(),
		message: { role: "user", content: [{ type: "text", text }] },
	} as unknown as SessionEntry;
}

const rpc = {
	request: async (method: string) => {
		if (method.startsWith("models.list")) return [];
		if (method === "git.branches") return { error: "not a repository" };
		if (method === "session.turns") return { turns: [] };
		return {};
	},
	addEventListener: () => () => {},
} as unknown as RpcClient;

const roots = new Set<Root>();
const stores = new Set<GuiSessionStore>();

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	for (const store of stores) store.dispose();
	roots.clear();
	stores.clear();
	document.body.innerHTML = "";
	document.head.querySelectorAll("style[data-test-css]").forEach(node => node.remove());
});

describe("computeScrollEdgeState top inset", () => {
	it("default callers keep the plain edge threshold", () => {
		expect(computeScrollEdgeState({ scrollTop: 0, scrollLeft: 0, ...V, ...H }).top).toBe(false);
		expect(computeScrollEdgeState({ scrollTop: SCROLL_EDGE_THRESHOLD, scrollLeft: 0, ...V, ...H }).top).toBe(false);
		expect(computeScrollEdgeState({ scrollTop: SCROLL_EDGE_THRESHOLD + 1, scrollLeft: 0, ...V, ...H }).top).toBe(
			true,
		);
	});

	it("a reserved head band keeps the top edge calm until content slides under it", () => {
		const at = (scrollTop: number) =>
			computeScrollEdgeState({ scrollTop, scrollLeft: 0, ...V, ...H }, { topInset: TRANSCRIPT_HEAD_INSET });
		// At the very top, and anywhere inside the reserved 52px band, the
		// feather would paint empty surface: no top edge.
		expect(at(0).top).toBe(false);
		expect(at(TRANSCRIPT_HEAD_INSET).top).toBe(false);
		expect(at(SCROLL_EDGE_THRESHOLD + TRANSCRIPT_HEAD_INSET).top).toBe(false);
		// One pixel past the band: the first row has reached the top edge.
		expect(at(SCROLL_EDGE_THRESHOLD + TRANSCRIPT_HEAD_INSET + 1).top).toBe(true);
	});

	it("only the top edge moves — bottom/left/right keep their plain semantics", () => {
		const options = { topInset: TRANSCRIPT_HEAD_INSET };
		const insideBand = computeScrollEdgeState({ scrollTop: 20, scrollLeft: 0, ...V, ...H }, options);
		expect(insideBand).toEqual({ top: false, bottom: true, left: false, right: false });
		// Pinned to the bottom: the top feather is legitimate (rows are under
		// the head) and the bottom edge hides exactly as before.
		const atBottom = computeScrollEdgeState({ scrollTop: 1600, scrollLeft: 0, ...V, ...H }, options);
		expect(atBottom).toEqual({ top: true, bottom: false, left: false, right: false });
	});
});

describe("transcript top band CSS", () => {
	it("hides the band at rest, reveals it only for the scrolled scroller, and reserves the hook's inset", () => {
		const sheet = document.createElement("style");
		sheet.setAttribute("data-test-css", "true");
		sheet.textContent = readFileSync(resolve(import.meta.dir, "../src/styles/gui-chat.css"), "utf8");
		document.head.appendChild(sheet);
		document.body.innerHTML = `
			<div class="gui-chat-column">
				<div class="gui-transcript" id="transcript"></div>
				<div class="gui-chat-fade gui-chat-fade--top" id="band"></div>
			</div>`;
		const transcript = document.getElementById("transcript")!;

		// The stylesheet's own contract: the base band is hidden with the ramp
		// anchored at the top edge, and the ONLY rule that paints it keys on
		// the scroller's scrolled-away-from-top attribute.
		type Rule = { selectorText?: string; style?: { display?: string; maskImage?: string } };
		const rules = [...((sheet.sheet?.cssRules ?? []) as unknown as Rule[])];
		const base = rules.find(rule => rule.selectorText === ".gui-chat-fade--top");
		expect(base?.style?.display).toBe("none");
		expect(base?.style?.maskImage).toContain("to bottom");
		const reveals = rules.filter(
			rule => rule.style?.display === "block" && (rule.selectorText ?? "").includes("gui-chat-fade--top"),
		);
		expect(reveals.map(rule => rule.selectorText)).toEqual([
			'.gui-transcript[data-top-scroll="true"] ~ .gui-chat-fade--top',
		]);

		const bandSelector = '.gui-transcript[data-top-scroll="true"] ~ .gui-chat-fade--top';
		transcript.setAttribute("data-top-scroll", "false");
		expect(document.querySelector(bandSelector)).toBeNull();
		transcript.setAttribute("data-top-scroll", "true");
		expect(document.querySelector(bandSelector)).toBe(document.getElementById("band"));

		// The JS gate (TRANSCRIPT_HEAD_INSET) and the CSS reserve are one
		// number; drift would reintroduce the empty-strip highlight.
		expect(getComputedStyle(transcript).paddingTop).toBe(`${TRANSCRIPT_HEAD_INSET}px`);
	});
});

describe("ChatView wires the inset into the transcript scroller", () => {
	it("does not show the top feather until rows pass the reserved head band", async () => {
		const store = new GuiSessionStore(
			"top-fade",
			{ entries: [entry("e1", null, "first"), entry("e2", "e1", "second")], cursor: 0 },
			"C:/workspace",
		);
		stores.add(store);
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		roots.add(root);
		await act(async () =>
			root.render(
				<ChatView
					store={store}
					rpc={rpc}
					onSend={() => {}}
					onStop={() => {}}
					onDecideApproval={() => {}}
					busy={false}
					project="C:/workspace"
					onProject={() => {}}
					onSubmitNewSession={() => {}}
					rightPanelOpen={false}
					terminalOpen={false}
					focusMode={false}
					onToggleFocus={() => {}}
				/>,
			),
		);
		// useScrollShadow attaches on a 200ms poll when the element appears
		// after mount (conditional render).
		await act(async () => Bun.sleep(350));

		const transcript = host.querySelector<HTMLElement>(".gui-transcript");
		expect(transcript).not.toBeNull();
		const el = transcript!;
		Object.defineProperty(el, "clientHeight", { configurable: true, value: V.clientHeight });
		Object.defineProperty(el, "scrollHeight", { configurable: true, value: V.scrollHeight });
		Object.defineProperty(el, "clientWidth", { configurable: true, value: H.clientWidth });
		Object.defineProperty(el, "scrollWidth", { configurable: true, value: H.scrollWidth });

		const scrollTo = async (top: number) => {
			el.scrollTop = top;
			await act(async () => el.dispatchEvent(new Event("scroll")));
		};

		await scrollTo(0);
		expect(el.dataset.topScroll).toBe("false");
		// Regression: a few pixels of scroll used to light the 56px band over
		// the empty head strip; the user read that as a top-edge highlight.
		await scrollTo(SCROLL_EDGE_THRESHOLD + 1);
		expect(el.dataset.topScroll).toBe("false");
		await scrollTo(TRANSCRIPT_HEAD_INSET);
		expect(el.dataset.topScroll).toBe("false");
		// The bottom edge is untouched by the inset.
		expect(el.dataset.bottomScroll).toBe("true");

		await scrollTo(SCROLL_EDGE_THRESHOLD + TRANSCRIPT_HEAD_INSET + 1);
		expect(el.dataset.topScroll).toBe("true");
		expect(el.dataset.bottomScroll).toBe("true");

		// Pinned to the newest row: top feather allowed, bottom edge off.
		await scrollTo(V.scrollHeight - V.clientHeight);
		expect(el.dataset.topScroll).toBe("true");
		expect(el.dataset.bottomScroll).toBe("false");
	});
});
