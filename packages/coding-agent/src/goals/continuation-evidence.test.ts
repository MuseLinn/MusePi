#!/usr/bin/env bun

import { describe, expect, test } from "bun:test";
import { fingerprintToolEvidence, shouldSuppressContinuation, type ToolEvidence } from "./continuation-evidence";

const todoDone = (): ToolEvidence => ({
	toolName: "todo",
	args: { action: "view" },
	result: "Overall: 1/1 done, 0 open.",
});

describe("fingerprintToolEvidence", () => {
	test("is empty for a round with no tools", () => {
		expect(fingerprintToolEvidence([])).toBe("");
	});

	test("is stable across identical evidence (#11819 loop)", () => {
		expect(fingerprintToolEvidence([todoDone()])).toBe(fingerprintToolEvidence([todoDone()]));
	});

	test("changes when the result changes", () => {
		const before = fingerprintToolEvidence([todoDone()]);
		const after = fingerprintToolEvidence([
			{ toolName: "todo", args: { action: "view" }, result: "Overall: 1/2 done, 1 open." },
		]);
		expect(after).not.toBe(before);
	});

	test("changes when the args change", () => {
		const a = fingerprintToolEvidence([{ toolName: "read", args: { path: "a.ts" }, result: "x" }]);
		const b = fingerprintToolEvidence([{ toolName: "read", args: { path: "b.ts" }, result: "x" }]);
		expect(a).not.toBe(b);
	});

	test("ignores object key order in args", () => {
		const a = fingerprintToolEvidence([{ toolName: "read", args: { path: "a.ts", limit: 10 }, result: "x" }]);
		const b = fingerprintToolEvidence([{ toolName: "read", args: { limit: 10, path: "a.ts" }, result: "x" }]);
		expect(a).toBe(b);
	});

	test("ignores tool-call identity (ids differ every round)", () => {
		// The event payload carries no id in the fingerprint, by construction:
		// same tool + args + result must fingerprint the same no matter the id.
		const withId = { ...todoDone(), toolCallId: "call_abc123" } as ToolEvidence;
		const otherId = { ...todoDone(), toolCallId: "call_xyz789" } as ToolEvidence;
		expect(fingerprintToolEvidence([withId])).toBe(fingerprintToolEvidence([otherId]));
	});

	test("changes when an error appears or clears", () => {
		const ok = fingerprintToolEvidence([{ toolName: "bash", args: { cmd: "ls" }, result: "" }]);
		const err = fingerprintToolEvidence([{ toolName: "bash", args: { cmd: "ls" }, result: "", isError: true }]);
		expect(ok).not.toBe(err);
	});

	test("changes when the number of calls differs", () => {
		const one = fingerprintToolEvidence([todoDone()]);
		const two = fingerprintToolEvidence([todoDone(), todoDone()]);
		expect(one).not.toBe(two);
	});

	test("reads structured { content: [{ type, text }] } results", () => {
		const a = fingerprintToolEvidence([
			{ toolName: "read", args: {}, result: { content: [{ type: "text", text: "hello" }] } },
		]);
		const b = fingerprintToolEvidence([{ toolName: "read", args: {}, result: "hello" }]);
		// Same visible text ⇒ same fingerprint path (both reduce to "hello").
		expect(a).toBe(b);
	});

	test("caps very large results so a big blob cannot destabilise the digest", () => {
		const huge1 = "x".repeat(5000);
		const huge2 = `${"x".repeat(5000)}different-tail`;
		// Equal on the model-visible prefix ⇒ equal fingerprints.
		expect(fingerprintToolEvidence([{ toolName: "read", args: {}, result: huge1 }])).toBe(
			fingerprintToolEvidence([{ toolName: "read", args: {}, result: huge2 }]),
		);
	});

	test("handles circular args without throwing", () => {
		const circular: Record<string, unknown> = { a: 1 };
		circular.self = circular;
		expect(() => fingerprintToolEvidence([{ toolName: "t", args: circular, result: "ok" }])).not.toThrow();
	});

	test("distinguishes undefined from explicit null result", () => {
		const a = fingerprintToolEvidence([{ toolName: "t", args: {}, result: undefined }]);
		const b = fingerprintToolEvidence([{ toolName: "t", args: {}, result: null }]);
		expect(a).toBe(b);
	});
});

describe("shouldSuppressContinuation", () => {
	test("suppresses a round that called no tools", () => {
		expect(shouldSuppressContinuation("", null)).toBe(true);
	});

	test("does NOT suppress the first evidence-bearing continuation", () => {
		expect(shouldSuppressContinuation("1:deadbeef", null)).toBe(false);
	});

	test("suppresses when evidence is unchanged from the previous round", () => {
		const fp = fingerprintToolEvidence([todoDone()]);
		expect(shouldSuppressContinuation(fp, fp)).toBe(true);
	});

	test("permits continuation when evidence changed", () => {
		const a = fingerprintToolEvidence([todoDone()]);
		const b = fingerprintToolEvidence([{ toolName: "todo", args: { action: "view" }, result: "1 open." }]);
		expect(shouldSuppressContinuation(b, a)).toBe(false);
	});

	test("a tool round after a no-evidence round is permitted", () => {
		expect(shouldSuppressContinuation("1:deadbeef", "")).toBe(false);
	});
});
