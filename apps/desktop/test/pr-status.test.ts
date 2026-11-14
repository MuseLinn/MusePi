import { describe, expect, it } from "bun:test";
import { branchToTitle, prVisualState, rollupCheckState } from "../src/lib/pr-status";

describe("rollupCheckState", () => {
	it("returns null for missing or empty rollups", () => {
		expect(rollupCheckState(undefined)).toBeNull();
		expect(rollupCheckState(null)).toBeNull();
		expect(rollupCheckState([])).toBeNull();
	});

	it("folds all-success check runs into success", () => {
		expect(
			rollupCheckState([
				{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
				{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" },
				{ __typename: "StatusContext", state: "SUCCESS" },
			]),
		).toBe("success");
	});

	it("a single failure wins over everything else", () => {
		expect(
			rollupCheckState([
				{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
				{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
				{ __typename: "CheckRun", status: "IN_PROGRESS" },
			]),
		).toBe("failure");
	});

	it("treats timed-out and action-required as failure", () => {
		expect(rollupCheckState([{ conclusion: "TIMED_OUT" }])).toBe("failure");
		expect(rollupCheckState([{ conclusion: "ACTION_REQUIRED" }])).toBe("failure");
	});

	it("keeps the rollup pending while any entry still runs", () => {
		expect(
			rollupCheckState([
				{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
				{ __typename: "CheckRun", status: "IN_PROGRESS" },
				{ __typename: "StatusContext", state: "PENDING" },
			]),
		).toBe("pending");
		expect(rollupCheckState([{ __typename: "CheckRun", status: "QUEUED" }])).toBe("pending");
	});

	it("treats unknown or malformed entries as pending, not as pass", () => {
		expect(rollupCheckState([{}])).toBe("pending");
		expect(rollupCheckState([null])).toBe("pending");
	});
});

describe("prVisualState", () => {
	it("draft wins over state", () => {
		expect(prVisualState({ isDraft: true, state: "OPEN" })).toBe("draft");
	});
	it("maps terminal states", () => {
		expect(prVisualState({ isDraft: false, state: "MERGED" })).toBe("merged");
		expect(prVisualState({ isDraft: false, state: "CLOSED" })).toBe("closed");
		expect(prVisualState({ isDraft: false, state: "OPEN" })).toBe("open");
		expect(prVisualState({})).toBe("open");
	});
});

describe("branchToTitle", () => {
	it("turns branch names into title case", () => {
		expect(branchToTitle("feat/my-cool_branch")).toBe("Feat My Cool Branch");
		expect(branchToTitle("fix/login--bug")).toBe("Fix Login Bug");
	});
	it("strips the refs prefix and collapses whitespace", () => {
		expect(branchToTitle("refs/heads/chore/  bump__deps")).toBe("Chore Bump Deps");
	});
	it("leaves an already-clean name alone", () => {
		expect(branchToTitle("Release")).toBe("Release");
	});
});
