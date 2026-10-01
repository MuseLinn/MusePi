/**
 * ChatView 活跃路径与可见性契约(纯逻辑,lib/leaf-walk.ts):
 *
 * 实机回归(2026-09-27):daemon 给顾问卡漏打 parentId,尾卡片 parentless
 * 被 leafWalk 误判"真根" → activePathIds 只剩它一行 → transcript 过滤把
 * 所有旧消息藏掉。契约:
 *  - parentless 但不是加载窗内最老条目的节点 = 链断,complete=false;
 *  - complete=false 且无 daemon 权威路径时,可见集 = 全部条目(不藏行);
 *  - 真根(最老条目 parentless)链完整时 complete=true,按活跃路径过滤。
 */
import { describe, expect, test } from "bun:test";
import { filterVisibleEntries, walkLeafPath } from "../src/lib/leaf-walk";

function user(id: string, parentId: string | null) {
	return { id, type: "message", parentId, message: { role: "user", content: "q" } };
}
function assistant(id: string, parentId: string | null) {
	return { id, type: "message", parentId, message: { role: "assistant", content: "a" } };
}
function advisorCard(id: string, parentId: string | null) {
	return { id, type: "custom_message", parentId, customType: "advisor", display: true, content: "<advisory/>" };
}

describe("walkLeafPath", () => {
	test("tail parentless advisor card is a cut chain, not a trustworthy root", () => {
		const entries = [user("user:1", null), assistant("assistant:2", "user:1"), advisorCard("custom:3", null)];
		const walk = walkLeafPath(entries, "custom:3");
		expect(walk.complete).toBe(false);
		expect(walk.path.map(p => p.id)).toEqual(["custom:3"]);
	});

	test("a genuinely rooted chain reaches the oldest entry and is complete", () => {
		const entries = [
			user("user:1", null),
			assistant("assistant:2", "user:1"),
			advisorCard("custom:3", "assistant:2"),
		];
		const walk = walkLeafPath(entries, "custom:3");
		expect(walk.complete).toBe(true);
		expect(walk.path.map(p => p.id)).toEqual(["user:1", "assistant:2", "custom:3"]);
	});

	test("session prologue (parentless non-messages) does not break the chain", () => {
		// 实机回归(2026-10-01,会话 01a0f81b):视图开头是 parentless 的
		// model_change/thinking_level_change 序言,首条 user 消息因此不是
		// "最老条目" —— 旧判据把完整链误判链断,活跃路径过滤整段失效,
		// 撤回后的旧分支全部留在转录里。序言同根的首条消息必须是真根。
		const prologue = (id: string) => ({ id, type: "model_change", parentId: null });
		const entries = [
			prologue("model_change:1"),
			prologue("tlc-2"),
			user("user:1", null),
			assistant("assistant:2", "user:1"),
			user("user:2", "assistant:2"),
			assistant("assistant:3", "user:2"),
			// 撤回第 2 轮后的新分支(挂在 assistant:2 下,与 user:2 兄弟)。
			user("user:2n", "assistant:2"),
			assistant("assistant:3n", "user:2n"),
		];
		const walk = walkLeafPath(entries, "assistant:3n");
		expect(walk.complete).toBe(true);
		expect(walk.path.map(p => p.id)).toEqual(["user:1", "assistant:2", "user:2n", "assistant:3n"]);
	});

	test("mid-session parentless entry behind a parentless prologue is still a cut chain", () => {
		// 负契约:序言存在时,发射端漏打 parentId 的中段条目仍判链断 ——
		// root 级连续段只覆盖头部连续 parentless,不包庇中段假根。
		const prologue = (id: string) => ({ id, type: "model_change", parentId: null });
		const entries = [
			prologue("model_change:1"),
			user("user:1", null),
			assistant("assistant:2", "user:1"),
			advisorCard("custom:3", null),
		];
		const walk = walkLeafPath(entries, "custom:3");
		expect(walk.complete).toBe(false);
	});
});

describe("filterVisibleEntries", () => {
	test("tail parentless advisor card never hides earlier messages", () => {
		// The Bug A contract: with the advisor card parentless at the tail,
		// the transcript must still show the user/assistant exchange.
		const entries = [user("user:1", null), assistant("assistant:2", "user:1"), advisorCard("custom:3", null)];
		const walk = walkLeafPath(entries, "custom:3");
		const visible = filterVisibleEntries(entries, walk, new Set(walk.path.map(p => p.id)), {
			pinnedToRoot: false,
		});
		expect(visible.map(e => (e as { id: string }).id)).toEqual(["user:1", "assistant:2", "custom:3"]);
	});

	test("complete topology filters to the active path", () => {
		const branch = assistant("assistant:9", "user:1"); // sibling off the main path
		const entries = [
			user("user:1", null),
			assistant("assistant:2", "user:1"),
			branch,
			advisorCard("custom:3", "assistant:2"),
		];
		const walk = walkLeafPath(entries, "custom:3");
		expect(walk.complete).toBe(true);
		const visible = filterVisibleEntries(entries, walk, new Set(walk.path.map(p => p.id)), {
			pinnedToRoot: false,
		});
		expect(visible.map(e => (e as { id: string }).id)).toEqual(["user:1", "assistant:2", "custom:3"]);
	});

	test("daemon-shipped pinned path wins over a cut local chain", () => {
		const entries = [user("user:1", null), assistant("assistant:2", "user:1"), advisorCard("custom:3", null)];
		const walk = walkLeafPath(entries, "custom:3");
		const pinned = new Set(["user:1", "assistant:2", "custom:3"]);
		const visible = filterVisibleEntries(entries, walk, new Set(walk.path.map(p => p.id)), {
			pinnedPathIds: pinned,
			pinnedToRoot: false,
		});
		expect(visible).toHaveLength(3);
	});
});
