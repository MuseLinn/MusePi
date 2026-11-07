import "./happy-dom-shim";
import { describe, expect, it } from "bun:test";
import {
	type SlotComponent,
	selectLaunchablePanelTabs,
	selectPanelTabComponent,
	selectTranscriptNodeComponents,
} from "../src/lib/slot-host";

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

describe("selectPanelTabComponent", () => {
	it("selects by the column's own view rather than a globally active view", () => {
		const compaction = comp({ slot: "panel.tab.compaction", extensionId: "summary", code: "c" });
		const other = comp({ slot: "panel.tab.other", extensionId: "other", code: "c" });
		expect(selectPanelTabComponent([compaction, other], "ext:panel.tab.compaction")).toBe(compaction);
		expect(selectPanelTabComponent([compaction, other], "ext:panel.tab.other")).toBe(other);
		expect(selectPanelTabComponent([compaction], "context")).toBeUndefined();
	});

	it("maps the persisted files surface to its plugin slot", () => {
		const files = comp({ slot: "panel.tab.files", extensionId: "file-workspace", code: "c" });
		expect(selectPanelTabComponent([files], "files")).toBe(files);
		expect(selectPanelTabComponent([files], "ext:panel.tab.files")).toBeUndefined();
	});
});

describe("selectLaunchablePanelTabs", () => {
	it("keeps session-provided tabs out of the rail without hiding their open content", () => {
		const compaction = comp({
			slot: "panel.tab.compaction",
			extensionId: "summary",
			code: "c",
			availability: "on-demand",
		});
		const tool = comp({ slot: "panel.tab.tool", extensionId: "tool", code: "c" });
		expect(selectLaunchablePanelTabs([compaction, tool])).toEqual([tool]);
		expect(selectPanelTabComponent([compaction, tool], "ext:panel.tab.compaction")).toBe(compaction);
	});

	it("keeps the host-owned browser pane out of the rail launcher", () => {
		const browser = comp({ slot: "panel.tab.browser", extensionId: "browser-ui", code: "c" });
		const tool = comp({ slot: "panel.tab.tool", extensionId: "tool", code: "c" });
		// The rail already has a built-in browser surface; a second launchable
		// item showed the same globe twice.
		expect(selectLaunchablePanelTabs([browser, tool])).toEqual([tool]);
		expect(selectPanelTabComponent([browser, tool], "browser")).toBe(browser);
	});

	it("keeps the reserved file slot out of the generic extension launcher", () => {
		const files = comp({ slot: "panel.tab.files", extensionId: "file-workspace", code: "c" });
		const tool = comp({ slot: "panel.tab.tool", extensionId: "tool", code: "c" });
		expect(selectLaunchablePanelTabs([files, tool])).toEqual([tool]);
		expect(selectPanelTabComponent([files, tool], "files")).toBe(files);
	});
});

describe("compiled plugin host bridges", () => {
	it("exposes the host prompt/confirm hooks so plugin context is not duplicated", () => {
		const bridge = (window as unknown as { MusePiPromptDialog?: Record<string, unknown> }).MusePiPromptDialog;
		expect(typeof bridge?.useConfirm).toBe("function");
		expect(typeof bridge?.usePrompt).toBe("function");
	});
});
