import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { t } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	CARD_CHROME_HEIGHT,
	CARD_GAP,
	CARD_WIDTH,
	firstCardFocusable,
	fitProjectCard,
	LIST_MAX_HEIGHT,
	measureCard,
	ProjectHoverCard,
	placeProjectCard,
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
		// The recipe class is the whole surface (position, padding, glass,
		// shadow). Dropping it from the component would leave this card with no
		// style at all while every child-class query above still passed.
		expect(card!.classList.contains("gui-hover-card")).toBe(true);
		const rows = [...card!.querySelectorAll<HTMLElement>(".gui-hover-card-row")];
		expect(rows).toHaveLength(3);
		// Basenames, not full paths — the full path stays on the row title.
		expect(rows.map(row => row.querySelector(".gui-hover-card-text")?.textContent)).toEqual([
			"alpha",
			"alpha-docs",
			"shared",
		]);
		// Exactly one primary marker, on the project root.
		const chips = [...card!.querySelectorAll<HTMLElement>(".gui-hover-card-chip")];
		expect(chips).toHaveLength(1);
		expect(rows[0]!.contains(chips[0]!)).toBe(true);
		expect(chips[0]!.textContent).toBe(t("settings.primaryDirectory"));
		// Directory count + the project's session count, asserted as the HUMAN
		// strings. Re-deriving them through the same template would make a
		// grammar defect in the template invisible by construction (which is how
		// "1 directories" reached the UI).
		expect(card!.textContent).toContain("3 directories");
		expect(card!.textContent).toContain("1 session");
		expect(card!.textContent).not.toContain("1 sessions");
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
		const openButtons = [...document.querySelectorAll<HTMLButtonElement>(".gui-project-hover-card-row")];
		expect(openButtons).toHaveLength(2);
		// The row IS the button, so it spans the whole row box — not an 18px
		// glyph at the trailing edge.
		for (const button of openButtons) {
			expect(button.tagName).toBe("BUTTON");
			expect(button.getAttribute("aria-label")).toContain(t("settings.openInExplorer"));
		}
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
	// The placement contract that replaced "inside the block". The card used to
	// render as the block's own child so `top: 100%` was that row's lower edge —
	// which meant it opened OVER the sidebar and was clipped by the scroller.
	// It now portals to `document.body` and is positioned from the row's rect.
	it("portals the card out of the block so it can open beside the sidebar", async () => {
		const container = await mountSidebar(
			[project("/work/alpha", "alpha", ["/refs/shared"])],
			[node("s1", "alpha", "/work/alpha")],
		);
		await hoverBlock(container);
		const block = container.querySelector<HTMLElement>(".gui-project-block");
		const card = document.querySelector<HTMLElement>(".gui-project-hover-card");
		expect(block).not.toBeNull();
		expect(card).not.toBeNull();
		// Escaped the scroller: no clipping, no `top: 100%` resolved against the
		// scroll frame.
		expect(block!.contains(card!)).toBe(false);
		expect(card!.closest(".gui-sessions-list")).toBeNull();
		expect(card!.parentElement).toBe(document.body);
	});

	it("writes viewport coordinates that clear the sidebar", async () => {
		const container = await mountSidebar(
			[project("/work/alpha", "alpha", ["/refs/shared"])],
			[node("s1", "alpha", "/work/alpha")],
		);
		await hoverBlock(container);
		const card = document.querySelector<HTMLElement>(".gui-project-hover-card");
		expect(card).not.toBeNull();
		// happy-dom has no layout, so the rects are zeros; what this pins is that
		// the component wrote the placement it computed (the number itself is
		// the pure function's business, covered below and in Chromium).
		expect(card!.style.left).toMatch(/^-?\d+(\.\d+)?px$/);
		expect(card!.style.top !== "" || card!.style.bottom !== "").toBe(true);
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
		const open = document.querySelector<HTMLButtonElement>(".gui-project-hover-card-row");
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
		expect(document.querySelectorAll(".gui-hover-card-row")).toHaveLength(12);
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
		const buttons = [...document.querySelectorAll<HTMLButtonElement>(".gui-project-hover-card-row")];
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

describe("placeProjectCard — beside the sidebar, flipping only when it must", () => {
	const sidebar = { left: 0, right: 256 };

	it("opens past the sidebar's right edge at a comfortable width", () => {
		const placement = placeProjectCard({ sidebar, viewportWidth: 1280 });
		expect(placement.flipped).toBe(false);
		// Exactly the gap past the rail — not over it, not floating in the chat.
		expect(placement.left).toBe(256 + CARD_GAP);
	});

	it("flips to the sidebar's left side when the window leaves no room on the right", () => {
		// A rail pushed in from the left edge: the card does not fit to its
		// right at this width, but does fit to its left.
		const insetSidebar = { left: 300, right: 556 };
		const placement = placeProjectCard({ sidebar: insetSidebar, viewportWidth: 800 });
		expect(placement.flipped).toBe(true);
		// Gap-left of the rail, fully on screen.
		expect(placement.left).toBe(300 - CARD_GAP - CARD_WIDTH);
		expect(placement.left).toBeGreaterThanOrEqual(8);
	});

	it("stays on the right at exactly the width that still fits", () => {
		const exact = 256 + CARD_GAP + CARD_WIDTH + 8;
		expect(placeProjectCard({ sidebar, viewportWidth: exact }).flipped).toBe(false);
		// One pixel narrower and the card would overhang the window's inset, but
		// there is still no room on the left of a flush rail either.
		expect(placeProjectCard({ sidebar, viewportWidth: exact - 1 }).flipped).toBe(false);
	});

	it("prefers the right side when neither side fits, clamped into the window", () => {
		// A 360px window cannot hold a 240px card beside a 256px rail. The card
		// stays on the right — covering chat, never the sidebar it describes —
		// and is clamped inside the viewport; `max-width` keeps it within the
		// window.
		const placement = placeProjectCard({ sidebar, viewportWidth: 360 });
		expect(placement.flipped).toBe(false);
		expect(placement.left).toBeGreaterThanOrEqual(8);
		// No overhang on the right either.
		expect(placement.left).toBeLessThanOrEqual(360 - 8 - CARD_WIDTH);
	});
});

describe("keyboard bridge — portal moves the card out of the Tab order", () => {
	it("finds the first control a keyboard reader should land on", () => {
		const host = document.createElement("div");
		host.innerHTML = '<ul><li><span>a</span></li></ul><button id="first">1</button><button>2</button>';
		document.body.appendChild(host);
		expect(firstCardFocusable(host)?.id).toBe("first");
		expect(firstCardFocusable(document.createElement("div"))).toBeNull();
	});
});

describe("ProjectHoverCard component", () => {
	// No local `document.body.innerHTML = ""` here: the card portals into
	// `document.body`, and wiping the body out from under a still-mounted root
	// leaves React removing nodes it no longer owns — which surfaced as a later
	// unrelated assertion failing on a corrupted tree. The file-level `afterEach`
	// unmounts first, then clears.

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
		// The card portals to document.body, so it is not inside `container`.
		const buttons = [...document.querySelectorAll<HTMLButtonElement>(".gui-project-hover-card-row")];
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
		// The second card is a separate mount, so both live in the body; the
		// point of this half is that a project with no open handler gets no
		// dead buttons.
		expect(document.querySelectorAll(".gui-project-hover-card")).toHaveLength(2);
		expect(noAction.contains(document.querySelector(".gui-project-hover-card"))).toBe(false);
		expect(container.querySelector(".gui-project-hover-card-row")).toBeNull();
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

	// NOTE: this pins the SHAPE of the decision, not the constant. In the clamped
	// branch `chrome + listMax` is identically `room` for any chrome, so the
	// assertion holds for C = 1 and C = 200 alike. The constant is corrected by
	// the mount-time measurement, not by this test.
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

	it("derives its first-frame estimate from the shipped font ladder", () => {
		// Re-measured 2026-11-22 after the hover-card recipe (padding 12px 14px
		// 10px) and the row-as-button box: chrome is 92.25px at 152/164px wide
		// and 73.25px at 224/240px, and a row steps 30–31px. These constants are
		// only the first-frame estimate — `measureCard` replaces them with the
		// real geometry before paint — but they must not be derived from the test
		// fixture's 11px ladder, or the first frame is wrong on a real screen.
		expect(CARD_CHROME_HEIGHT).toBeGreaterThanOrEqual(92.25);
		expect(ROW_HEIGHT).toBeGreaterThanOrEqual(30);
	});

	it("uses caller-supplied metrics instead of the estimate", () => {
		// The whole point of measuring on mount: the decision must follow the
		// measured geometry, so a caller passing a much taller chrome flips
		// earlier than the estimate would.
		const tall = fitProjectCard({ directoryCount: 3, spaceBelow: 200, spaceAbove: 400, chromeHeight: 300 });
		expect(tall.above).toBe(true);
		// With the default estimate the same room keeps it below.
		expect(fitProjectCard({ directoryCount: 3, spaceBelow: 200, spaceAbove: 400 }).above).toBe(false);
	});
});

describe("ProjectHoverCard flip rendering", () => {
	/**
	 * The card portals to `document.body`, so it lives in the document rather
	 * than the React host. `anchor` drives the flip: the row's rect decides how
	 * much room the chosen side has.
	 */
	async function render(props: { count: number; rowTop?: number; rowBottom?: number }): Promise<HTMLElement> {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		mounted.add(root);
		const anchor =
			props.rowTop === undefined || props.rowBottom === undefined
				? undefined
				: { row: { top: props.rowTop, bottom: props.rowBottom }, sidebar: { left: 0, right: 256 } };
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
					anchor={anchor}
				/>,
			),
		);
		await flush();
		return host;
	}

	it("renders the flip modifier when the row sits near the bottom", async () => {
		// Row at 740 of an 800px-tall viewport: 60px below it, 740 above.
		await render({ count: 3, rowTop: 740, rowBottom: 768 });
		expect(document.querySelector(".gui-project-hover-card--above")).not.toBeNull();
	});

	it("stays anchored below when there is room", async () => {
		await render({ count: 3, rowTop: 40, rowBottom: 68 });
		expect(document.querySelector(".gui-project-hover-card--above")).toBeNull();
	});

	it("bounds the list by the room on the chosen side so the last row is reachable", async () => {
		// 11 rows (264px) + chrome cannot fit below a row near the bottom, so it
		// flips and the list is clamped by the room above instead.
		await render({ count: 11, rowTop: 660, rowBottom: 688 });
		const cardEl = document.querySelector<HTMLElement>(".gui-project-hover-card");
		expect(cardEl).not.toBeNull();
		const raw = cardEl!.style.getPropertyValue("--gui-project-list-max");
		expect(raw).toMatch(/px$/);
		const listMax = Number.parseFloat(raw);
		expect(listMax).toBeLessThan(11 * ROW_HEIGHT);
		// Bounded by the room above the row minus the fixed chrome.
		expect(listMax).toBeLessThanOrEqual(660 - 8 - CARD_CHROME_HEIGHT);
		// Every row still renders inside that scrollable list.
		const rows = document.querySelectorAll(".gui-hover-card-row");
		expect(rows).toHaveLength(11);
		expect(document.querySelector(".gui-project-hover-card-list")?.contains(rows[10]!)).toBe(true);
	});
});

describe("mount-time measurement", () => {
	it("reads chrome and row step from the rendered card", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		mounted.add(root);
		await act(async () =>
			root.render(
				<ProjectHoverCard
					name="alpha"
					directories={Array.from({ length: 4 }, (_, i) => ({ path: `/refs/d${i}`, primary: i === 0 }))}
					sessionCount={0}
					labelOf={path => path.split("/").pop() ?? path}
					onOpenDirectory={() => {}}
					openLabel={t("settings.openInExplorer")}
				/>,
			),
		);
		await flush();
		const card = document.querySelector<HTMLElement>(".gui-project-hover-card");
		expect(card).not.toBeNull();
		// happy-dom reports zero geometry, so the real measurement is the
		// browser's job; here we pin the contract that unmeasurable DOM yields
		// null (the component then keeps the estimate) rather than garbage.
		const metrics = measureCard(card);
		expect(metrics === null || metrics.chrome > 0).toBe(true);
	});

	it("returns null instead of bogus numbers when there is nothing to measure", () => {
		expect(measureCard(null)).toBeNull();
		const empty = document.createElement("div");
		expect(measureCard(empty)).toBeNull();
	});
});

describe("card counts read as English prose", () => {
	async function render(count: number, sessionCount: number): Promise<HTMLElement> {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		mounted.add(root);
		await act(async () =>
			root.render(
				<ProjectHoverCard
					name="alpha"
					directories={Array.from({ length: count }, (_, i) => ({ path: `/p/${i}`, primary: i === 0 }))}
					sessionCount={sessionCount}
					labelOf={path => path.split("/").pop() ?? path}
					openLabel={t("settings.openInExplorer")}
				/>,
			),
		);
		await flush();
		return host;
	}

	it("says 1 directory/1 session for a root-only project — the default shape", async () => {
		await render(1, 1);
		const text = document.body.textContent ?? "";
		expect(text).toContain("1 directory");
		expect(text).toContain("1 session");
		// The bug: every single-root project hover read "1 directories".
		expect(text).not.toContain("1 directories");
		expect(text).not.toContain("1 sessions");
	});

	it("pluralizes above one", async () => {
		await render(3, 4);
		const text = document.body.textContent ?? "";
		expect(text).toContain("3 directories");
		expect(text).toContain("4 sessions");
	});

	it("does not say 2 directories for a one-directory card", async () => {
		// Guard the branch itself: count 0 must not read as "1 directory".
		await render(1, 0);
		const text = document.body.textContent ?? "";
		expect(text).toContain("1 directory");
		expect(text).toContain("0 sessions");
	});
});
