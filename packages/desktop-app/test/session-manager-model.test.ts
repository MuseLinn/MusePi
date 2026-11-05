import { describe, expect, it } from "bun:test";
import {
	buildSessionViews,
	clampPage,
	filterViews,
	lastUserPrompt,
	PROJECT_ALL,
	PROJECT_NONE,
	pageSlice,
	pageTotal,
	projectOptions,
	type SessionFilters,
	sortViews,
	toggleAll,
} from "../src/plugins/session-manager/model";
import type { SessionListRow } from "../src/plugins/session-manager/types";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-05T12:00:00.000Z");

function row(id: string, overrides: Partial<SessionListRow> = {}): SessionListRow {
	return {
		id,
		title: `Session ${id}`,
		cwd: "D:/work/alpha",
		timestamp: "2026-10-01T08:00:00.000Z",
		updatedAt: "2026-11-04T08:00:00.000Z",
		messageCount: 3,
		...overrides,
	};
}

function defaults(overrides: Partial<SessionFilters> = {}): SessionFilters {
	return { project: PROJECT_ALL, status: "all", days: 0, query: "", ...overrides };
}

describe("session-manager view model", () => {
	it("keeps the archive status above live activity and drops auxiliary rows", () => {
		const archivedAt = new Map([["archived", NOW - DAY]]);
		const views = buildSessionViews(
			[
				row("archived", { working: true }),
				row("running", { working: true }),
				row("done"),
				row("sub", { subagent: true }),
				row("adv", { advisor: true }),
			],
			archivedAt,
			new Map([
				["D:/work/alpha", "alpha"],
				["D:/work/beta", "beta"],
			]),
		);
		expect(views.map(view => view.id)).toEqual(["archived", "running", "done"]);
		const byId = new Map(views.map(view => [view.id, view]));
		expect(byId.get("archived")?.status).toBe("archived");
		expect(byId.get("archived")?.completedAt).toBe(new Date(NOW - DAY).toISOString());
		expect(byId.get("running")?.status).toBe("running");
		expect(byId.get("running")?.completedAt).toBeNull();
		expect(byId.get("done")?.completedAt).toBe("2026-11-04T08:00:00.000Z");
		// A unique project shows its basename; identity stays the full path.
		expect(byId.get("done")?.project).toBe("alpha");
		expect(byId.get("done")?.cwd).toBe("D:/work/alpha");
	});

	it("widens duplicate basenames and offers an 未指定 project bucket", () => {
		const views = buildSessionViews(
			[row("a", { cwd: "D:/one/demo" }), row("b", { cwd: "D:/two/demo" }), row("c", { cwd: undefined })],
			new Map(),
			new Map([
				["D:/one/demo", "one/demo"],
				["D:/two/demo", "two/demo"],
			]),
		);
		expect(views.map(view => view.project)).toEqual(["one/demo", "two/demo", ""]);
		expect(projectOptions(views).map(option => option.value)).toEqual(["D:/one/demo", "D:/two/demo", PROJECT_NONE]);
	});

	it("filters by project identity, status, activity window and query", () => {
		const views = buildSessionViews(
			[
				row("a", { cwd: "D:/work/alpha", updatedAt: new Date(NOW - DAY).toISOString(), working: true }),
				row("b", { cwd: "D:/work/beta", updatedAt: new Date(NOW - 100 * DAY).toISOString() }),
				row("c", { cwd: "D:/work/beta", updatedAt: new Date(NOW - 2 * DAY).toISOString() }),
			],
			new Map(),
			new Map([
				["D:/work/alpha", "alpha"],
				["D:/work/beta", "beta"],
			]),
		);
		expect(filterViews(views, defaults({ project: "D:/work/beta" }), NOW).map(view => view.id)).toEqual(["b", "c"]);
		expect(filterViews(views, defaults({ status: "running" }), NOW).map(view => view.id)).toEqual(["a"]);
		expect(filterViews(views, defaults({ days: 7 }), NOW).map(view => view.id)).toEqual(["a", "c"]);
		expect(filterViews(views, defaults({ query: "BETA" }), NOW).map(view => view.id)).toEqual(["b", "c"]);
	});

	it("sorts with null times last and a stable id tiebreak", () => {
		const views = buildSessionViews(
			[
				row("b", { updatedAt: "2026-11-01T00:00:00.000Z" }),
				row("a", { updatedAt: "2026-11-03T00:00:00.000Z" }),
				row("z", { updatedAt: undefined, timestamp: undefined }),
			],
			new Map(),
			new Map(),
		);
		expect(sortViews(views, { key: "updatedAt", dir: "desc" }).map(view => view.id)).toEqual(["a", "b", "z"]);
		expect(sortViews(views, { key: "updatedAt", dir: "asc" }).map(view => view.id)).toEqual(["b", "a", "z"]);
		expect(sortViews(views, { key: "title", dir: "asc" }).map(view => view.id)).toEqual(["a", "b", "z"]);
	});

	it("clamps pages, slices rows, and toggles a page selection", () => {
		expect(pageTotal(0)).toBe(1);
		expect(pageTotal(41)).toBe(3);
		expect(clampPage(9, 41)).toBe(3);
		expect(clampPage(0, 41)).toBe(1);
		expect(
			pageSlice(
				Array.from({ length: 25 }, (_, index) => index),
				2,
			),
		).toEqual([20, 21, 22, 23, 24]);
		const all = toggleAll(new Set(["a"]), ["a", "b"]);
		expect([...all].sort()).toEqual(["a", "b"]);
		expect([...toggleAll(all, ["a", "b"])]).toEqual([]);
	});

	it("reads the newest user message from a newest-first page", () => {
		const toText = (content: string): string => content;
		expect(
			lastUserPrompt(
				[
					{ role: "assistant", content: "done" },
					{ role: "user", content: "  second\n prompt " },
					{ role: "user", content: "first prompt" },
				],
				toText,
			),
		).toBe("second prompt");
		expect(lastUserPrompt([{ role: "assistant", content: "done" }], toText)).toBeNull();
		expect(lastUserPrompt([{ role: "user", content: "   " }], toText)).toBeNull();
	});
});
