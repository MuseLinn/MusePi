import "./dom-shim"; // MUST be first — GUI libs capture `isBrowser` at import.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

// dom-shim installs a document but no localStorage / window — provide both so
// the renderer-local prefs and the Electron notification bridge are testable.
// Bun runs every test FILE in one process, so these globals are swapped in per
// test and restored after: leaving a stub `document` behind silently changed
// what the subagent-completion tests in session-store.test.ts concluded about
// window focus.
const globals = globalThis as Record<string, unknown>;
const savedDoc = globals.document;
const savedWindow = globals.window;

const store = new Map<string, string>();
const shown: Array<{ title: string; body: string }> = [];

function installGlobals(): void {
	globals.localStorage = {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	};
	globals.window = {
		electronAPI: {
			showNotification: (title: string, body: string) => {
				shown.push({ title, body });
				return Promise.resolve({ ok: true });
			},
		},
	};
}

function restoreGlobals(): void {
	globals.document = savedDoc;
	globals.window = savedWindow;
}

import { buildNotification, type FocusReport, saveNotifyTemplates, shouldNotify } from "../src/lib/notify";
import { GuiSessionStore } from "../src/lib/session-store";

/**
 * Issue #14 — "启用通知" produced no desktop toast for real work.
 *
 * Gap 1: `shouldNotify` suppressed whenever `visibilityState !== "hidden"`, so a
 * window that was merely on screen (user switched to a browser) never notified.
 * Gap 2: only a text-only `message_end` dispatched "completion" — a run that
 * used tools (i.e. almost every coding task) got no toast at all, and
 * `agent_end` never dispatched one.
 */

const VISIBLE_UNFOCUSED: FocusReport = { hidden: false, hasFocus: () => false };
const VISIBLE_FOCUSED: FocusReport = { hidden: false, hasFocus: () => true };
const HIDDEN: FocusReport = { hidden: true, hasFocus: () => false };

function prefs(notify: boolean, focused: boolean): void {
	localStorage.setItem("musepi-gui-notify", notify ? "1" : "0");
	localStorage.setItem("musepi-gui-notify-focused", focused ? "1" : "0");
}

/** Route {last_message} into the body so the payload is assertable (the
 *  shipped default is "{model_name} 已完成任务"). */
function useLastMessageTemplate(): void {
	saveNotifyTemplates({
		completion: { title: "done", message: "{last_message}" },
		subtask: { title: "sub", message: "{last_message}" },
		error: { title: "err", message: "{last_message}" },
		question: { title: "q", message: "{last_message}" },
	});
}

/** apply() frame-coalesces through a microtask flush — yield twice. */
async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("notify focus gate (issue #14 gap 1)", () => {
	beforeEach(() => {
		installGlobals();
		prefs(true, false);
	});
	afterEach(restoreGlobals);

	it("delivers when the window is visible but NOT focused", () => {
		// The regression: on screen behind another app is exactly when the
		// user needs the toast, and the old visibilityState gate dropped it.
		expect(shouldNotify("completion", VISIBLE_UNFOCUSED)).toBe(true);
	});

	it("still suppresses when the window has focus and 聚焦时也通知 is off", () => {
		expect(shouldNotify("completion", VISIBLE_FOCUSED)).toBe(false);
	});

	it("delivers while focused when the user opted into 聚焦时也通知", () => {
		prefs(true, true);
		expect(shouldNotify("completion", VISIBLE_FOCUSED)).toBe(true);
	});

	it("delivers for a hidden window (minimized / other desktop)", () => {
		expect(shouldNotify("completion", HIDDEN)).toBe(true);
	});

	it("buildNotification renders a real payload in the visible-unfocused case", () => {
		useLastMessageTemplate();
		const built = buildNotification("completion", { lastMessage: "rsme 0.96" }, VISIBLE_UNFOCUSED);
		expect(built).not.toBeNull();
		expect(built?.body).toContain("rsme 0.96");
	});
});

describe("agent_end completion notification (issue #14 gap 2)", () => {
	beforeEach(() => {
		installGlobals();
		shown.length = 0;
		prefs(true, false);
		useLastMessageTemplate();
		// Visible but NOT focused — the case the old gate dropped.
		globals.document = { hidden: false, hasFocus: () => false };
	});
	afterEach(restoreGlobals);

	const agentEnd = (stopReason: string) => ({
		kind: "event" as const,
		seq: 1,
		payload: {
			type: "agent_end",
			messages: [{ role: "assistant", stopReason, content: [{ type: "text", text: "LOYO RMSE 0.96" }] }],
		},
	});

	it("notifies once when the run finishes", async () => {
		const s = new GuiSessionStore("s1", { entries: [], cursor: 0 }, "/tmp/proj");
		s.apply(agentEnd("stop") as never);
		await settle();
		expect(shown.length).toBe(1);
		expect(shown[0]?.body).toContain("LOYO RMSE 0.96");
	});

	it("does not notify an aborted run", async () => {
		const s = new GuiSessionStore("s2", { entries: [], cursor: 0 }, "/tmp/proj");
		s.apply(agentEnd("aborted") as never);
		await settle();
		expect(shown.length).toBe(0);
	});

	it("does not notify an errored run", async () => {
		const s = new GuiSessionStore("s3", { entries: [], cursor: 0 }, "/tmp/proj");
		s.apply(agentEnd("error") as never);
		await settle();
		expect(shown.length).toBe(0);
	});

	it("stays silent when the master notification switch is off", async () => {
		prefs(false, false);
		const s = new GuiSessionStore("s4", { entries: [], cursor: 0 }, "/tmp/proj");
		s.apply(agentEnd("stop") as never);
		await settle();
		expect(shown.length).toBe(0);
	});
});
