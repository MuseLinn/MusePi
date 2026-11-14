import "./happy-dom-shim";
import { afterAll, describe, expect, test } from "bun:test";
import { setLocale } from "@musepi/client-core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { SessionListNode } from "../src/components/SessionList";
import { SessionSidebar } from "../src/components/SessionSidebar";

// Row-menu delete contract (openchamber parity): an active session row
// offers permanent delete in its right-click menu (same daemon
// session.delete + centralized confirm as the top-bar menu), not only
// in the archive view. Without the prop the menu keeps its old shape.

setLocale("zh-CN");
afterAll(() => {
	setLocale("en-US");
});

function node(id: string): SessionListNode {
	const now = new Date().toISOString();
	return {
		entry: {
			type: "session",
			id,
			parentId: null,
			timestamp: now,
			updatedAt: now,
			label: "Some task",
		},
		children: [],
	};
}

function baseProps(extra: Record<string, unknown> = {}) {
	return {
		nodes: [node("s1")],
		sessionMeta: new Map(),
		selectedId: null,
		onSelect: () => {},
		onNewSession: () => {},
		status: "open" as const,
		onDisconnect: () => {},
		onOpenConnect: () => {},
		onOpenSettings: () => {},
		onOpenSearch: () => {},
		collapsed: false,
		onDeleteArchived: async () => true,
		connected: true,
		daemonUrl: "ws://localhost:8300",
		onReconnect: () => {},
		hosts: [],
		onSwitchHost: () => {},
		onAddHost: () => {},
		onRemoveHost: () => {},
		...extra,
	};
}

async function flush(frames = 3): Promise<void> {
	await act(async () => {
		for (let i = 0; i < frames; i++) {
			await new Promise(r => setTimeout(r, 10));
		}
	});
}

async function mount(extra: Record<string, unknown> = {}): Promise<{ root: unknown; cleanup: () => void }> {
	document.body.innerHTML = '<div id="root"></div><div id="app"></div>';
	const app = document.getElementById("app");
	if (!app) throw new Error("no app mount");
	const root = createRoot(app);
	await act(async () => {
		root.render(<SessionSidebar {...baseProps(extra)} />);
	});
	return {
		root,
		cleanup: () => {
			act(() => {
				root.unmount();
			});
			document.body.innerHTML = "";
		},
	};
}

function rowEl(): HTMLElement {
	const el = Array.from(document.querySelectorAll("#app .gui-session-row")).find(b =>
		b.textContent?.includes("Some task"),
	) as HTMLElement | undefined;
	if (!el) throw new Error("session row not found");
	return el;
}

async function openMenu(): Promise<void> {
	const row = rowEl();
	await act(async () => {
		row.dispatchEvent(
			new MouseEvent("contextmenu", {
				bubbles: true,
				clientX: 60,
				clientY: 120,
			}),
		);
	});
	await flush();
}

function menuButtons(): HTMLElement[] {
	return Array.from(document.querySelectorAll("#root [role=menuitem]")) as HTMLElement[];
}

describe("session row menu delete", () => {
	test("menu offers delete and routes it to onDeleteSession", async () => {
		const calls: string[] = [];
		const { cleanup } = await mount({
			onDeleteSession: async (id: string) => void calls.push(id),
		});
		try {
			await openMenu();
			const del = menuButtons().find(b => b.textContent?.includes("删除会话"));
			expect(del).toBeDefined();
			await act(async () => {
				del!.click();
			});
			expect(calls).toEqual(["s1"]);
		} finally {
			cleanup();
		}
	});

	test("without the prop the menu keeps its old shape (no delete item)", async () => {
		const { cleanup } = await mount();
		try {
			await openMenu();
			const labels = menuButtons().map(b => b.textContent ?? "");
			expect(labels.some(t => t.includes("删除会话"))).toBe(false);
			// The pre-existing items still render.
			expect(labels.some(t => t.includes("复制会话 ID") || t.includes("Copy session ID"))).toBe(true);
		} finally {
			cleanup();
		}
	});
});

describe("session row menu export / AI rename", () => {
	test("menu offers export and routes it with the row label", async () => {
		const calls: { id: string; title: string }[] = [];
		const { cleanup } = await mount({
			onExportSession: async (id: string, title: string) => void calls.push({ id, title }),
		});
		try {
			await openMenu();
			const exp = menuButtons().find(b => b.textContent?.includes("导出 Markdown"));
			expect(exp).toBeDefined();
			await act(async () => {
				exp!.click();
			});
			expect(calls).toEqual([{ id: "s1", title: "Some task" }]);
		} finally {
			cleanup();
		}
	});

	test("menu offers AI rename, routes it, and disables it while pending", async () => {
		const calls: string[] = [];
		let release!: (v: { ok: boolean }) => void;
		const gate = new Promise<{ ok: boolean }>(resolve => {
			release = resolve;
		});
		const { cleanup } = await mount({
			onRetitleSession: (id: string) => {
				calls.push(id);
				return gate;
			},
		});
		try {
			await openMenu();
			const ai = menuButtons().find(b => b.textContent?.includes("AI 重命名"));
			expect(ai).toBeDefined();
			expect((ai as HTMLButtonElement).disabled).toBe(false);
			await act(async () => {
				ai!.click();
			});
			expect(calls).toEqual(["s1"]);
			// Still pending: reopening the menu shows the item disabled.
			await openMenu();
			const aiBusy = menuButtons().find(b => b.textContent?.includes("AI 重命名"));
			expect((aiBusy as HTMLButtonElement).disabled).toBe(true);
			await act(async () => {
				release({ ok: true });
				await gate;
			});
			await flush();
			await openMenu();
			const aiIdle = menuButtons().find(b => b.textContent?.includes("AI 重命名"));
			expect((aiIdle as HTMLButtonElement).disabled).toBe(false);
		} finally {
			cleanup();
		}
	});

	test("without the props the menu keeps its old shape (no export / AI items)", async () => {
		const { cleanup } = await mount({
			onDeleteSession: async () => true,
		});
		try {
			await openMenu();
			const labels = menuButtons().map(b => b.textContent ?? "");
			expect(labels.some(t => t.includes("导出 Markdown"))).toBe(false);
			expect(labels.some(t => t.includes("AI 重命名"))).toBe(false);
			// Delete (prop present) still renders.
			expect(labels.some(t => t.includes("删除会话"))).toBe(true);
		} finally {
			cleanup();
		}
	});
});
