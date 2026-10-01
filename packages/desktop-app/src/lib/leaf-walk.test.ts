import { describe, expect, it } from "bun:test";
import { EMPTY_TRUSTED_WALK, filterVisibleEntries, walkLeafPath } from "./leaf-walk";

/** 条目工厂:message 条目,view-key 空间(id = "role:ts" 形态)。 */
function msg(id: string, parentId: string | null, role = "user") {
	return { type: "message", id, parentId, timestamp: id, message: { role, content: `c-${id}` } };
}

/** 实机拓扑回归(2026-10-01,会话 01a0f7a7):用户在第二轮节点回退后重新
 *  发消息。journal 里兄弟分支的消息仍平铺在 view entries 中,只有
 *  parentId 链能区分"当前这条分支"——walk 必须从叶走到真根且判 complete,
 *  过滤层才能把兄弟分支的行从 transcript/概览面拿掉。回归后果:回退重发后
 *  客户端把旧分支内容全部显示在会话中,轨迹/导航条轮次虚高。 */
const BRANCHED = [
	msg("user:1", null),
	msg("assistant:2", "user:1", "assistant"),
	// 分支 A(原线):高兴 → 我也高兴
	msg("user:3", "assistant:2"),
	msg("assistant:4", "user:3", "assistant"),
	// 分支 B:高兴呀 → 我也高兴呀
	msg("user:5", "assistant:2"),
	msg("assistant:6", "user:5", "assistant"),
	// 分支 C:介绍一下 → Agnes 清单
	msg("user:7", "assistant:2"),
	msg("assistant:8", "user:7", "assistant"),
	// 新分支 D(回退重发):现在是几点 → 现在时间
	msg("user:9", "assistant:2"),
	msg("assistant:10", "user:9", "assistant"),
];

describe("walkLeafPath — branched session (实机回归 01a0f7a7)", () => {
	it("walks the new-branch leaf to the genuine root and completes", () => {
		const walk = walkLeafPath(BRANCHED, "assistant:10");
		expect(walk.complete).toBe(true);
		expect(walk.path.map(p => p.id)).toEqual(["user:1", "assistant:2", "user:9", "assistant:10"]);
	});

	it("filterVisibleEntries keeps only the active branch — siblings leave the transcript", () => {
		const walk = walkLeafPath(BRANCHED, "assistant:10");
		const ids = new Set(walk.path.map(p => p.id));
		const visible = filterVisibleEntries(BRANCHED, walk, ids, { pinnedToRoot: false });
		expect(visible.map(e => (e as { id: string }).id)).toEqual(["user:1", "assistant:2", "user:9", "assistant:10"]);
	});

	it("walking from a sibling leaf completes too and selects that branch", () => {
		const walk = walkLeafPath(BRANCHED, "assistant:4");
		expect(walk.complete).toBe(true);
		expect(walk.path.map(p => p.id)).toEqual(["user:1", "assistant:2", "user:3", "assistant:4"]);
	});
});

describe("walkLeafPath — chain-cut contracts (regression guards)", () => {
	it("a parent above the loaded window cuts the chain — nothing may be hidden", () => {
		// 尾窗加载:最老条目的 parentId 指向窗外。回归后果:complete 被误判
		// true → 活跃路径只剩零星几行,旧消息整批从 transcript 消失。
		const window_ = [msg("user:9", "assistant:2"), msg("assistant:10", "user:9", "assistant")];
		const walk = walkLeafPath(window_, "assistant:10");
		expect(walk.complete).toBe(false);
		const visible = filterVisibleEntries(window_, walk, new Set(walk.path.map(p => p.id)), {
			pinnedToRoot: false,
		});
		expect(visible).toHaveLength(2); // 全显示,一行不藏
	});

	it("a parentless entry that is NOT the oldest loaded one is a cut, never a root", () => {
		// 实机回归(顾问卡漏打 parentId):尾卡 parentless 被误判真根 → 活跃
		// 路径只剩它一行。这里 user:5 无父且不是最老条目。
		const entries = [msg("user:1", null), msg("assistant:2", "user:1", "assistant"), msg("user:5", null)];
		const walk = walkLeafPath(entries, "user:5");
		expect(walk.complete).toBe(false);
	});
});

describe("filterVisibleEntries — pinned contracts", () => {
	it("pinned to the session root: parentless user messages leave, bookkeeping rows stay", () => {
		const entries = [...BRANCHED, { type: "round_marker", id: "rm-1", parentId: null }];
		const visible = filterVisibleEntries(entries, EMPTY_TRUSTED_WALK, new Set(), {
			pinnedToRoot: true,
		});
		const ids = visible.map(e => (e as { id: string }).id);
		expect(ids).toEqual(["rm-1"]);
	});

	it("a daemon-pinned path filters even when the local walk is cut", () => {
		const window_ = [msg("user:9", "assistant:2"), msg("assistant:10", "user:9", "assistant")];
		const walk = walkLeafPath(window_, "assistant:10"); // complete=false(链断)
		const pinned = new Set(["user:9", "assistant:10"]);
		const visible = filterVisibleEntries(window_, walk, new Set(), {
			pinnedPathIds: pinned,
			pinnedToRoot: false,
		});
		expect(visible.map(e => (e as { id: string }).id)).toEqual(["user:9", "assistant:10"]);
	});
});
