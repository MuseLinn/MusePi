/**
 * 撤回 (withdraw) contract in the conversation view.
 *
 * The user reports two defects: withdrawing a turn asks nothing, and the
 * withdrawn turn's user message + reply stay in the transcript afterwards.
 * 撤回 is `session.branchAt` (a non-destructive leaf move), so the turn stays
 * on the tree as a sibling branch — but the transcript must follow the ACTIVE
 * path, i.e. show the conversation up to the withdraw target and nothing from
 * the abandoned tail, with the dock offering one undo.
 */
import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { EditorView } from "@codemirror/view";
import { t } from "@musepi/client-core";
import type { SessionEntry } from "@musepi/pi-wire";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChatView } from "../src/components/ChatView";
import { PromptProvider } from "../src/lib/prompt-dialog";
import type { RpcClient } from "../src/lib/rpc";
import { GuiSessionStore } from "../src/lib/session-store";
import { settle } from "./settle-store";

function entry(
	id: string,
	parentId: string | null,
	role: "user" | "assistant",
	text: string,
	ts: number,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(ts).toISOString(),
		message: {
			role,
			timestamp: ts,
			stopReason: role === "assistant" ? "stop" : undefined,
			content: [{ type: "text", text }],
		},
	} as unknown as SessionEntry;
}

const T0 = 1_700_000_000_000;
/** Turn 1: ask first → answer first. Turn 2: ask second → answer second. */
const TURNS = [
	entry("u1", null, "user", "first question", T0),
	entry("a1", "u1", "assistant", "first answer", T0 + 1000),
	entry("u2", "a1", "user", "second question", T0 + 2000),
	entry("a2", "u2", "assistant", "second answer", T0 + 3000),
];

const roots = new Set<Root>();
const stores = new Set<GuiSessionStore>();

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	for (const store of stores) store.dispose();
	roots.clear();
	stores.clear();
	document.body.innerHTML = "";
});

interface LeafAfter {
	leafId: string | null;
	path: string[];
	pathEntries: SessionEntry[];
}

/** `turns` defaults to empty: a two-turn session whose tree index returns
 *  nothing is the realistic case for "An earlier turn" (a session just
 *  resumed, or a tree row above the briefing). Pass them to name the turn. */
function fakeRpc(
	calls: Array<{ method: string; params: Record<string, unknown> }>,
	leafAfter: () => LeafAfter,
	turns: Array<{ entryId: string; timestamp: string; preview: string }> = [],
) {
	return {
		request: async (method: string, params: Record<string, unknown> = {}) => {
			calls.push({ method, params });
			if (method.startsWith("models.list")) return [];
			if (method === "git.branches") return { error: "not a repository" };
			if (method === "session.turns") return { turns };
			if (method === "session.branchAt") {
				const next = leafAfter();
				return { ok: true, editorText: null, ...next };
			}
			return {};
		},
		addEventListener: () => () => {},
	} as unknown as RpcClient;
}

async function mount(
	rpc: RpcClient,
	store: GuiSessionStore,
	onSend: (text: string, ...rest: unknown[]) => void = () => {},
	onStop: () => void = () => {},
): Promise<HTMLElement> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.add(root);
	await act(async () =>
		root.render(
			<PromptProvider>
				<ChatView
					store={store}
					rpc={rpc}
					onSend={onSend as never}
					onStop={onStop}
					onDecideApproval={() => {}}
					busy={false}
					project="C:/workspace"
					onProject={() => {}}
					onSubmitNewSession={() => {}}
					rightPanelOpen={false}
					terminalOpen={false}
					focusMode={false}
					onToggleFocus={() => {}}
				/>
			</PromptProvider>,
		),
	);
	await act(async () => settle());
	return host;
}

/** Transcript-only text: the dock and composer also carry the withdrawn
 *  prompt, so whole-DOM assertions cannot tell "row still rendered" from
 *  "draft restored" — the two things this contract must distinguish. */
function transcriptText(host: HTMLElement): string {
	return host.querySelector(".gui-transcript")?.textContent ?? "";
}

/** The dock is always mounted (Reveal animates it shut); "offered" means it is
 *  reachable — not inert/aria-hidden — which is what a keyboard or screen
 *  reader user gets. */
function dockOffered(host: HTMLElement): boolean {
	const dock = host.querySelector(".gui-revert-dock");
	if (!dock) return false;
	const collapse = dock.closest(".gui-collapse");
	return !!collapse && collapse.getAttribute("aria-hidden") !== "true";
}

function withdrawButton(host: HTMLElement, id: string): HTMLButtonElement {
	const row = host.querySelector<HTMLElement>(`[data-entry-id="${id}"]`);
	expect(row).not.toBeNull();
	const button = row!.querySelector<HTMLButtonElement>(`button[aria-label="${t("general.revertMessage")}"]`);
	expect(button).not.toBeNull();
	return button!;
}

describe("ChatView withdraw", () => {
	it("drops the withdrawn turn from the transcript and offers one undo", async () => {
		const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
		const rpc = fakeRpc(calls, () => ({
			leafId: "a1",
			path: ["u1", "a1"],
			pathEntries: TURNS.slice(0, 2),
		}));
		const store = new GuiSessionStore("withdraw-drop", { entries: TURNS, cursor: 0 }, "C:/workspace");
		stores.add(store);
		const host = await mount(rpc, store);

		await act(async () => withdrawButton(host, "u2").click());
		await act(async () => Bun.sleep(90));
		// Confirm (added by this change) — cancelling is covered separately.
		const confirm = document.querySelector<HTMLElement>(".gui-dialog--confirm .gui-btn-primary");
		if (confirm) await act(async () => confirm.click());
		await act(async () => Bun.sleep(240));

		expect(transcriptText(host)).toContain("first question");
		expect(transcriptText(host)).toContain("first answer");
		expect(transcriptText(host)).not.toContain("second question");
		expect(transcriptText(host)).not.toContain("second answer");
		// The dock names the target of the move and offers the single undo.
		expect(dockOffered(host)).toBe(true);
		expect(host.querySelector(`.gui-revert-dock [title="${t("general.undoJump")}"]`)).not.toBeNull();
	}, 20000);

	it("holds the guarantee when the local chain is cut (live sessions omit parentId)", async () => {
		// Live wire messages do not always carry parentId (packages/wire
		// index.ts: live events may omit it), so the local walk can come back
		// `complete: false`. The documented fallback then shows EVERY row —
		// including the turn just withdrawn. The daemon's path is authoritative
		// and is the only thing that can hold the guarantee here.
		const cut: SessionEntry[] = [
			entry("u1", null, "user", "first question", T0),
			entry("a1", "u1", "assistant", "first answer", T0 + 1000),
			entry("u2", null, "user", "second question", T0 + 2000),
			entry("a2", "u2", "assistant", "second answer", T0 + 3000),
		];
		const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
		const rpc = fakeRpc(calls, () => ({ leafId: "a1", path: ["u1", "a1"], pathEntries: [] }));
		const store = new GuiSessionStore("withdraw-cut", { entries: cut, cursor: 0 }, "C:/workspace");
		stores.add(store);
		const host = await mount(rpc, store);

		await act(async () => withdrawButton(host, "u2").click());
		await act(async () => Bun.sleep(90));
		await act(async () => document.querySelector<HTMLElement>(".gui-dialog--confirm .gui-btn-primary")!.click());
		await act(async () => Bun.sleep(240));

		// Path up to and including the target; nothing from the abandoned tail.
		expect(transcriptText(host)).toContain("first question");
		expect(transcriptText(host)).toContain("first answer");
		expect(transcriptText(host)).not.toContain("second question");
		expect(transcriptText(host)).not.toContain("second answer");
	}, 20000);

	it("undo in the dock restores the withdrawn turn", async () => {
		const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
		let leaf: { leafId: string | null; path: string[]; pathEntries: SessionEntry[] } = {
			leafId: "a1",
			path: ["u1", "a1"],
			pathEntries: TURNS.slice(0, 2),
		};
		const rpc = fakeRpc(calls, () => leaf);
		const store = new GuiSessionStore("withdraw-undo", { entries: TURNS, cursor: 0 }, "C:/workspace");
		stores.add(store);
		const host = await mount(rpc, store);

		await act(async () => withdrawButton(host, "u2").click());
		await act(async () => Bun.sleep(90));
		await act(async () => document.querySelector<HTMLElement>(".gui-dialog--confirm .gui-btn-primary")!.click());
		await act(async () => Bun.sleep(240));
		expect(transcriptText(host)).not.toContain("second question");

		// Undo jumps back to the leaf the withdraw came from.
		leaf = { leafId: "a2", path: ["u1", "a1", "u2", "a2"], pathEntries: [] };
		await act(async () =>
			host.querySelector<HTMLButtonElement>(`.gui-revert-dock [title="${t("general.undoJump")}"]`)!.click(),
		);
		await act(async () => Bun.sleep(240));

		expect(calls.filter(c => c.method === "session.branchAt").map(c => c.params.messageId)).toEqual(["u2", "a2"]);
		expect(transcriptText(host)).toContain("second question");
		expect(transcriptText(host)).toContain("second answer");
		expect(dockOffered(host)).toBe(false);
	}, 20000);

	it("a send after the withdraw makes the local path primary again", async () => {
		// Tower constraint: the daemon's post-move path must not outlive the
		// next prompt. If the pin still decided visibility once the user wrote
		// again, the transcript would keep filtering by the pre-send path and
		// hide the answer just produced — the mirror image of the original bug.
		const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
		const rpc = fakeRpc(calls, () => ({ leafId: "a1", path: ["u1", "a1"], pathEntries: [] }));
		const store = new GuiSessionStore("withdraw-send", { entries: TURNS, cursor: 0 }, "C:/workspace");
		stores.add(store);
		const sent: string[] = [];
		const host = await mount(rpc, store, (text: string) => sent.push(text));

		await act(async () => withdrawButton(host, "u2").click());
		await act(async () => Bun.sleep(90));
		await act(async () => document.querySelector<HTMLElement>(".gui-dialog--confirm .gui-btn-primary")!.click());
		await act(async () => Bun.sleep(240));
		expect(transcriptText(host)).not.toContain("second answer");

		// The user writes again and sends (same onChange → Enter path a
		// keystroke takes — see test/composer-input-history.test.tsx).
		const editor = host.querySelector<HTMLElement>("[data-composer-input] .cm-content");
		expect(editor).not.toBeNull();
		const view = EditorView.findFromDOM(editor!);
		expect(view).not.toBeNull();
		await act(async () => {
			view!.dispatch({ changes: { from: 0, to: view!.state.doc.length, insert: "third question" } });
		});
		await act(async () => {
			view!.focus();
			const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
			Object.defineProperty(event, "keyCode", { value: 13 });
			editor!.dispatchEvent(event);
		});
		await act(async () => Bun.sleep(240));
		expect(sent).toEqual(["third question"]);

		// The answer to the new prompt is visible; the withdrawn turn is not.
		await act(async () => {
			store.apply({
				kind: "event",
				seq: 1,
				payload: {
					type: "message_start",
					// The daemon stamps parentId on live messages
					// (stampLiveMessageParentId); the new prompt hangs off the
					// withdraw target so the local walk can describe the path.
					message: {
						role: "user",
						timestamp: T0 + 4000,
						parentId: "a1",
						content: [{ type: "text", text: "third question" }],
					},
				},
			} as never);
			store.apply({
				kind: "event",
				seq: 2,
				payload: {
					type: "message_start",
					message: {
						role: "assistant",
						timestamp: T0 + 5000,
						parentId: "user:1700000004000",
						stopReason: "end_turn",
						content: [{ type: "text", text: "third answer" }],
					},
				},
			} as never);
			await settle();
		});
		expect(transcriptText(host)).toContain("third answer");
		expect(transcriptText(host)).not.toContain("second answer");
	}, 20000);

	it("keeps history older than the daemon's 200-row window when a long session withdraws", async () => {
		// The daemon answers `branchAt` with `pathEntries.slice(-200)`
		// (`daemon/server.ts`), while the client keeps every page it loaded.
		// Treating that window as the whole path deleted real history the moment
		// a withdraw pinned it — the reviewer's 260-row probe showed 260 → 200.
		const turns = 130;
		const rows: SessionEntry[] = [];
		let parent: string | null = null;
		for (let i = 1; i <= turns; i += 1) {
			const user = `u${i}`;
			const assistant = `a${i}`;
			rows.push(entry(user, parent, "user", `question ${i}`, T0 + i * 2000));
			rows.push(entry(assistant, user, "assistant", `answer ${i}`, T0 + i * 2000 + 1000));
			parent = assistant;
		}
		const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
		// Withdraw turn 130: the target is turn 129's answer, so the daemon's
		// window covers rows 61..260 of the loaded transcript.
		const path = rows.map(row => row.id as string).slice(0, 258);
		const rpc = fakeRpc(calls, () => ({
			leafId: "a129",
			path: path.slice(-200),
			pathEntries: [],
		}));
		const store = new GuiSessionStore("withdraw-long", { entries: rows, cursor: 0 }, "C:/workspace");
		stores.add(store);
		const host = await mount(rpc, store);

		await act(async () => withdrawButton(host, "u130").click());
		await act(async () => Bun.sleep(90));
		await act(async () => document.querySelector<HTMLElement>(".gui-dialog--confirm .gui-btn-primary")!.click());
		await act(async () => Bun.sleep(240));

		// The rows older than the daemon window are still in the transcript's
		// input — the virtualizer's rendered set is the loaded transcript, not
		// the 200-row projection.
		const rendered = host.querySelectorAll("[data-entry-id]").length;
		expect(rendered).toBeGreaterThan(200);
		expect(transcriptText(host)).not.toContain("question 130");
	}, 20000);

	it("asks before moving the leaf, and cancel leaves the transcript intact", async () => {
		const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
		const rpc = fakeRpc(calls, () => ({ leafId: "a1", path: ["u1", "a1"], pathEntries: TURNS.slice(0, 2) }));
		const store = new GuiSessionStore("withdraw-cancel", { entries: TURNS, cursor: 0 }, "C:/workspace");
		stores.add(store);
		const host = await mount(rpc, store);
		expect(host.textContent).toContain("second question");

		await act(async () => withdrawButton(host, "u2").click());
		await act(async () => Bun.sleep(90));

		const dialog = document.querySelector<HTMLElement>(".gui-dialog--confirm");
		expect(dialog).not.toBeNull();
		// Names the consequence, not a generic "are you sure".
		expect(dialog!.textContent).toContain(t("general.withdrawConfirm"));
		expect(calls.some(c => c.method === "session.branchAt")).toBe(false);

		const cancel = dialog!.querySelector<HTMLElement>(".gui-btn:not(.gui-btn-primary)");
		expect(cancel).not.toBeNull();
		await act(async () => cancel!.click());
		await act(async () => Bun.sleep(240));

		expect(calls.some(c => c.method === "session.branchAt")).toBe(false);
		expect(host.textContent).toContain("second question");
		expect(host.textContent).toContain("second answer");
	}, 20000);

	it("names the consequence and the prompt instead of a bare 'are you sure'", async () => {
		const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
		const rpc = fakeRpc(calls, () => ({ leafId: "a1", path: ["u1", "a1"], pathEntries: [] }));
		const store = new GuiSessionStore("withdraw-wording", { entries: TURNS, cursor: 0 }, "C:/workspace");
		stores.add(store);
		const host = await mount(rpc, store);

		await act(async () => withdrawButton(host, "u2").click());
		await act(async () => Bun.sleep(90));

		const dialog = document.querySelector<HTMLElement>(".gui-dialog--confirm");
		expect(dialog).not.toBeNull();
		const text = dialog!.textContent ?? "";
		// The turn is named and the prompt is quoted, not described generically.
		expect(text).toContain("second question");
		// Side branch, nothing deleted, text back, one undo — in the user's words.
		expect(text).toContain(t("general.withdrawConfirm"));
		// Not a running turn: nothing about an interruption is said.
		expect(text).not.toContain(t("general.withdrawConfirmBusy"));
		expect(dialog!.querySelector(".gui-btn-primary")?.textContent).toBe(t("general.withdrawConfirmAction"));
	}, 20000);

	it("asks once when a run is in flight — and names the interruption in the same question", async () => {
		// Two stacked dialogs (interrupt? then withdraw?) was the old shape: the
		// second one read as a generic "are you sure" on top of a decision the
		// user had already made. One question has to carry both facts, and
		// answering it must be the end of the asking — not the start of a second.
		const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
		const rpc = fakeRpc(calls, () => ({ leafId: "a1", path: ["u1", "a1"], pathEntries: TURNS.slice(0, 2) }));
		const store = new GuiSessionStore(
			"withdraw-busy",
			{ entries: TURNS, cursor: 0, state: { isStreaming: true } },
			"C:/workspace",
		);
		stores.add(store);
		let stops = 0;
		// Stop is a request to the daemon; the run ends when its state frame
		// says so. Modelling that here is what lets the op actually run.
		const onStop = () => {
			stops += 1;
			store.apply({ kind: "state", seq: 0, payload: { isStreaming: false } } as never);
		};
		const host = await mount(rpc, store, () => {}, onStop);
		expect(store.getSnapshot().working).toBe(true);

		await act(async () => withdrawButton(host, "u2").click());
		await act(async () => Bun.sleep(90));

		const dialogs = document.querySelectorAll<HTMLElement>(".gui-dialog--confirm");
		expect(dialogs.length).toBe(1);
		const text = dialogs[0]!.textContent ?? "";
		expect(text).toContain("second question");
		expect(text).toContain(t("general.withdrawConfirmBusy"));
		// The question comes before the stop: deciding to withdraw is what stops
		// the run, so nothing is interrupted while the user is still deciding.
		expect(stops).toBe(0);

		await act(async () => dialogs[0]!.querySelector<HTMLElement>(".gui-btn-primary")!.click());
		await act(async () => Bun.sleep(240));

		// The named question was the only question: no dialog is left standing,
		// the run was stopped once, and the leaf actually moved. A second,
		// generic interrupt dialog would still be open here and branchAt would
		// not have been called.
		expect(document.querySelectorAll(".gui-dialog--confirm").length).toBe(0);
		expect(stops).toBe(1);
		expect(calls.filter(c => c.method === "session.branchAt").map(c => c.params.messageId)).toEqual(["u2"]);
		expect(transcriptText(host)).not.toContain("second question");
	}, 20000);

	it("asks before re-answering a turn from the map (same leaf move as withdraw)", async () => {
		// The map's re-answer branchTo's the turn's user message and refills the
		// composer — the exact leaf move 撤回 performs — so it asks the same
		// question. It also names WHICH turn: the map fires this from a context
		// menu, where "this turn" is the card under the pointer and nowhere else.
		const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
		const rpc = fakeRpc(calls, () => ({ leafId: "u1", path: ["u1"], pathEntries: [] }), [
			{ entryId: "u1", timestamp: new Date(T0).toISOString(), preview: "first question" },
			{ entryId: "u2", timestamp: new Date(T0 + 2000).toISOString(), preview: "second question" },
		]);
		const store = new GuiSessionStore("withdraw-map", { entries: TURNS, cursor: 0 }, "C:/workspace");
		stores.add(store);
		const host = await mount(rpc, store);
		await act(async () => Bun.sleep(120));

		// role="tab" carries its NAME as text content — there is no aria-label.
		const mapToggle = [...host.querySelectorAll<HTMLButtonElement>("button[role='tab']")].find(
			tab => tab.textContent?.trim() === t("transcript.surfaceCanvas"),
		);
		expect(mapToggle).toBeDefined();
		await act(async () => {
			mapToggle!.click();
			await Bun.sleep(150);
		});

		const turnCard = [...document.querySelectorAll<HTMLElement>(".tm-node")].find(node =>
			node.textContent?.includes("second question"),
		);
		expect(turnCard).toBeDefined();
		await act(async () =>
			turnCard!.dispatchEvent(
				new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
			),
		);
		// The menu item's label is followed by its description line, so the row
		// is found by prefix — it is the only row that starts with this label.
		const findReanswer = (): HTMLElement | undefined =>
			[...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find(row =>
				row.textContent?.trim().startsWith(t("transcript.branchReAnswerHere")),
			) ??
			[...document.querySelectorAll<HTMLElement>("button")].find(row =>
				row.textContent?.trim().startsWith(t("transcript.branchReAnswerHere")),
			);
		expect(findReanswer()).toBeDefined();

		await act(async () => findReanswer()!.click());
		await act(async () => Bun.sleep(90));
		const dialog = document.querySelector<HTMLElement>(".gui-dialog--confirm");
		expect(dialog).not.toBeNull();
		expect(dialog!.textContent).toContain("second question");
		expect(dialog!.textContent).toContain(t("general.withdrawConfirm"));
		expect(calls.some(c => c.method === "session.branchAt")).toBe(false);

		const cancel = dialog!.querySelector<HTMLElement>(".gui-btn:not(.gui-btn-primary)");
		await act(async () => cancel!.click());
		await act(async () => Bun.sleep(120));
		expect(calls.some(c => c.method === "session.branchAt")).toBe(false);

		// Right-click the same card again: the menu closed with the action.
		await act(async () =>
			turnCard!.dispatchEvent(
				new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
			),
		);
		await act(async () => findReanswer()!.click());
		await act(async () => Bun.sleep(90));
		await act(async () => document.querySelector<HTMLElement>(".gui-dialog--confirm .gui-btn-primary")!.click());
		await act(async () => Bun.sleep(240));
		expect(calls.find(c => c.method === "session.branchAt")?.params.messageId).toBe("u2");
	}, 20000);

	it("the message-tree row asks too, and withdraws the turn it names", async () => {
		const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
		const rpc = fakeRpc(calls, () => ({ leafId: "a1", path: ["u1", "a1"], pathEntries: TURNS.slice(0, 2) }));
		const store = new GuiSessionStore("withdraw-tree", { entries: TURNS, cursor: 0 }, "C:/workspace");
		stores.add(store);
		const host = await mount(rpc, store);

		const toggle = host.querySelector<HTMLButtonElement>(".gui-mtree-toggle");
		expect(toggle).not.toBeNull();
		await act(async () => toggle!.click());
		await act(async () => Bun.sleep(60));

		const rows = [...document.querySelectorAll<HTMLElement>(".gui-mtree-row")];
		const row = rows.find(button => button.textContent?.includes("second question"));
		expect(row).toBeDefined();
		const revert = row!.querySelector<HTMLButtonElement>(
			`.gui-mtree-fork[aria-label="${t("general.revertMessage")}"]`,
		);
		expect(revert).not.toBeNull();

		await act(async () => revert!.click());
		await act(async () => Bun.sleep(90));
		const dialog = document.querySelector<HTMLElement>(".gui-dialog--confirm");
		expect(dialog).not.toBeNull();
		expect(dialog!.textContent).toContain("second question");
		expect(calls.some(c => c.method === "session.branchAt")).toBe(false);

		await act(async () => dialog!.querySelector<HTMLElement>(".gui-btn-primary")!.click());
		await act(async () => Bun.sleep(240));
		expect(calls.find(c => c.method === "session.branchAt")?.params.messageId).toBe("u2");
		expect(transcriptText(host)).not.toContain("second question");
	}, 20000);
});
