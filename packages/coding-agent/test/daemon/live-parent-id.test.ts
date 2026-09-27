/**
 * Live parentId stamping contract (custom-role regression, 实机 2026-09-27):
 *
 * The daemon stamps `parentId` (messageKey space) onto live wire messages
 * before broadcasting, so the GUI can rebuild the entry tree. The stamp MUST
 * cover custom/hookMessage roles (advisor cards, hook notices): a card left
 * parentless becomes a fake root — the GUI's leaf walk from it stops
 * immediately, the transcript filter hides every earlier message, and the
 * session map collapses every turn to depth 1.
 *
 * Contract asserted here (behavioral, via the exported stamper the live
 * subscriber calls):
 *  - custom/hookMessage messages receive the leaf's messageKey parentId;
 *  - a non-message leaf resolves to the nearest MESSAGE ancestor, custom
 *    roles included (parent chains cross role boundaries in one key space);
 *  - a message that already carries parentId is left untouched;
 *  - roles outside the tree seam are not stamped.
 */
import { describe, expect, test } from "bun:test";
import { type LiveParentIdManager, stampLiveMessageParentId } from "../../src/daemon/session-host";

interface StubMessage {
	role: string;
	timestamp: number;
	content?: string;
}

function entry(id: string, message: StubMessage | null, parentId: string | null = null) {
	return { id, type: message ? "message" : "model_change", message: message ?? undefined, parentId };
}

function mgr(leaf: ReturnType<typeof entry>, entries: ReturnType<typeof entry>[]): LiveParentIdManager {
	return {
		getLeafEntry: () => leaf,
		getEntries: () => entries,
	} as unknown as LiveParentIdManager;
}

const ASSISTANT = { role: "assistant", timestamp: 11, content: "a" };

describe("stampLiveMessageParentId", () => {
	test("custom-role message receives the leaf message's key as parentId", () => {
		const m: { role?: string; parentId?: string | null } = { role: "custom" };
		const leaf = entry("h1", ASSISTANT);
		stampLiveMessageParentId(m, mgr(leaf, [leaf]));
		expect(m.parentId).toBe("assistant:11");
	});

	test("hookMessage receives the leaf message's key as parentId", () => {
		const m: { role?: string; parentId?: string | null } = { role: "hookMessage" };
		const leaf = entry("h1", ASSISTANT);
		stampLiveMessageParentId(m, mgr(leaf, [leaf]));
		expect(m.parentId).toBe("assistant:11");
	});

	test("non-message leaf resolves to the nearest message ancestor across roles", () => {
		// Leaf is a model_change hanging under an advisor card: the new user
		// message must link to the advisor card's key ("custom:<ts>"), not be
		// nulled out — mixed-role chains stay connected in one key space.
		const advisor = { role: "custom", timestamp: 7, content: "<advisory/>" };
		const a = entry("h1", advisor, null);
		const mc = entry("h2", null, "h1");
		const m: { role?: string; parentId?: string | null } = { role: "user" };
		stampLiveMessageParentId(m, mgr(mc, [a, mc]));
		expect(m.parentId).toBe("custom:7");
	});

	test("a message already carrying parentId is not re-stamped", () => {
		const m: { role?: string; parentId?: string | null } = { role: "custom", parentId: "user:3" };
		const leaf = entry("h1", ASSISTANT);
		stampLiveMessageParentId(m, mgr(leaf, [leaf]));
		expect(m.parentId).toBe("user:3");
	});

	test("roles outside the tree seam are not stamped", () => {
		const m: { role?: string; parentId?: string | null } = { role: "system" };
		const leaf = entry("h1", ASSISTANT);
		stampLiveMessageParentId(m, mgr(leaf, [leaf]));
		expect(m.parentId).toBeUndefined();
	});
});
