import "./happy-dom-shim";
import { afterEach, describe, expect, test } from "bun:test";
import { getLocaleSnapshot, setLocale } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { GuiHeader } from "../src/components/GuiHeader";
import { SessionTabsStrip } from "../src/components/SessionTabsStrip";
import type { RpcClient } from "../src/lib/rpc";

function testInEnglish(name: string, run: () => void | Promise<void>): void {
	test(name, async () => {
		const previous = getLocaleSnapshot();
		setLocale("en-US");
		try {
			await run();
		} finally {
			setLocale(previous);
		}
	});
}

const mounted: Root[] = [];
const hosts: HTMLElement[] = [];
const tabs = [
	{ id: "a", label: "Pinned", working: false, unread: false },
	{ id: "b", label: "Preview", working: false, unread: false },
];

type ActionName =
	| "keep"
	| "rename"
	| "copy"
	| "export"
	| "mini"
	| "worktree"
	| "archive"
	| "delete"
	| "closeOthers"
	| "close"
	| "select";

function renderStrip(activeId = "a") {
	const calls: [ActionName, string][] = [];
	const action = (name: ActionName) => (id: string) => calls.push([name, id]);
	const host = document.createElement("div");
	host.id = "root";
	document.body.appendChild(host);
	hosts.push(host);
	const root = createRoot(host);
	mounted.push(root);
	act(() => {
		root.render(
			<SessionTabsStrip
				tabs={tabs}
				activeId={activeId}
				previewTabId="b"
				onSelect={action("select")}
				onKeepOpen={action("keep")}
				onRename={action("rename")}
				onCopyId={action("copy")}
				onExport={action("export")}
				onOpenMiniChat={action("mini")}
				onMoveToWorktree={action("worktree")}
				onArchive={action("archive")}
				onDelete={action("delete")}
				onCloseOthers={action("closeOthers")}
				onClose={action("close")}
				onReorder={() => {}}
			/>,
		);
	});
	return { calls, host };
}

async function renderHeader() {
	const host = document.createElement("div");
	host.id = "root";
	document.body.appendChild(host);
	hosts.push(host);
	const root = createRoot(host);
	mounted.push(root);
	const selected: string[] = [];
	let newSessions = 0;
	const rpc = {
		request: () => Promise.resolve(null),
		addEventListener: () => () => {},
	} as unknown as RpcClient;
	await act(async () => {
		root.render(
			<GuiHeader
				store={null}
				rpc={rpc}
				sideCollapsed
				onToggleSidebar={() => {}}
				onNewSession={() => {
					newSessions += 1;
				}}
				onOpenSettings={() => {}}
				terminalOpen={false}
				onToggleTerminal={() => {}}
				project={null}
				onOpenFolder={() => {}}
				sessions={[{ id: "recent", label: "Recent session", timestamp: Date.now() }]}
				onSelectSession={id => selected.push(id)}
				onRenameSession={() => {}}
				onOpenCollab={() => {}}
				onDeleteSession={async () => true}
				tabs={tabs}
			/>,
		);
	});
	return { host, selected, newSessions: () => newSessions };
}

function menuLabels(host: HTMLElement): string[] {
	return Array.from(host.querySelectorAll<HTMLButtonElement>("[role=menuitem]"), item => item.textContent ?? "");
}

function clickMenuItem(host: HTMLElement, label: string): void {
	const item = Array.from(host.querySelectorAll<HTMLButtonElement>("[role=menuitem]")).find(
		button => button.textContent === label,
	);
	expect(item, `missing menu item ${label}`).toBeDefined();
	act(() => item!.click());
}

afterEach(() => {
	while (mounted.length > 0) {
		const root = mounted.pop();
		if (root) act(() => root.unmount());
	}
	while (hosts.length > 0) hosts.pop()?.remove();
});

describe("SessionTabsStrip preview", () => {
	testInEnglish("active and inactive tabs share the same title structure", () => {
		const { host } = renderStrip("a");
		const rows = Array.from(host.querySelectorAll<HTMLElement>(".gui-session-tab"));
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row.querySelector(".gui-session-tab-main .gui-session-tab-label")).not.toBeNull();
			expect(row.querySelector(".gui-session-tab-current")).toBeNull();
		}
		expect(rows[1]!.querySelector(".gui-session-tab-label--preview")).not.toBeNull();
		expect(rows[0]!.querySelector(".gui-session-tab-label--preview")).toBeNull();
	});

	testInEnglish("clicking an open preview pins it before activating by id", () => {
		const { calls, host } = renderStrip("a");
		const preview = host.querySelectorAll<HTMLElement>(".gui-session-tab")[1]!;
		act(() => preview.click());
		expect(calls).toEqual([
			["keep", "b"],
			["select", "b"],
		]);
	});

	testInEnglish("clicking the active preview pins without reactivating", () => {
		const { calls, host } = renderStrip("b");
		const preview = host.querySelectorAll<HTMLElement>(".gui-session-tab")[1]!;
		act(() => preview.click());
		expect(calls).toEqual([["keep", "b"]]);
	});

	testInEnglish("double-clicking a preview pins that tab", () => {
		const { calls, host } = renderStrip("a");
		const preview = host.querySelectorAll<HTMLElement>(".gui-session-tab")[1]!;
		act(() => {
			preview.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
		});
		expect(calls).toContainEqual(["keep", "b"]);
	});
});

describe("SessionTabsStrip shared menu", () => {
	testInEnglish("ellipsis and right-click expose the same full action model", () => {
		const { calls, host } = renderStrip("a");
		const preview = host.querySelectorAll<HTMLElement>(".gui-session-tab")[1]!;
		act(() => {
			preview.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 30, clientY: 40 }));
		});
		const contextLabels = menuLabels(host);
		expect(contextLabels).toEqual([
			"Keep open",
			"Rename session",
			"Copy session ID",
			"Export Markdown",
			"Open in mini chat",
			"Move to new worktree",
			"Archive task",
			"Delete session",
			"Close other tabs",
			"Close tab",
		]);
		expect(calls).toEqual([]);
		clickMenuItem(host, "Archive task");
		expect(calls).toEqual([["archive", "b"]]);

		const menuButton = preview.querySelector<HTMLButtonElement>("[aria-label='Tab menu']")!;
		act(() => menuButton.click());
		expect(menuLabels(host)).toEqual(contextLabels);
	});

	testInEnglish("every menu action targets the right-clicked tab without selecting it", () => {
		const { calls, host } = renderStrip("a");
		const preview = host.querySelectorAll<HTMLElement>(".gui-session-tab")[1]!;
		const cases: [string, ActionName][] = [
			["Keep open", "keep"],
			["Rename session", "rename"],
			["Copy session ID", "copy"],
			["Export Markdown", "export"],
			["Open in mini chat", "mini"],
			["Move to new worktree", "worktree"],
			["Archive task", "archive"],
			["Delete session", "delete"],
			["Close other tabs", "closeOthers"],
			["Close tab", "close"],
		];
		for (const [label, action] of cases) {
			act(() => {
				preview.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 30, clientY: 40 }));
			});
			clickMenuItem(host, label);
			expect(calls.at(-1)).toEqual([action, "b"]);
		}
		expect(calls.filter(([action]) => action === "select")).toEqual([]);
	});
});

describe("GuiHeader tab navigation", () => {
	testInEnglish("keeps new-session and recent-session navigation available with tabs", async () => {
		const { host, selected, newSessions } = await renderHeader();
		const switcher = host.querySelector<HTMLButtonElement>("button[aria-label='Recent sessions']");
		expect(switcher).not.toBeNull();
		act(() => switcher!.click());
		const newSession = Array.from(host.querySelectorAll<HTMLButtonElement>(".gui-header-session-row")).find(
			button => button.textContent === "New session",
		);
		expect(newSession).toBeDefined();
		act(() => newSession!.click());
		expect(newSessions()).toBe(1);

		act(() => switcher!.click());
		const recent = Array.from(host.querySelectorAll<HTMLButtonElement>(".gui-header-session-row")).find(button =>
			button.textContent?.includes("Recent session"),
		);
		expect(recent).toBeDefined();
		act(() => recent!.click());
		expect(selected).toEqual(["recent"]);
	});
});
