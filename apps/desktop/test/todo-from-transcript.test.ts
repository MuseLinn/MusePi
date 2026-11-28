// Todo progress derived from transcript entries: the newest authoritative
// source wins, a failed `todo` call is skipped, and the panel's own edits
// outrank the tool results they follow.
import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@musepi/pi-wire";
import { todoPhasesFromEntries } from "../src/components/composer/todo-from-transcript";

function todoResult(phases: unknown, options: { isError?: boolean; toolName?: string } = {}): SessionEntry {
	return {
		type: "message",
		id: `toolResult:t${Math.random()}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role: "toolResult",
			toolName: options.toolName ?? "todo",
			isError: options.isError === true,
			details: { phases },
		},
	} as unknown as SessionEntry;
}

function userEdit(phases: unknown): SessionEntry {
	return {
		type: "custom",
		id: `custom:${Math.random()}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: "user_todo_edit",
		data: { phases },
	} as unknown as SessionEntry;
}

const PLAN_A = [
	{
		name: "Build",
		tasks: [
			{ content: "one", status: "completed" },
			{ content: "two", status: "pending" },
		],
	},
];
const PLAN_B = [{ name: "Ship", tasks: [{ content: "three", status: "completed" }] }];

describe("todo phases from the transcript", () => {
	test("counts completed tasks per phase", () => {
		const phases = todoPhasesFromEntries([todoResult(PLAN_A)]);
		expect(phases).toHaveLength(1);
		expect(phases[0]).toMatchObject({ name: "Build", done: 1, total: 2 });
	});

	test("the newest todo result wins", () => {
		const phases = todoPhasesFromEntries([todoResult(PLAN_A), todoResult(PLAN_B)]);
		expect(phases.map(p => p.name)).toEqual(["Ship"]);
	});

	test("a panel edit outranks the tool results before it", () => {
		const phases = todoPhasesFromEntries([todoResult(PLAN_A), userEdit(PLAN_B)]);
		expect(phases.map(p => p.name)).toEqual(["Ship"]);
	});

	test("a failed todo call does not clear the list", () => {
		// The agent retried and the retry errored: the standing list is still
		// the last successful one, not "no phases".
		const phases = todoPhasesFromEntries([todoResult(PLAN_A), todoResult(null, { isError: true })]);
		expect(phases.map(p => p.name)).toEqual(["Build"]);
	});

	test("another tool's result is ignored", () => {
		const phases = todoPhasesFromEntries([todoResult(PLAN_A), todoResult(PLAN_B, { toolName: "read" })]);
		expect(phases.map(p => p.name)).toEqual(["Build"]);
	});

	test("an empty transcript has no phases", () => {
		expect(todoPhasesFromEntries([])).toEqual([]);
	});

	test("malformed phases are dropped rather than crashing the panel", () => {
		const phases = todoPhasesFromEntries([todoResult([{ tasks: "nope" }, null, { name: "Ok", tasks: [] }])]);
		expect(phases.map(p => p.name)).toEqual(["Ok"]);
	});
});
