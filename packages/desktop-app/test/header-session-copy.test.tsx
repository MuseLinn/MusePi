import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getLocaleSnapshot, setLocale, t } from "@musepi/client-core";
import type { SessionEntry } from "@musepi/pi-wire";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { GuiHeader } from "../src/components/GuiHeader";
import type { RpcClient } from "../src/lib/rpc";
import type { GuiSessionStore } from "../src/lib/session-store";

/**
 * Session menu clipboard actions.
 *
 * Two failure modes are pinned here: the copy actions shipped without a
 * disabled state (a session with no reply copied an empty string and reported
 * success), and "final summary" exporting the whole conversation instead of
 * the last assistant reply. The clipboard is the desktop bridge, so the test
 * stubs `window.electronAPI` — the same seam the real shell provides.
 */

const mounted: Root[] = [];
const hosts: HTMLElement[] = [];
let previousLocale: string;

beforeEach(() => {
	previousLocale = getLocaleSnapshot();
	setLocale("en-US");
});

afterEach(async () => {
	// Let the menu's 130ms exit animation settle so its timer does not fire an
	// update into the next test.
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 160));
	});
	while (mounted.length > 0) {
		const root = mounted.pop();
		if (root) act(() => root.unmount());
	}
	while (hosts.length > 0) hosts.pop()?.remove();
	delete (window as unknown as Record<string, unknown>).electronAPI;
	setLocale(previousLocale);
});

let seq = 0;
function user(text: string): SessionEntry {
	seq += 1;
	return {
		type: "message",
		id: `u${seq}`,
		parentId: null,
		timestamp: "2026-11-05T00:00:00.000Z",
		message: { role: "user", content: text, timestamp: seq },
	} as unknown as SessionEntry;
}
function assistant(text: string): SessionEntry {
	seq += 1;
	return {
		type: "message",
		id: `a${seq}`,
		parentId: null,
		timestamp: "2026-11-05T00:00:01.000Z",
		message: { role: "assistant", content: [{ type: "text", text }], timestamp: seq },
	} as unknown as SessionEntry;
}

function fakeStore(entries: SessionEntry[]): GuiSessionStore {
	const snapshot = {
		sessionId: "session-1",
		entries,
		state: { cwd: "D:/work" },
		working: false,
		streaming: false,
	};
	return {
		sessionId: "session-1",
		cwd: "D:/work",
		subscribe: () => () => {},
		getSnapshot: () => snapshot,
	} as unknown as GuiSessionStore;
}

interface Rendered {
	host: HTMLElement;
	toasts: { message: string; kind?: string }[];
}

async function renderHeader(entries: SessionEntry[]): Promise<Rendered> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	hosts.push(host);
	const root = createRoot(host);
	mounted.push(root);
	const toasts: { message: string; kind?: string }[] = [];
	const onToast = (event: Event): void => {
		toasts.push((event as CustomEvent<{ message: string; kind?: string }>).detail);
	};
	window.addEventListener("musepi-gui-toast", onToast);
	host.addEventListener("musepi-gui-toast", onToast);
	const rpc = {
		request: () => Promise.resolve(null),
		addEventListener: () => () => {},
	} as unknown as RpcClient;
	await act(async () => {
		root.render(
			<GuiHeader
				store={fakeStore(entries)}
				rpc={rpc}
				sideCollapsed={false}
				onToggleSidebar={() => {}}
				onNewSession={() => {}}
				onOpenSettings={() => {}}
				terminalOpen={false}
				onToggleTerminal={() => {}}
				project="D:/work"
				onOpenFolder={() => {}}
				sessions={[]}
				onSelectSession={() => {}}
				onRenameSession={() => {}}
				onOpenCollab={() => {}}
				onDeleteSession={async () => true}
			/>,
		);
	});
	return { host, toasts };
}

function menuItem(label: string): HTMLButtonElement {
	// MenuPopup portals into the React root (document.body), not into the
	// header's own subtree.
	const item = Array.from(document.querySelectorAll<HTMLButtonElement>(".gui-view-opt")).find(
		button => button.textContent === label,
	);
	expect(item, `missing menu item ${label}`).toBeDefined();
	return item!;
}

async function openSessionMenu(host: HTMLElement): Promise<void> {
	const trigger = host.querySelector<HTMLButtonElement>('[data-header-trigger="titleMenu"]');
	expect(trigger).not.toBeNull();
	await act(async () => trigger!.click());
}

function stubClipboard(copied: string[], ok = true): void {
	(window as unknown as Record<string, unknown>).electronAPI = {
		platform: "win32",
		copyText: async (text: string) => {
			copied.push(text);
			return ok;
		},
	};
}

describe("session menu copy actions", () => {
	test("copies the whole conversation in the export's Markdown shape", async () => {
		const copied: string[] = [];
		stubClipboard(copied);
		const { host, toasts } = await renderHeader([user("What changed?"), assistant("Two files.")]);
		await openSessionMenu(host);

		const item = menuItem(t("general.copyAllConversation"));
		expect(item.disabled).toBe(false);
		await act(async () => item.click());

		expect(copied).toHaveLength(1);
		expect(copied[0]).toContain("What changed?");
		expect(copied[0]).toContain("Two files.");
		expect(copied[0]).toContain(t("general.assistant"));
		expect(toasts).toEqual([{ kind: "success", message: t("general.copiedAllConversation") }]);
	});

	test("copies only the last assistant reply as the final summary", async () => {
		const copied: string[] = [];
		stubClipboard(copied);
		const { host, toasts } = await renderHeader([
			user("first"),
			assistant("draft answer"),
			user("again"),
			assistant("final answer"),
		]);
		await openSessionMenu(host);

		const item = menuItem(t("general.copyFinalSummary"));
		expect(item.disabled).toBe(false);
		await act(async () => item.click());

		expect(copied).toEqual(["final answer"]);
		expect(toasts).toEqual([{ kind: "success", message: t("general.copiedFinalSummary") }]);
	});

	test("disables both actions for a session with nothing to copy", async () => {
		const copied: string[] = [];
		stubClipboard(copied);
		const { host, toasts } = await renderHeader([]);
		await openSessionMenu(host);

		expect(menuItem(t("general.copyAllConversation")).disabled).toBe(true);
		expect(menuItem(t("general.copyFinalSummary")).disabled).toBe(true);
		await act(async () => menuItem(t("general.copyAllConversation")).click());
		expect(copied).toEqual([]);
		expect(toasts).toEqual([]);
	});

	test("keeps the summary action disabled until a reply exists", async () => {
		const copied: string[] = [];
		stubClipboard(copied);
		const { host } = await renderHeader([user("still waiting")]);
		await openSessionMenu(host);

		expect(menuItem(t("general.copyAllConversation")).disabled).toBe(false);
		expect(menuItem(t("general.copyFinalSummary")).disabled).toBe(true);
	});

	test("reports a clipboard failure instead of claiming success", async () => {
		stubClipboard([], false);
		const { host, toasts } = await renderHeader([user("q"), assistant("a")]);
		await openSessionMenu(host);

		await act(async () => menuItem(t("general.copyAllConversation")).click());
		expect(toasts).toEqual([{ kind: "error", message: t("general.copyFailed") }]);
	});
});
