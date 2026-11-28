import { describe, expect, it } from "bun:test";
import { type ApprovalBridge, createApprovalBridge } from "../src/daemon/approval-bridge";
import { setLocale } from "../src/i18n";

/**
 * Contract: a tool allowed for the session stops producing approval cards, and
 * the allowance never outlives the session that granted it.
 *
 * Why this exists: the card used to offer only approve/deny, so a tool the user
 * trusts still interrupted every single call. "Always allow" is the answer, but
 * its scope is the whole point — persisting it would turn one click into a
 * standing policy, which is what `tools.approvalMode` is for.
 */

/** The gate the agent awaits: `select("Allow tool: <name>…", [approve, deny], { purpose })`.
 *  The purpose is what marks it as an approval — the labels are display text and
 *  may be in any language, so they are not what identifies the dialog. */
function approvalSelect(bridge: ApprovalBridge) {
	return (title: string, options: unknown[], dialogOptions?: { purpose?: "approval" }): Promise<string | undefined> =>
		(bridge.uiContext.select as (t: string, o: unknown[], d?: unknown) => Promise<string | undefined>)(
			title,
			options,
			dialogOptions,
		);
}

const APPROVAL = { purpose: "approval" as const };

function bridge(): { bridge: ApprovalBridge; cards: string[] } {
	const cards: string[] = [];
	const created = createApprovalBridge(
		record => cards.push(record.tool),
		() => {},
	);
	return { bridge: created, cards };
}

// The answers are display text; the gate echoes the label the host chose.
const APPROVE = () => {
	setLocale("en-US");
	return "Approve";
};
const OPTIONS = ["Approve", "Deny"];

describe("session-scoped tool allowance", () => {
	it("asks once, then passes without a card for the allowed tool", async () => {
		const { bridge: b, cards } = bridge();
		const select = approvalSelect(b);

		const first = select("Allow tool: bash\nReason: writes files", OPTIONS, APPROVAL);
		// The gate registers the card synchronously but the promise settles on a
		// later tick; yield once so this assertion sees the registration.
		await Promise.resolve();
		expect(cards).toEqual(["bash"]);
		// Answer the card through the bridge, the way a client does.
		const [request] = [...b.pending.values()];
		expect(request).toBeDefined();
		// Grant the allowance and settle the waiting request.
		b.allowedTools.add("bash");
		b.resolve(request!.requestId, true);

		expect(await first).toBe(APPROVE());

		// The next call for the same tool resolves with no card at all.
		expect(await select("Allow tool: bash\nReason: writes files", OPTIONS, APPROVAL)).toBe("Approve");
		expect(cards).toEqual(["bash"]);
	});

	it("still asks for a different tool", async () => {
		const { bridge: b, cards } = bridge();
		const select = approvalSelect(b);
		b.allowedTools.add("bash");

		void select("Allow tool: write\nReason: edits a file", OPTIONS, APPROVAL);
		await Promise.resolve();
		expect(cards).toEqual(["write"]);
	});

	it("leaves non-approval selects on the ask path", async () => {
		const { bridge: b } = bridge();
		const select = approvalSelect(b);
		// An ask the agent raises: labels are neither Approve nor Deny.
		const pending = select("Which file?", ["a.ts", "b.ts"]);
		expect(b.pendingAsks.size).toBe(1);
		const [ask] = [...b.pendingAsks.values()];
		b.resolveAsk(ask!.requestId, "a.ts");
		expect(await pending).toBe("a.ts");
	});
});
