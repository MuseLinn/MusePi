import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { t } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	CARD_CHROME_HEIGHT,
	fitProjectCard,
	LIST_MAX_HEIGHT,
	ProjectHoverCard,
	ROW_HEIGHT,
} from "../src/components/ProjectHoverCard";
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

	it("survives a scroll of its own directory list", async () => {
		// 12 directories overflow the card's capped list, so scrolling that list
		// is how the user reaches the rest — it must not be the event that
		// dismisses the card. The window listener runs in the capture phase and
		// would otherwise see this scroll too.
		// 11 additional + the root = 12 rows, just past the capped list height.
		const dirs = Array.from({ length: 11 }, (_, i) => `/refs/d${i}`);
		const container = await mountSidebar(
			[project("/work/alpha", "alpha", dirs)],
			[node("s1", "alpha", "/work/alpha")],
		);
		await hoverBlock(container);
		const list = document.querySelector<HTMLElement>(".gui-project-hover-card-list");
		expect(list).not.toBeNull();
		// One card, one list: a stray card from a previous test would make the
		// row count below meaningless.
		expect(document.querySelectorAll(".gui-project-hover-card")).toHaveLength(1);
		await act(async () => {
			list?.dispatchEvent(new Event("scroll", { bubbles: false }));
		});
		await flush(20);
		expect(document.querySelector(".gui-project-hover-card")).not.toBeNull();
		// Root + 11 additional.
		expect(document.querySelectorAll(".gui-project-hover-card-row")).toHaveLength(12);
	});

	it("stays open when focus reaches the last directory's open button", async () => {
		// Focusing a button below the fold scrolls the card's own list, which
		// emits exactly the scroll event the dismissal used to key on.
		// 11 additional + the root = 12 rows, just past the capped list height.
		const dirs = Array.from({ length: 11 }, (_, i) => `/refs/d${i}`);
		const container = await mountSidebar(
			[project("/work/alpha", "alpha", dirs)],
			[node("s1", "alpha", "/work/alpha")],
		);
		await hoverBlock(container);
		expect(document.querySelectorAll(".gui-project-hover-card")).toHaveLength(1);
		const buttons = [...document.querySelectorAll<HTMLButtonElement>(".gui-project-hover-card-open")];
		expect(buttons).toHaveLength(12);
		const last = buttons[11]!;
		await act(async () => {
			last.focus();
			// The browser scrolls the focused element's list into view.
			document.querySelector(".gui-project-hover-card-list")?.dispatchEvent(new Event("scroll", { bubbles: false }));
		});
		await flush(20);
		expect(document.querySelector(".gui-project-hover-card")).not.toBeNull();
		expect(last.isConnected).toBe(true);
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

describe("fitProjectCard — the flip and list-height decision", () => {
	const card = (dirs: number) => CARD_CHROME_HEIGHT + Math.min(dirs * ROW_HEIGHT, LIST_MAX_HEIGHT);

	it("does not flip when the space below holds the whole card", () => {
		const fit = fitProjectCard({ directoryCount: 3, spaceBelow: 400, spaceAbove: 400 });
		expect(fit.above).toBe(false);
		expect(fit.listMax).toBe(3 * ROW_HEIGHT);
	});

	it("flips when the row sits near the bottom and there is room above", () => {
		const fit = fitProjectCard({ directoryCount: 3, spaceBelow: 60, spaceAbove: 500 });
		expect(fit.above).toBe(true);
		expect(fit.listMax).toBe(3 * ROW_HEIGHT);
	});

	it("keeps the more spacious side and bounds the list at a tall window", () => {
		// The reviewer's case: 11 directories; 100px below, 600 above.
		const fit = fitProjectCard({ directoryCount: 11, spaceBelow: 100, spaceAbove: 600 });
		expect(fit.above).toBe(true);
		// 600px above holds the whole card, so the list gets its natural height.
		expect(fit.listMax).toBe(Math.min(11 * ROW_HEIGHT, LIST_MAX_HEIGHT));
	});

	it("bounds the list by the available space when neither side fits the card", () => {
		// 11 directories (~324px) in an 800px window, row 60px above the bottom.
		const fit = fitProjectCard({ directoryCount: 11, spaceBelow: 60, spaceAbove: 700 });
		expect(fit.above).toBe(true);
		// Flips up, and the list is capped by the room above, not the natural height.
		expect(fit.listMax).toBeLessThanOrEqual(700 - 8);
	});

	it("never lets the card exceed the space on the chosen side (sweep)", () => {
		// Same shape as the review's sweep: 11 directories, rows across the
		// scroller, several window heights. Every position must fit.
		for (const windowHeight of [480, 700, 800, 1000]) {
			const rowBottom = 40;
			for (let offset = 0; offset <= windowHeight; offset += 10) {
				const top = rowBottom + offset;
				const bottom = top + 28;
				const spaceBelow = Math.max(0, windowHeight - bottom);
				const spaceAbove = Math.max(0, top - 40);
				if (spaceBelow <= 0 && spaceAbove <= 0) continue;
				const fit = fitProjectCard({ directoryCount: 11, spaceBelow, spaceAbove });
				const room = Math.max(0, (fit.above ? spaceAbove : spaceBelow) - 8);
				const rendered = CARD_CHROME_HEIGHT + fit.listMax;
				expect(rendered).toBeLessThanOrEqual(room + 0.01);
			}
		}
	});

	it("falls back to the natural list when no measurement is available", () => {
		const fit = fitProjectCard({ directoryCount: 4 });
		expect(fit.above).toBe(false);
		expect(fit.listMax).toBe(4 * ROW_HEIGHT);
	});

	it("caps the natural list at LIST_MAX_HEIGHT regardless of directory count", () => {
		const fit = fitProjectCard({ directoryCount: 64, spaceBelow: 5000, spaceAbove: 5000 });
		expect(fit.listMax).toBe(LIST_MAX_HEIGHT);
	});

	it("reserves at least the tallest chrome the card can show", () => {
		// Chromium measures 82.55px of fixed chrome at the narrowest English
		// width (168px sidebar), where the count line wraps to two rows, and
		// 66.05px everywhere else. The constant must cover the worst case:
		// under-reserving lets the card overflow its scroller, over-reserving
		// only costs whitespace, which `measuredShrink` gives back.
		expect(CARD_CHROME_HEIGHT).toBeGreaterThanOrEqual(82.55);
	});
});

describe("ProjectHoverCard flip rendering", () => {
	async function render(props: { count: number; spaceBelow?: number; spaceAbove?: number }): Promise<HTMLElement> {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		mounted.add(root);
		await act(async () =>
			root.render(
				<ProjectHoverCard
					name="alpha"
					directories={Array.from({ length: props.count }, (_, i) => ({
						path: `/refs/d${i}`,
						primary: i === 0,
					}))}
					sessionCount={0}
					labelOf={path => path.split("/").pop() ?? path}
					onOpenDirectory={() => {}}
					openLabel={t("settings.openInExplorer")}
					spaceBelow={props.spaceBelow}
					spaceAbove={props.spaceAbove}
				/>,
			),
		);
		await flush();
		return host;
	}

	it("renders the flip modifier when the row is near the bottom", async () => {
		const host = await render({ count: 3, spaceBelow: 60, spaceAbove: 500 });
		expect(host.querySelector(".gui-project-hover-card--above")).not.toBeNull();
	});

	it("stays anchored below when there is room", async () => {
		const host = await render({ count: 3, spaceBelow: 500, spaceAbove: 60 });
		expect(host.querySelector(".gui-project-hover-card--above")).toBeNull();
	});

	it("passes the available space as the list's max height so the last row is reachable", async () => {
		// 11 rows (264px) + chrome cannot fit in 240px: the list must be clamped
		// and scroll, which keeps the last directory's open button reachable.
		const host = await render({ count: 11, spaceBelow: 240, spaceAbove: 40 });
		const cardEl = host.querySelector<HTMLElement>(".gui-project-hover-card");
		expect(cardEl).not.toBeNull();
		const raw = cardEl!.style.getPropertyValue("--gui-project-list-max");
		expect(raw).toMatch(/px$/);
		const listMax = Number.parseFloat(raw);
		expect(listMax).toBeLessThan(11 * ROW_HEIGHT);
		// Bounded by the room below minus the card's fixed chrome.
		expect(listMax).toBeLessThanOrEqual(240 - 8 - CARD_CHROME_HEIGHT);
		// Every row still renders inside that scrollable list.
		const rows = host.querySelectorAll(".gui-project-hover-card-row");
		expect(rows).toHaveLength(11);
		expect(host.querySelector(".gui-project-hover-card-list")?.contains(rows[10]!)).toBe(true);
	});
});
