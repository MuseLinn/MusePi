// MusePi core — goal 生命周期/持久化契约测试（镜像 harness tests/goal.test.mjs）。
// 覆盖本次修复点：
//  A. 徽标 turns 闪变 —— restore 单调 max 合并、restore-if-empty 守卫、
//     complete 墓碑不恢复、clear() 写墓碑、recordTurn 每 turn 持久化。
//  B. update_goal 完成摩擦 —— 声明 completion_criterion 后收尾必须
//     verified=true，且工具文档（promptSnippet/promptGuidelines/参数描述）
//     把该约定讲清楚。
import assert from "node:assert";
import { describe, it } from "node:test";
import { goalManager } from "../src/goal/index.ts";
import { registerGoalTools } from "../src/goal/tools.ts";

function goalEntry(data: Record<string, unknown>) {
	return { type: "custom", customType: "muselinn_goal", data };
}

function entryData(over: Record<string, unknown> = {}) {
	return {
		goalId: "g-e1",
		objective: "entry goal",
		status: "active",
		lastActor: "user",
		lastActedAt: new Date().toISOString(),
		turnsUsed: 7,
		tokensUsed: 70,
		wallClockMs: 700,
		...over,
	};
}

describe("goal lifecycle gates", () => {
	it("completionCriterion gate: refused without verified, succeeds with verified=true", () => {
		goalManager.clear();
		goalManager.createGoal("criterion probe", "all tests green");
		const refused = goalManager.complete("user", "done?", false);
		assert.equal(refused, null);
		assert.equal(goalManager.getGoal()?.status, "active");

		const ok = goalManager.complete("user", "all green", true);
		assert.equal(ok?.status, "complete");
		assert.equal(goalManager.getGoal()?.completionSummary, "all green");
		goalManager.clear();
	});

	it("goal without criterion completes freely", () => {
		goalManager.clear();
		goalManager.createGoal("no criterion probe");
		const ok = goalManager.complete("user");
		assert.equal(ok?.status, "complete");
		goalManager.clear();
	});
});

describe("goal restore monotonicity (badge flicker fix)", () => {
	it("recordTurn accumulates and stale same-goalId entry does not regress counters", () => {
		goalManager.clear();
		goalManager.createGoal("merge probe");
		goalManager.recordTurn(100);
		goalManager.recordTurn(100);
		const cur = goalManager.getGoal();
		assert.equal(cur?.turnsUsed, 2);
		assert.equal(cur?.tokensUsed, 200);

		const stale = { ...cur!, turnsUsed: 1, tokensUsed: 50, wallClockMs: 0 };
		goalManager.restoreFromData(stale);
		const after = goalManager.getGoal();
		assert.equal(after?.turnsUsed, 2);
		assert.equal(after?.tokensUsed, 200);
		goalManager.clear();
	});

	it("different goalId replaces wholesale (session switch)", () => {
		goalManager.clear();
		goalManager.createGoal("switch probe");
		goalManager.recordTurn(100);
		const cur = goalManager.getGoal()!;
		goalManager.restoreFromData({ ...cur, goalId: "g-other-session", turnsUsed: 0, tokensUsed: 0 });
		assert.equal(goalManager.getGoal()?.goalId, "g-other-session");
		assert.equal(goalManager.getGoal()?.turnsUsed, 0);
		goalManager.clear();
	});

	it("tryRestoreFromEntries restores only when empty and never overwrites live state", () => {
		goalManager.clear();
		const restored = goalManager.tryRestoreFromEntries([goalEntry(entryData())]);
		assert.equal(restored, true);
		assert.equal(goalManager.getGoal()?.turnsUsed, 7);

		goalManager.recordTurn(10); // turns 7 → 8
		goalManager.tryRestoreFromEntries([goalEntry(entryData({ turnsUsed: 3, tokensUsed: 30 }))]);
		assert.equal(goalManager.getGoal()?.turnsUsed, 8);
		goalManager.clear();
	});

	it("latest complete entry acts as tombstone (no restore, no fall-through)", () => {
		goalManager.clear();
		const entries = [
			goalEntry(entryData({ goalId: "g-old", turnsUsed: 5 })),
			goalEntry(entryData({ goalId: "g-old", status: "complete", turnsUsed: 6 })),
		];
		const r = goalManager.tryRestoreFromEntries(entries);
		assert.equal(r, false);
		assert.equal(goalManager.getGoal(), null);
	});
});

describe("goal clear + persistence write side", () => {
	it("clear() appends a complete-status tombstone; cleared goal is not resurrected", () => {
		goalManager.clear();
		const appended: Array<{ type: string; data: any }> = [];
		goalManager.setAppendEntry((type, data) => appended.push({ type, data }));
		goalManager.createGoal("tombstone probe");
		goalManager.recordTurn(10);
		goalManager.clear();
		goalManager.setAppendEntry(() => {});

		const tombstones = appended.filter((a) => a.type === "muselinn_goal" && a.data?.status === "complete");
		assert.ok(tombstones.length >= 1);

		const entries = appended.map((a) => goalEntry(a.data));
		const r = goalManager.tryRestoreFromEntries(entries);
		assert.equal(r, false);
		assert.equal(goalManager.getGoal(), null);
	});

	it("recordTurn persists every turn (monotonic entry sequence)", () => {
		goalManager.clear();
		const appended: any[] = [];
		goalManager.setAppendEntry((_type, data) => appended.push(data));
		goalManager.createGoal("persist probe");
		goalManager.recordTurn(10);
		goalManager.recordTurn(10);
		goalManager.setAppendEntry(() => {});
		assert.deepEqual(appended.map((d) => d.turnsUsed), [0, 1, 2]);
		goalManager.clear();
	});
});

describe("update_goal tool-layer verified gate + docs", () => {
	function collectTools() {
		const tools = new Map<string, any>();
		registerGoalTools({ registerTool: (def: any) => tools.set(def.name, def) } as never, goalManager);
		return tools;
	}

	it("docs state verified=true is required when a criterion is declared", () => {
		const tools = collectTools();
		const updateGoal = tools.get("update_goal");
		assert.ok(updateGoal);
		const doc = [
			updateGoal.promptSnippet,
			...(updateGoal.promptGuidelines ?? []),
			updateGoal.parameters?.properties?.status?.description ?? "",
			updateGoal.parameters?.properties?.verified?.description ?? "",
		].join("\n");
		assert.match(doc, /verified=true/);
		assert.match(doc, /criterion/i);
		assert.match(doc, /refus/i);

		const createGoal = tools.get("create_goal");
		const createDoc = [
			createGoal.promptSnippet,
			...(createGoal.promptGuidelines ?? []),
			createGoal.parameters?.properties?.completion_criterion?.description ?? "",
		].join("\n");
		assert.match(createDoc, /verified=true/);
		assert.match(createDoc, /criterion/i);
	});

	it("complete refused without verified at tool layer, succeeds with verified=true", async () => {
		goalManager.clear();
		const tools = collectTools();
		const updateGoal = tools.get("update_goal");

		goalManager.createGoal("tool friction probe", "all tests green");
		const refused = await updateGoal.execute("tc1", { status: "complete" }, null, null, {});
		assert.match(refused.content?.[0]?.text ?? "", /verified=true/);
		assert.equal(goalManager.getGoal()?.status, "active");

		const ok = await updateGoal.execute("tc2", { status: "complete", verified: true }, null, null, {});
		assert.equal(goalManager.getGoal()?.status, "complete");
		assert.match(ok.content?.[0]?.text ?? "", /Goal updated/);
		goalManager.clear();
	});
});
