/**
 * Approval bridge unit tests — the daemon's tool-approval gate.
 *
 * `createApprovalBridge()` produces an ExtensionUIContext whose approval
 * select pauses on a pending record; `bridge.resolve()` answers it. Generic
 * (non Approve/Deny) selects and inputs register a pending ask that
 * `bridge.resolveAsk()` answers (TUI ask parity).
 */
import { describe, expect, test } from "bun:test";
import { createApprovalBridge } from "../../src/daemon/approval-bridge";

const noop = (): void => {};

describe("approval bridge", () => {
	test("approval select pauses and resolve(true) returns Approve", async () => {
		const requests: Array<{ requestId: string; tool: string }> = [];
		const bridge = createApprovalBridge(record => {
			requests.push({ requestId: record.requestId, tool: record.tool });
		}, noop);
		const pending = bridge.uiContext.select("Allow tool: bash\nReason: write-tier", [
			{ label: "Approve", description: "Run once" },
			{ label: "Deny", description: "Block" },
		]);
		// Synchronously registered + notified.
		expect(requests).toHaveLength(1);
		expect(requests[0]!.tool).toBe("bash");
		expect(bridge.pending.size).toBe(1);
		const requestId = requests[0]!.requestId;

		const decided = bridge.resolve(requestId, true);
		expect(decided).toBe(true);
		expect(await pending).toBe("Approve");
		expect(bridge.pending.size).toBe(0);
	});

	test("resolve(false) returns Deny and clears pending", async () => {
		const bridge = createApprovalBridge(noop, noop);
		const pending = bridge.uiContext.select("Allow tool: edit", [{ label: "Approve" }, { label: "Deny" }]);
		const requestId = [...bridge.pending.keys()][0]!;
		expect(bridge.resolve(requestId, false)).toBe(true);
		expect(await pending).toBe("Deny");
		expect(bridge.pending.size).toBe(0);
	});

	test("unknown requestId is refused (false)", () => {
		const bridge = createApprovalBridge(noop, noop);
		expect(bridge.resolve("nope", true)).toBe(false);
	});

	test("double resolve is idempotent — second call refused", async () => {
		const bridge = createApprovalBridge(noop, noop);
		const pending = bridge.uiContext.select("Allow tool: bash", [{ label: "Approve" }, { label: "Deny" }]);
		const requestId = [...bridge.pending.keys()][0]!;
		expect(bridge.resolve(requestId, true)).toBe(true);
		expect(bridge.resolve(requestId, false)).toBe(false);
		expect(await pending).toBe("Approve");
	});

	test("non-approval select registers an ask, resolveAsk answers it", async () => {
		const asks: string[] = [];
		const bridge = createApprovalBridge(noop, record => {
			asks.push(record.title);
		});
		const pending = bridge.uiContext.select("Pick an item", ["A", "B"]);
		expect(asks).toEqual(["Pick an item"]);
		expect(bridge.pending.size).toBe(0);
		expect(bridge.pendingAsks.size).toBe(1);
		const requestId = [...bridge.pendingAsks.keys()][0]!;
		expect(bridge.resolveAsk(requestId, "B")).toBe(true);
		expect(await pending).toBe("B");
		expect(bridge.pendingAsks.size).toBe(0);
	});

	test("input mode registers an ask answered with text; null cancels", async () => {
		const bridge = createApprovalBridge(noop, noop);
		const pending = bridge.uiContext.input("Type your answer");
		expect(bridge.pendingAsks.size).toBe(1);
		const requestId = [...bridge.pendingAsks.keys()][0]!;
		expect(bridge.resolveAsk(requestId, "custom text")).toBe(true);
		expect(await pending).toBe("custom text");

		const pending2 = bridge.uiContext.input("Another");
		const requestId2 = [...bridge.pendingAsks.keys()][0]!;
		expect(bridge.resolveAsk(requestId2, null)).toBe(true);
		expect(await pending2).toBeUndefined();
	});

	test("tool name parsed from the Allow tool: prefix (fallback unknown)", async () => {
		const bridge = createApprovalBridge(noop, noop);
		const pending = bridge.uiContext.select("Something else", [{ label: "Approve" }, { label: "Deny" }]);
		expect([...bridge.pending.values()][0]!.tool).toBe("unknown");
		bridge.resolve([...bridge.pending.keys()][0]!, true);
		await pending;
	});
});
