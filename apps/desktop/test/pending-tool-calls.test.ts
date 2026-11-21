import "./dom-shim";
import { describe, expect, test } from "bun:test";
import { pendingToolCallsNotice } from "../src/lib/pending-tool-calls";

/**
 * Contract (resume notice, TUI parity): a branch that ended with a tool call
 * and no result is an abandoned call, and the GUI names it the way the TUI's
 * resume warning does — tool plus the command or path it touched. The daemon
 * owns the detection (persisted entries); this side only renders what it
 * reports, so the shape here is the RPC payload, not session entries.
 */
describe("pendingToolCallsNotice", () => {
	test("names an unanswered call with its command", () => {
		const notice = pendingToolCallsNotice([
			{ toolName: "bash", toolCallId: "tool-1", summary: { kind: "command", value: "bun run check:ts" } },
		]);
		expect(notice?.count).toBe(1);
		expect(notice?.calls).toBe("bash · command `bun run check:ts`");
	});

	test("a call without a target keeps its name alone", () => {
		const notice = pendingToolCallsNotice([{ toolName: "todo", toolCallId: null, summary: null }]);
		expect(notice?.calls).toBe("todo");
	});

	test("a path-shaped target reads as a path", () => {
		const notice = pendingToolCallsNotice([{ toolName: "write", summary: { kind: "path", value: "src/a.ts" } }]);
		expect(notice?.calls).toBe("write · path `src/a.ts`");
	});

	test("nothing pending means no notice", () => {
		expect(pendingToolCallsNotice([])).toBeNull();
	});

	test("the signature follows the content, so a new call re-opens the notice", () => {
		const first = pendingToolCallsNotice([{ toolName: "bash" }]);
		const second = pendingToolCallsNotice([{ toolName: "bash" }, { toolName: "write" }]);
		expect(first?.signature).not.toBe(second?.signature);
	});
});
