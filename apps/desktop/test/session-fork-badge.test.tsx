import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { t } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { isUserFork, reportSessionHover, SessionHoverCard } from "../src/components/SessionHoverCard";
import { SessionList, type SessionListEntry, type SessionListNode } from "../src/components/SessionList";

const mounted = new Set<Root>();

afterEach(async () => {
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	document.body.innerHTML = "";
	window.localStorage.clear();
});

async function flush(frames = 8): Promise<void> {
	await act(async () => {
		for (let index = 0; index < frames; index++) await Bun.sleep(10);
	});
}

async function mount(ui: React.ReactNode): Promise<{ container: HTMLElement; root: Root }> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	mounted.add(root);
	await act(async () => root.render(ui));
	await flush();
	return { container, root };
}

function entry(id: string, label: string, extra: Partial<SessionListEntry> = {}): SessionListEntry {
	const timestamp = new Date().toISOString();
	return { type: "session", id, parentId: null, timestamp, updatedAt: timestamp, label, ...extra };
}

function node(e: SessionListEntry, children: SessionListNode[] = []): SessionListNode {
	return { entry: e, children };
}

/** A row's own trailing glyphs: the branch marker and the two identity
 *  markers. Each renders with its own accessible name, so the test asks the
 *  row what it carries instead of counting icons. */
function rowGlyphs(container: HTMLElement, label: string): string[] {
	const row = [...container.querySelectorAll<HTMLElement>(".gui-session-row")].find(candidate =>
		candidate.querySelector(".gui-session-title")?.textContent?.includes(label),
	);
	if (!row) throw new Error(`row "${label}" did not render`);
	return [...row.querySelectorAll<HTMLElement>('[role="img"]')].map(
		marker => marker.getAttribute("aria-label") ?? marker.className,
	);
}

describe("isUserFork — the one provenance predicate", () => {
	it("counts a session created by a user fork of another session", () => {
		expect(isUserFork({ parentId: "parent" })).toBe(true);
	});

	it("does not count a top-level session", () => {
		expect(isUserFork({ parentId: null })).toBe(false);
		expect(isUserFork({})).toBe(false);
	});

	it("does not count an advisor transcript, whose parent link is its product directory", () => {
		expect(isUserFork({ parentId: "parent", advisor: true, subagent: true })).toBe(false);
		expect(isUserFork({ parentId: "parent", advisor: true })).toBe(false);
	});

	it("does not count a task subagent spawned by a session", () => {
		expect(isUserFork({ parentId: "parent", subagent: true })).toBe(false);
	});
});

describe("session row fork marker", () => {
	// Four shapes of one tree: a top-level session with three children —
	// a genuine user fork, an advisor transcript, and a task subagent.
	const tree: SessionListNode[] = [
		node(entry("root", "Root session"), [
			node(entry("fork", "Forked child", { parentId: "root" })),
			node(entry("adv", "", { parentId: "root", subagent: true, advisor: true })),
			node(entry("sub", "Child task", { parentId: "root", subagent: true, agentName: "sonic" })),
		]),
	];

	it("marks only the genuine user fork with the branch glyph", async () => {
		const { container } = await mount(<SessionList nodes={tree} selectedId={null} onSelect={() => {}} />);
		const fork = rowGlyphs(container, "Forked child");
		expect(fork).toContain(t("general.forkedSession"));
	});

	it("leaves the advisor transcript without a branch glyph and keeps its advisor identity", async () => {
		const { container } = await mount(<SessionList nodes={tree} selectedId={null} onSelect={() => {}} />);
		// Advisor rows show the advisor label when the transcript has no title.
		const advisor = rowGlyphs(container, t("general.advisorSession"));
		expect(advisor).not.toContain(t("general.forkedSession"));
		expect(advisor).toContain(t("general.advisorSession"));
	});

	it("leaves the subagent without a branch glyph and keeps its agent name badge", async () => {
		const { container } = await mount(<SessionList nodes={tree} selectedId={null} onSelect={() => {}} />);
		const subagent = rowGlyphs(container, "Child task");
		expect(subagent).not.toContain(t("general.forkedSession"));
		expect(subagent).toContain(`${t("general.subagentSession")}: sonic`);
		expect(container.querySelector(".gui-tree-agent")?.textContent).toBe("sonic");
	});

	it("keeps advisor and subagent rows nested under their parent", async () => {
		const { container } = await mount(<SessionList nodes={tree} selectedId={null} onSelect={() => {}} />);
		// Nesting still comes from parentId: three indented guides under Root.
		const rows = [...container.querySelectorAll<HTMLElement>(".gui-session-row")];
		const rootRow = rows[0]!;
		expect(rootRow.textContent).toContain("Root session");
		expect(rows).toHaveLength(4);
		const childGuides = container.querySelectorAll(".gui-tree-guide");
		expect(childGuides.length).toBeGreaterThan(0);
	});

	it("gives a top-level session neither the glyph nor a fork source", async () => {
		const { container } = await mount(<SessionList nodes={tree} selectedId={null} onSelect={() => {}} />);
		const top = rowGlyphs(container, "Root session");
		expect(top).not.toContain(t("general.forkedSession"));
	});
});

describe("session hover card fork line", () => {
	const anchor = new DOMRect(10, 10, 200, 24);

	/** The card portals to document.body, so the assertions read the body. */
	async function hover(payload: Parameters<typeof reportSessionHover>[0]): Promise<HTMLElement> {
		await mount(<SessionHoverCard meta={new Map()} />);
		await act(async () => {
			reportSessionHover(payload);
			// The card shows after ~350ms; the entered flag needs one more frame.
			await Bun.sleep(420);
		});
		await flush();
		const card = document.querySelector<HTMLElement>(".gui-session-hover-card");
		if (!card) throw new Error("hover card did not render");
		return card;
	}

	const base = { id: "s1", label: "Row", timestamp: new Date().toISOString(), anchor };

	it("prints 分叉自 for a genuine user fork", async () => {
		const container = await hover({ ...base, forked: true, parentLabel: "Parent one" });
		expect(container.textContent).toContain(t("general.forkedFromWithName", { name: "Parent one" }));
	});

	it("prints no 分叉自 line for a subagent or advisor row", async () => {
		const subagent = await hover({ ...base, forked: false, parentLabel: "Parent one" });
		expect(subagent.textContent).not.toContain(t("general.forkedFromWithName", { name: "Parent one" }));
	});

	it("prints no 分叉自 line for a top-level session", async () => {
		const top = await hover({ ...base, forked: false, parentLabel: null });
		expect(top.textContent).not.toContain(t("general.forkedFrom"));
	});
});
