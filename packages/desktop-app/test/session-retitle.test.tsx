import "./happy-dom-shim";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { setLocale } from "@musepi/client-core";
import { act, type ReactNode, useState } from "react";
import { createRoot } from "react-dom/client";
import { applyRetitledSessionLabel, retitleFailureReason } from "../src/app";
import type { SessionListNode } from "../src/components/SessionList";
import { SessionSidebar } from "../src/components/SessionSidebar";
import { dismissActionToast, getToasts } from "../src/lib/action-toast";

// AI rename feedback contract: the daemon answers `session.retitle` with the
// generated title (or a reason), and the GUI must show that answer where the
// user is looking — the row title it just clicked — instead of waiting for the
// next list poll. Transport/version failures each carry their own remedy, so
// the toast can never collapse into a generic "failed".

setLocale("zh-CN");
afterAll(() => {
	setLocale("en-US");
});
afterEach(() => {
	for (const toast of getToasts()) dismissActionToast(toast.id);
	document.body.innerHTML = "";
});

function node(id: string, label = "Some task", children: SessionListNode[] = []): SessionListNode {
	const now = new Date().toISOString();
	return {
		entry: { type: "session", id, parentId: null, timestamp: now, updatedAt: now, label },
		children,
	};
}

async function flush(frames = 3): Promise<void> {
	await act(async () => {
		for (let i = 0; i < frames; i++) {
			await new Promise(r => setTimeout(r, 10));
		}
	});
}

describe("AI rename applies the daemon's title", () => {
	test("renames the matching session in place and shares untouched subtrees", () => {
		const target = node("target", "Old title");
		const root = node("root", "Root", [target]);
		const other = node("other", "Other");
		const tree = [root, other];

		const next = applyRetitledSessionLabel(tree, "target", "Fresh title");

		expect(next[0]?.children[0]?.entry.label).toBe("Fresh title");
		// Only the path to the renamed session is rebuilt: everything else keeps
		// its identity so memoized rows do not re-render.
		expect(next[0]).not.toBe(root);
		expect(next[1]).toBe(other);
		expect(next[0]?.children[0]?.entry.id).toBe("target");
	});

	test("cuts the label at the same 60 characters session.tree uses", () => {
		const tree = [node("s1", "Old")];
		const next = applyRetitledSessionLabel(tree, "s1", "y".repeat(61));
		expect(next[0]?.entry.label).toBe(`${"y".repeat(60)}…`);
	});

	test("keeps the tree identity when the title did not change", () => {
		const tree = [node("s1", "Same")];
		expect(applyRetitledSessionLabel(tree, "s1", "Same")).toBe(tree);
	});
});

describe("AI rename failure reasons", () => {
	test("an old daemon that predates session.retitle is reported as unsupported", () => {
		expect(retitleFailureReason(new Error("Unknown method: session.retitle"))).toBe("unsupported");
	});

	test("the per-request cap is reported as a timeout", () => {
		expect(retitleFailureReason(new Error("request timeout: session.retitle"))).toBe("timeout");
	});

	test("a dropped socket is reported as offline", () => {
		expect(retitleFailureReason(new Error("connection closed (code 1006)"))).toBe("offline");
	});

	test("anything else stays a generic failure", () => {
		expect(retitleFailureReason(new Error("Unknown session: s1"))).toBe("failed");
	});
});

function baseProps(extra: Record<string, unknown> = {}) {
	return {
		nodes: [node("s1")],
		sessionMeta: new Map(),
		selectedId: null,
		onSelect: () => {},
		onNewSession: () => {},
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

async function mount(element: ReactNode): Promise<() => void> {
	document.body.innerHTML = '<div id="root"></div><div id="app"></div>';
	const app = document.getElementById("app");
	if (!app) throw new Error("no app mount");
	const root = createRoot(app);
	await act(async () => {
		root.render(element);
	});
	return () => {
		act(() => {
			root.unmount();
		});
		document.body.innerHTML = "";
	};
}

function rowEl(text: string): HTMLElement {
	const el = Array.from(document.querySelectorAll("#app .gui-session-row")).find(b => b.textContent?.includes(text)) as
		| HTMLElement
		| undefined;
	if (!el) throw new Error(`session row not found: ${text}`);
	return el;
}

async function openMenu(label: string): Promise<void> {
	const row = rowEl(label);
	await act(async () => {
		row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 60, clientY: 120 }));
	});
	await flush();
}

function menuItems(): HTMLElement[] {
	return Array.from(document.querySelectorAll("#root [role=menuitem]")) as HTMLElement[];
}

function menuItem(text: string): HTMLButtonElement | undefined {
	return menuItems().find(b => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
}

describe("AI rename row feedback", () => {
	test("the row shows the returned title without waiting for a list refresh", async () => {
		function Harness(): ReactNode {
			const [nodes, setNodes] = useState([node("s1")]);
			return (
				<SessionSidebar
					{...baseProps({ nodes })}
					onRetitleSession={async (id: string) => {
						// Same step the app runs on a successful response: apply the title
						// locally, then reconcile with the daemon in the background.
						setNodes(current => applyRetitledSessionLabel(current, id, "重命名后的标题"));
						return { ok: true, title: "重命名后的标题" };
					}}
				/>
			);
		}
		const cleanup = await mount(<Harness />);
		try {
			await openMenu("Some task");
			const item = menuItem("AI 重命名");
			expect(item).toBeDefined();
			await act(async () => {
				item!.click();
			});
			await flush();
			expect(rowEl("重命名后的标题")).toBeDefined();
			expect(document.body.textContent).not.toContain("Some task");
		} finally {
			cleanup();
		}
	});

	test("an old daemon's missing method names the restart instead of a generic failure", async () => {
		const cleanup = await mount(
			<SessionSidebar
				{...baseProps()}
				onRetitleSession={async () => ({
					ok: false,
					reason: retitleFailureReason(new Error("Unknown method: session.retitle")),
				})}
			/>,
		);
		try {
			await openMenu("Some task");
			await act(async () => {
				menuItem("AI 重命名")!.click();
			});
			await flush();
			const [toast] = getToasts();
			expect(toast?.kind).toBe("error");
			expect(toast?.message).toContain("重启 daemon");
		} finally {
			cleanup();
		}
	});

	test("an empty session explains what is missing", async () => {
		const cleanup = await mount(
			<SessionSidebar {...baseProps()} onRetitleSession={async () => ({ ok: false, reason: "empty" })} />,
		);
		try {
			await openMenu("Some task");
			await act(async () => {
				menuItem("AI 重命名")!.click();
			});
			await flush();
			expect(getToasts()[0]?.message).toContain("没有可命名的内容");
		} finally {
			cleanup();
		}
	});

	test("a generation failure points at the title model", async () => {
		const cleanup = await mount(
			<SessionSidebar
				{...baseProps()}
				onRetitleSession={async () => ({ ok: false, reason: "generation-failed" })}
			/>,
		);
		try {
			await openMenu("Some task");
			await act(async () => {
				menuItem("AI 重命名")!.click();
			});
			await flush();
			expect(getToasts()[0]?.message).toContain("标题模型");
		} finally {
			cleanup();
		}
	});

	test("the pane and the menu item show the run while it is in flight, then recover", async () => {
		let release!: (value: { ok: boolean; title: string }) => void;
		const gate = new Promise<{ ok: boolean; title: string }>(resolve => {
			release = resolve;
		});
		const cleanup = await mount(<SessionSidebar {...baseProps()} onRetitleSession={async () => gate} />);
		try {
			await openMenu("Some task");
			await act(async () => {
				menuItem("AI 重命名")!.click();
			});
			await flush();
			expect(document.querySelector("#app [role=status]")?.textContent).toContain("Some task");
			await openMenu("Some task");
			expect(menuItem("AI 重命名中…")?.disabled).toBe(true);

			await act(async () => {
				release({ ok: true, title: "Done" });
				await gate;
			});
			await flush();
			expect(document.querySelector("#app [role=status]")).toBeNull();
			await openMenu("Some task");
			expect(menuItem("AI 重命名")?.disabled).toBe(false);
		} finally {
			cleanup();
		}
	});

	test("a rejected retitle clears the busy state instead of wedging the menu", async () => {
		const cleanup = await mount(
			<SessionSidebar {...baseProps()} onRetitleSession={() => Promise.reject(new Error("boom"))} />,
		);
		try {
			await openMenu("Some task");
			await act(async () => {
				menuItem("AI 重命名")!.click();
			});
			await flush();
			expect(document.querySelector("#app [role=status]")).toBeNull();
			await openMenu("Some task");
			expect(menuItem("AI 重命名")?.disabled).toBe(false);
			expect(getToasts()[0]?.message).toContain("AI 重命名失败");
		} finally {
			cleanup();
		}
	});
});
