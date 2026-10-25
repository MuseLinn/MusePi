import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { type SettingPath, Settings } from "@musepi/pi-coding-agent/config/settings";
import { projectSlug } from "@musepi/pi-coding-agent/knowledge/store";
import { createTools, type ToolSession } from "@musepi/pi-coding-agent/tools";
import { KnowledgeTool } from "@musepi/pi-coding-agent/tools/knowledge";
import { getAgentDir, setAgentDir } from "@musepi/pi-utils/dirs";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "./helpers/isolate-agent-dir";

/**
 * `knowledge` tool — the agent's access to project notes, todos and plans.
 *
 * The failure this defends: before the tool existed, notes and plans were
 * daemon-only RPC and todos were in the GUI's localStorage, so the agent could
 * reach NONE of them. Every assertion below is about what a model observes
 * (listed content, created ids, error on a bad call) rather than internals.
 */

let isolated: string;
let original: string | undefined;
let CWD = "";

function makeSession(overrides: Partial<Record<SettingPath, unknown>> = {}): ToolSession {
	return {
		cwd: CWD,
		hasUI: false,
		skipPythonPreflight: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(overrides),
	};
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

beforeAll(async () => {
	original = getAgentDir();
	isolated = await isolateAgentDirForTest("knowledge-tool-test-");
	setAgentDir(isolated);
}, 30_000);

afterAll(async () => {
	if (original !== undefined) setAgentDir(original);
	await restoreAgentDirForTest(isolated);
}, 30_000);

beforeEach(() => {
	CWD = `C:\\proj-knowledge-tool-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
});

/** The project id `list` reports, so a call can address it again by id. */
function projectIdFor(cwd: string): string {
	return projectSlug(cwd);
}

describe("knowledge tool", () => {
	it("lists all three kinds in one answer, with the project id", async () => {
		const tool = new KnowledgeTool(makeSession());
		await tool.execute("c1", { action: "save", kind: "note", body: "the daemon owns sessions" });
		await tool.execute("c2", { action: "save", kind: "todo", text: "ship the release notes" });
		await tool.execute("c3", { action: "save", kind: "plan", body: "# Release plan\n\n1. freeze" });

		const listed = textOf(await tool.execute("c4", { action: "list" }));
		// One call must reveal everything: three separate list calls before the
		// model knows what exists is context it does not re-read.
		expect(listed).toContain("## notes (1)");
		expect(listed).toContain("## todos (1)");
		expect(listed).toContain("## plans (1)");
		expect(listed).toContain("the daemon owns sessions");
		expect(listed).toContain("ship the release notes");
		expect(listed).toContain("Release plan");
		// The project id is reported so a later call can address this project
		// without knowing its filesystem path.
		expect(listed).toContain(`project ${projectIdFor(CWD)}`);
	});

	it("hands out the plan's path so the model can use its own file tools", async () => {
		const tool = new KnowledgeTool(makeSession());
		await tool.execute("c1", { action: "save", kind: "plan", body: "# Release plan\n\n1. freeze" });
		const listed = textOf(await tool.execute("c2", { action: "list" }));
		// A plan IS a markdown file; giving the path lets the agent read or
		// patch it without pulling the whole document through a tool result.
		expect(listed).toMatch(/Release plan.*\.md/);
	});

	it("reports checklist progress from the plan's `## Steps` section", async () => {
		const tool = new KnowledgeTool(makeSession());
		await tool.execute("c1", {
			action: "save",
			kind: "plan",
			body: "# Release plan\n\n## Steps\n\n- [x] freeze\n- [ ] tag\n- [x] notes",
		});
		expect(textOf(await tool.execute("c2", { action: "list" }))).toContain("2/3 steps");
	});

	it("ticks a todo by id without resending its text", async () => {
		const tool = new KnowledgeTool(makeSession());
		const created = await tool.execute("c1", { action: "save", kind: "todo", text: "one job" });
		const id = created.details?.todo?.id;
		expect(id).toBeTruthy();

		// `done` alone is a valid update — the panel sends exactly this, and
		// requiring the label again would make the model retype (and drift).
		const ticked = await tool.execute("c2", { action: "save", kind: "todo", id, done: true });
		expect(ticked.details?.todo).toMatchObject({ id, text: "one job", done: true });
		expect(textOf(ticked)).toContain("[x]");
	});

	it("keeps a plan's body and title consistent with its `# heading`", async () => {
		const tool = new KnowledgeTool(makeSession());
		const saved = await tool.execute("c1", { action: "save", kind: "plan", body: "# My plan\n\nstep one" });
		const planId = saved.details?.id;
		expect(planId).toBeDefined();

		const shown = await tool.execute("c2", { action: "show", kind: "plan", id: planId! });
		expect(textOf(shown)).toContain("# My plan");
		expect(textOf(shown)).toContain("step one");
		// `show` is not "return the text" — it is "put this in front of the
		// user", so the details carry what the panel needs to open it.
		expect(shown.details?.showPlan).toMatchObject({ id: planId, title: "My plan", directory: CWD });
	});

	it("returns a note's full body on `show kind=note` (list only previews)", async () => {
		const tool = new KnowledgeTool(makeSession());
		const body = `conclusion line\n\n${"detail ".repeat(60)}`;
		const created = await tool.execute("c1", { action: "save", kind: "note", body });
		const noteId = created.details?.id;
		expect(noteId).toBeTruthy();

		// `list` caps the preview at 80 chars; a caller asking to see the note
		// must get the whole text back (user: agent 查不了笔记内容).
		const shown = await tool.execute("c2", { action: "show", kind: "note", id: noteId! });
		expect(textOf(shown)).toBe(body);

		// A guessed id must fail loudly, and todo show must point at `list`.
		await expect(tool.execute("c3", { action: "show", kind: "note", id: "nope-nope" })).rejects.toThrow();
		await expect(tool.execute("c4", { action: "show", kind: "todo", id: "t1" })).rejects.toThrow();
	});

	it("deletes, and reports a missing id instead of silently succeeding", async () => {
		const tool = new KnowledgeTool(makeSession());
		const created = await tool.execute("c1", { action: "save", kind: "note", body: "temp" });
		const noteId = created.details?.id;
		expect(noteId).toBeTruthy();
		await tool.execute("c2", { action: "delete", kind: "note", id: noteId });
		expect(textOf(await tool.execute("c3", { action: "list" }))).toContain("## notes (0)");

		// A model that guesses an id must learn it was wrong.
		await expect(tool.execute("c4", { action: "delete", kind: "note", id: "nope-nope" })).rejects.toThrow();
	});

	it("rejects a save with no kind rather than guessing one", async () => {
		const tool = new KnowledgeTool(makeSession());
		await expect(tool.execute("c1", { action: "save", body: "text" })).rejects.toThrow();
	});

	it("refuses a note replacement when the text changed under the caller", async () => {
		const tool = new KnowledgeTool(makeSession());
		const created = await tool.execute("c1", { action: "save", kind: "note", body: "v1" });
		const noteId = created.details?.id;
		expect(noteId).toBeTruthy();
		await tool.execute("c2", { action: "save", kind: "note", id: noteId, body: "v2 (user)" });

		// The agent carries the text it read → conflict, not silent loss.
		await expect(
			tool.execute("c3", { action: "save", kind: "note", id: noteId, body: "v3", expected: "v1" }),
		).rejects.toThrow(/changed since it was read/);
		expect(textOf(await tool.execute("c4", { action: "list" }))).toContain("v2 (user)");

		await tool.execute("c5", { action: "save", kind: "note", id: noteId, body: "v3", expected: "v2 (user)" });
		expect(textOf(await tool.execute("c6", { action: "list" }))).toContain("v3");
	});

	it("refuses `expected` on a create and on a todo, where it cannot apply", async () => {
		const tool = new KnowledgeTool(makeSession());
		// A create has nothing to compare against; accepting `expected` silently
		// would let the agent believe a conflict check ran.
		await expect(tool.execute("c1", { action: "save", kind: "note", body: "x", expected: "y" })).rejects.toThrow(
			/requires an id/,
		);
		// A todo write names its own fields, so there is no whole-text compare.
		await expect(
			tool.execute("c2", { action: "save", kind: "todo", id: "t1", done: true, expected: "y" }),
		).rejects.toThrow(/applies to notes and plans/);
	});

	it("addresses another project by its id, and refuses both spellings at once", async () => {
		const tool = new KnowledgeTool(makeSession());
		const projectId = projectIdFor(CWD);
		await tool.execute("c1", { action: "save", kind: "note", body: "owned by this project" });

		// Addressing by id alone reaches the same store.
		const byId = textOf(await tool.execute("c2", { action: "list", projectId }));
		expect(byId).toContain("owned by this project");
		// …and so does naming the directory.
		const byDir = textOf(await tool.execute("c3", { action: "list", directory: CWD }));
		expect(byDir).toContain("owned by this project");

		// Both at once is refused: they can disagree, and picking either would
		// write into a project the caller did not mean.
		await expect(tool.execute("c4", { action: "list", projectId, directory: CWD })).rejects.toThrow(
			/only one of projectId or directory/,
		);
	});
});

describe("knowledge tool gating", () => {
	it("is offered by default and withdrawn when its setting is off", async () => {
		const on = (await createTools(makeSession())).map(t => t.name);
		expect(on).toContain("knowledge");

		// An off tool must leave the model's list entirely (cannot be called,
		// costs no context) rather than being present-but-refusing.
		const off = (await createTools(makeSession({ "knowledge.enabled": false }))).map(t => t.name);
		expect(off).not.toContain("knowledge");
		// The gate is scoped to this tool.
		expect(off).toContain("read");
	});
});
