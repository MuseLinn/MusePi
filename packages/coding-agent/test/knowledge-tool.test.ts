import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { type SettingPath, Settings } from "@musepi/pi-coding-agent/config/settings";
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

describe("knowledge tool", () => {
	it("lists all three kinds in one answer", async () => {
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
