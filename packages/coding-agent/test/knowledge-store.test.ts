import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
	createNote,
	createTodo,
	deleteTodo,
	getPlan,
	importLegacyTodos,
	listPlans,
	listTodos,
	readKnowledge,
	replaceTodos,
	savePlan,
	updateTodo,
} from "@musepi/pi-coding-agent/knowledge/store";
import { getAgentDir, setAgentDir } from "@musepi/pi-utils/dirs";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "./helpers/isolate-agent-dir";

/**
 * Project knowledge store — the one owner of notes, todos and plans.
 *
 * The contract that motivated the module: todos were in the GUI's localStorage,
 * so the AGENT could not read them and a session with no window (a scheduled
 * task, a dispatched subagent) had nothing to read. These tests pin the
 * behaviours that made the move safe and that the tool/panel depend on:
 *
 *  - the legacy import adopts old localStorage todos once, preserving ids and
 *    never duplicating one that already exists (the panel deletes its keys only
 *    after this succeeds, so a re-run must be a no-op);
 *  - order is preserved by `replaceTodos` because the panel RENDERS that order
 *    (new items before the first completed one, completed items last);
 *  - the three kinds are isolated — a write to one never disturbs another.
 */

// A fresh project per case: every test shares one isolated agent dir, so a
// fixed cwd would let one case's todos/notes leak into the next through the
// same per-project files.
let CWD = "";
const freshProject = (): void => {
	CWD = `C:\\proj-knowledge-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
};
let isolated: string;
let original: string | undefined;

beforeAll(async () => {
	original = getAgentDir();
	isolated = await isolateAgentDirForTest("knowledge-store-test-");
	setAgentDir(isolated);
}, 30_000);

afterAll(async () => {
	if (original !== undefined) setAgentDir(original);
	await restoreAgentDirForTest(isolated);
}, 30_000);

beforeEach(() => {
	freshProject();
});

describe("todos", () => {
	it("creates, ticks and deletes, with `done` settable without resending the text", async () => {
		const todo = await createTodo(CWD, "ship it");
		expect(todo.done).toBe(false);

		// The panel's checkbox sends only `done`; retyping the label would drift.
		const ticked = await updateTodo(CWD, todo.id, { done: true });
		expect(ticked?.done).toBe(true);
		expect(ticked?.text).toBe("ship it");

		expect(await deleteTodo(CWD, todo.id)).toBe(true);
		expect(await listTodos(CWD)).toHaveLength(0);
	});

	it("rejects blank text instead of storing an empty row", async () => {
		await expect(createTodo(CWD, "   ")).rejects.toThrow();
	});

	it("preserves the exact order the panel rendered", async () => {
		// The panel's order is user-visible: a new todo lands before the first
		// completed one, and completing moves the item to the end.
		const order = [
			{ id: "a", text: "first", done: false, createdAt: 1 },
			{ id: "b", text: "second", done: false, createdAt: 2 },
			{ id: "c", text: "done one", done: true, createdAt: 3 },
		];
		const saved = await replaceTodos(CWD, order);
		expect(saved.map(t => t.id)).toEqual(["a", "b", "c"]);
		expect((await listTodos(CWD)).map(t => t.id)).toEqual(["a", "b", "c"]);
	});

	it("drops malformed rows from a wholesale replace rather than persisting them", async () => {
		// A blank-text or id-less row would render as an unclickable ghost.
		await replaceTodos(CWD, [
			{ id: "ok", text: "keep", done: false, createdAt: 1 },
			{ id: "", text: "no id", done: false, createdAt: 2 },
			{ id: "blank", text: "   ", done: false, createdAt: 3 },
		]);
		expect((await listTodos(CWD)).map(t => t.id)).toEqual(["ok"]);
	});
});

describe("legacy localStorage import", () => {
	it("adopts old rows with their ids, and a second run imports nothing", async () => {
		const legacy = [
			{ id: "old-1", text: "from localStorage", done: true, createdAt: 111 },
			{ id: "old-2", text: "also old", done: false, createdAt: 222 },
		];
		const first = await importLegacyTodos(CWD, legacy);
		expect(first.imported).toBe(2);
		expect((await listTodos(CWD)).map(t => t.id)).toEqual(["old-1", "old-2"]);

		// Idempotent: the panel retries when a migration failed midway, and a
		// duplicate would show the same todo twice.
		const second = await importLegacyTodos(CWD, legacy);
		expect(second.imported).toBe(0);
		expect(await listTodos(CWD)).toHaveLength(2);
	});

	it("skips a legacy row whose id already exists in the daemon list", async () => {
		await replaceTodos(CWD, [{ id: "shared", text: "daemon copy wins", done: false, createdAt: 1 }]);
		const result = await importLegacyTodos(CWD, [{ id: "shared", text: "old copy", done: true }]);
		expect(result.imported).toBe(0);
		expect((await listTodos(CWD))[0]?.text).toBe("daemon copy wins");
	});

	it("ignores garbage shapes instead of throwing", async () => {
		// The old key was written by the GUI and could hold anything.
		const result = await importLegacyTodos(CWD, [
			{ id: 42, text: 123 } as unknown as { id?: unknown; text?: unknown },
			{ text: "no id" },
			{ id: "ok", text: "valid" },
		]);
		expect(result.imported).toBe(1);
		expect((await listTodos(CWD)).map(t => t.text)).toEqual(["valid"]);
	});
});

describe("three kinds stay independent", () => {
	it("writing a todo leaves notes and plans untouched", async () => {
		await createNote(CWD, "a note");
		await savePlan(CWD, "# A plan\n\nbody");
		await createTodo(CWD, "a todo");

		const snapshot = await readKnowledge(CWD);
		expect(snapshot.notes).toHaveLength(1);
		expect(snapshot.todos).toHaveLength(1);
		expect(snapshot.plans).toHaveLength(1);
		expect(snapshot.notes[0]?.body).toBe("a note");
		expect(snapshot.plans[0]?.title).toBe("A plan");
	});

	it("a plan's title comes from its `# heading`, never a separate argument", async () => {
		const plan = await savePlan(CWD, "# Release plan\n\n1. freeze\n2. tag");
		expect(plan.title).toBe("Release plan");
		// Replacing keeps the id and re-derives the title from the new body.
		const updated = await savePlan(CWD, "# Renamed plan\n\nnew body", plan.id);
		expect(updated.id).toBe(plan.id);
		expect(updated.title).toBe("Renamed plan");
		expect((await getPlan(CWD, plan.id))?.body).toContain("new body");
		expect(await listPlans(CWD)).toHaveLength(1);
	});

	it("rejects ids that could escape the store directory", async () => {
		await expect(savePlan(CWD, "# x", "../escape")).rejects.toThrow();
	});
});
