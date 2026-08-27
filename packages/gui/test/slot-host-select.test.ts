import "./dom-shim";
import { describe, expect, it } from "bun:test";
import { type SlotComponent, selectTranscriptNodeComponents } from "../src/lib/slot-host";

/** Minimal SlotComponent fixture — only entryKinds/order matter for dispatch. */
function comp(over: Partial<SlotComponent> & { slot: string; extensionId: string; code: string }): SlotComponent {
	return { order: 0, ...over };
}

/** transcript.node seat 派发 (DSH entryKey 类比):按 kind 命中 entryKinds,
 * 无 entryKinds 不参与;order 升序;空命中 -> 空数组(seat 回退内建)。 */
describe("selectTranscriptNodeComponents", () => {
	it("empty list -> empty selection (seat falls back to built-in)", () => {
		expect(selectTranscriptNodeComponents([], "message:user")).toEqual([]);
	});

	it("matches a component whose entryKinds includes the kind", () => {
		const a = comp({ slot: "transcript.node", extensionId: "e1", code: "c", entryKinds: ["message:user"] });
		expect(selectTranscriptNodeComponents([a], "message:user")).toEqual([a]);
	});

	it("kind-scoped: a renderer does NOT leak to kinds it did not declare", () => {
		const a = comp({
			slot: "transcript.node",
			extensionId: "e1",
			code: "c",
			entryKinds: ["message:assistant", "message:tool_result"],
		});
		expect(selectTranscriptNodeComponents([a], "message:assistant")).toEqual([a]);
		expect(selectTranscriptNodeComponents([a], "message:user")).toEqual([]);
		expect(selectTranscriptNodeComponents([a], "compaction")).toEqual([]);
	});

	it("a component with no entryKinds never participates in node dispatch", () => {
		const a = comp({ slot: "settings.extensions", extensionId: "e1", code: "c" });
		expect(selectTranscriptNodeComponents([a], "message:user")).toEqual([]);
	});

	it("preserves ascending order", () => {
		const low = comp({
			slot: "transcript.node",
			extensionId: "low",
			code: "c",
			order: 1,
			entryKinds: ["message:user"],
		});
		const high = comp({
			slot: "transcript.node",
			extensionId: "high",
			code: "c",
			order: 10,
			entryKinds: ["message:user"],
		});
		expect(selectTranscriptNodeComponents([high, low], "message:user").map(c => c.extensionId)).toEqual([
			"low",
			"high",
		]);
	});
});
