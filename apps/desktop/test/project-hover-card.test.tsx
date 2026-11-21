import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { t } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ProjectHoverCard } from "../src/components/ProjectHoverCard";
import type { SessionListNode } from "../src/components/SessionList";
import { SessionSidebar } from "../src/components/SessionSidebar";

const mounted = new Set<Root>();

afterEach(async () => {
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	document.body.innerHTML = "";
	window.localStorage.clear();
	delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

async function flush(frames = 6): Promise<void> {
	await act(async () => {
		for (let index = 0; index < frames; index++) await Bun.sleep(10);
	});
}

function node(id: string, label: string, cwd: string): SessionListNode {
	const timestamp = new Date().toISOString();
	return { entry: { type: "session", id, parentId: null, timestamp, updatedAt: timestamp, label }, children: [] };
}

interface ProjectRow {
	id: string;
	root: string;
	name: string;
	kind: "managed" | "implicit";
	additionalDirs: string[];
	createdAt: number;
	lastOpenedAt: number;
}

function project(root: string, name: string, additionalDirs: string[] = []): ProjectRow {
	return { id: `id-${root}`, root, name, kind: "managed", additionalDirs, createdAt: 0, lastOpenedAt: 0 };
}

function sidebar(nodes: SessionListNode[], meta: Map<string, { cwd?: string }>, rpc: unknown): React.ReactNode {
	return (
		<SessionSidebar
			nodes={nodes}
			sessionMeta={meta}
			selectedId={null}
			rpc={rpc as never}
			onSelect={() => {}}
			onNewSession={() => {}}
			onDisconnect={() => {}}
			onOpenConnect={() => {}}
			onOpenSettings={() => {}}
			onOpenSearch={() => {}}
			collapsed={false}
			onDeleteArchived={async () => true}
			connected
			daemonUrl="ws://localhost:8300"
			onReconnect={() => {}}
			hosts={[]}
			onSwitchHost={() => {}}
			onAddHost={() => {}}
			onRemoveHost={() => {}}
		/>
	);
}

function rpcFor(rows: ProjectRow[]): unknown {
	return {
		async request<T>(method: string): Promise<T> {
			switch (method) {
				case "workspace.list":
					return { workspaces: rows } as T;
				case "fs.stat":
					return { exists: true, isDirectory: true } as T;
				default:
					throw new Error(`unexpected RPC: ${method}`);
			}
		},
	};
}

async function mountSidebar(rows: ProjectRow[], nodes: SessionListNode[]): Promise<HTMLElement> {
	window.localStorage.setItem("musepi-gui-sidebar-tab", "projects");
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	mounted.add(root);
	const meta = new Map(nodes.map(n => [n.entry.id, { cwd: `/work/${n.entry.label}` }]));
	await act(async () => root.render(sidebar(nodes, meta, rpcFor(rows))));
	await flush();
	return container;
}

async function hoverBlock(container: HTMLElement): Promise<void> {
	const block = container.querySelector<HTMLElement>(".gui-project-block");
	expect(block).not.toBeNull();
	await act(async () => {
		// React synthesizes mouseenter from the delegated `mouseover`.
		block?.querySelector(".gui-project-head")?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
	});
	await flush();
}

describe("project hover card", () => {
	it("lists every directory of a multi-root project with the primary marked", async () => {
		const container = await mountSidebar(
			[project("/work/alpha", "alpha", ["/refs/alpha-docs", "/refs/shared"])],
			[node("s1", "alpha", "/work/alpha")],
		);
		expect(container.querySelector(".gui-project-hover-card")).toBeNull();
		await hoverBlock(container);

		const card = document.querySelector<HTMLElement>(".gui-project-hover-card");
		expect(card).not.toBeNull();
		const rows = [...card!.querySelectorAll<HTMLElement>(".gui-project-hover-card-row")];
		expect(rows).toHaveLength(3);
		// Basenames, not full paths — the full path stays on the row title.
		expect(rows.map(row => row.querySelector(".gui-project-hover-card-text")?.textContent)).toEqual([
			"alpha",
			"alpha-docs",
			"shared",
		]);
		// Exactly one primary marker, on the project root.
		const chips = [...card!.querySelectorAll<HTMLElement>(".gui-project-hover-card-chip")];
		expect(chips).toHaveLength(1);
		expect(rows[0]!.contains(chips[0]!)).toBe(true);
		expect(chips[0]!.textContent).toBe(t("settings.primaryDirectory"));
		// Directory count + the project's session count.
		expect(card!.textContent).toContain(t("general.projectDirectoryCount", { count: 3 }));
		expect(card!.textContent).toContain(t("settings.sessionCountLabel", { count: 1 }));
	});

	it("opens a directory from its row action", async () => {
		const opened: string[] = [];
		(window as unknown as { electronAPI?: unknown }).electronAPI = {
			platform: "win32",
			openPath: async (path: string) => {
				opened.push(path);
				return { ok: true };
			},
		};
		const container = await mountSidebar(
			[project("/work/alpha", "alpha", ["/refs/shared"])],
			[node("s1", "alpha", "/work/alpha")],
		);
		await hoverBlock(container);
		const openButtons = [...document.querySelectorAll<HTMLButtonElement>(".gui-project-hover-card-open")];
		expect(openButtons).toHaveLength(2);
		await act(async () => openButtons[1]!.click());
		await flush();
		expect(opened).toEqual(["/refs/shared"]);
	});

	it("stays closed for a single-directory project until hover, and closes on Escape", async () => {
		const container = await mountSidebar([project("/work/solo", "solo")], [node("s1", "solo", "/work/solo")]);
		expect(container.querySelector(".gui-project-hover-card")).toBeNull();
		await hoverBlock(container);
		expect(document.querySelector(".gui-project-hover-card")).not.toBeNull();
		await act(async () => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		});
		await flush();
		expect(document.querySelector(".gui-project-hover-card")).toBeNull();
	});

	it("closes once the pointer leaves the block for somewhere outside it", async () => {
		const container = await mountSidebar([project("/work/solo", "solo")], [node("s1", "solo", "/work/solo")]);
		await hoverBlock(container);
		const block = container.querySelector<HTMLElement>(".gui-project-block");
		expect(block).not.toBeNull();
		// A real pointer exit: `relatedTarget` outside the block and its card.
		await act(async () => {
			block?.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
		});
		await flush(20);
		expect(document.querySelector(".gui-project-hover-card")).toBeNull();
	});

	// The structural contracts the placement bug broke. Asserting the card exists
	// in `document` was not enough: it rendered as a SIBLING of the block, so
	// `top:100%` resolved against the scroll frame, the scroller clipped it to a
	// couple of pixels, and the block's containment no longer covered it.
	it("renders the card inside the project block, positioned against it", async () => {
		const container = await mountSidebar(
			[project("/work/alpha", "alpha", ["/refs/shared"])],
			[node("s1", "alpha", "/work/alpha")],
		);
		await hoverBlock(container);
		const block = container.querySelector<HTMLElement>(".gui-project-block");
		const card = document.querySelector<HTMLElement>(".gui-project-hover-card");
		expect(block).not.toBeNull();
		expect(card).not.toBeNull();
		// (a) containment: block-bound pointer/focus handlers must cover the card.
		expect(block!.contains(card!)).toBe(true);
		// The card is the block's own child, so an absolutely positioned card
		// resolves `top:100%` against the block (which declares position:
		// relative) instead of the scroll frame. happy-dom implements neither
		// `offsetParent` nor layout geometry, so parent identity is the available
		// proxy for the containing block.
		expect(card!.parentElement).toBe(block);
		// And it is not inside the collapsible body that clips to the row height.
		expect(card!.closest(".gui-collapse")).toBeNull();
	});

	it("survives a pointer path from the block toward the card", async () => {
		const container = await mountSidebar(
			[project("/work/alpha", "alpha", ["/refs/shared"])],
			[node("s1", "alpha", "/work/alpha")],
		);
		await hoverBlock(container);
		const block = container.querySelector<HTMLElement>(".gui-project-block");
		const card = document.querySelector<HTMLElement>(".gui-project-hover-card");
		expect(card).not.toBeNull();
		// (b) Moving onto the card fires `mouseout` on the block child with the
		// card as relatedTarget — the browser's own block→card transition.
		await act(async () => {
			block
				?.querySelector(".gui-project-head")
				?.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: card }));
		});
		await flush(20);
		expect(document.querySelector(".gui-project-hover-card")).not.toBeNull();
	});

	it("keeps the card open when focus moves to one of its buttons", async () => {
		const container = await mountSidebar(
			[project("/work/alpha", "alpha", ["/refs/shared"])],
			[node("s1", "alpha", "/work/alpha")],
		);
		await hoverBlock(container);
		const block = container.querySelector<HTMLElement>(".gui-project-block");
		const open = document.querySelector<HTMLButtonElement>(".gui-project-hover-card-open");
		expect(open).not.toBeNull();
		// (c) Tab into the card: focusout's relatedTarget is a card button, which
		// the block contains, so the 120ms grace must not start.
		await act(async () => {
			block
				?.querySelector(".gui-project-head")
				?.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: open }));
		});
		await flush(20);
		expect(document.querySelector(".gui-project-hover-card")).not.toBeNull();
		expect(block!.contains(document.activeElement === open ? open : block)).toBe(true);
	});

	it("closes when the session list scrolls under it", async () => {
		const container = await mountSidebar([project("/work/solo", "solo")], [node("s1", "solo", "/work/solo")]);
		await hoverBlock(container);
		expect(document.querySelector(".gui-project-hover-card")).not.toBeNull();
		await act(async () => {
			container.querySelector(".gui-sessions-list")?.dispatchEvent(new Event("scroll", { bubbles: false }));
		});
		await flush();
		expect(document.querySelector(".gui-project-hover-card")).toBeNull();
	});
});

describe("ProjectHoverCard component", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("keeps every directory row reachable and labelled", async () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		mounted.add(root);
		await act(async () =>
			root.render(
				<ProjectHoverCard
					name="alpha"
					directories={[
						{ path: "/work/alpha", primary: true },
						{ path: "/refs/shared", primary: false },
					]}
					sessionCount={4}
					labelOf={path => path.split("/").pop() ?? path}
					onOpenDirectory={() => {}}
					openLabel={t("settings.openInExplorer")}
				/>,
			),
		);
		const buttons = [...container.querySelectorAll<HTMLButtonElement>(".gui-project-hover-card-open")];
		expect(buttons).toHaveLength(2);
		for (const button of buttons) {
			expect(button.getAttribute("aria-label")).toContain(t("settings.openInExplorer"));
		}
		// No open handler -> no dead buttons.
		const noAction = document.createElement("div");
		document.body.appendChild(noAction);
		const second = createRoot(noAction);
		mounted.add(second);
		await act(async () =>
			second.render(
				<ProjectHoverCard
					name="beta"
					directories={[{ path: "/work/beta", primary: true }]}
					sessionCount={0}
					labelOf={path => path}
					openLabel={t("settings.openInExplorer")}
				/>,
			),
		);
		expect(noAction.querySelector(".gui-project-hover-card-open")).toBeNull();
	});
});
