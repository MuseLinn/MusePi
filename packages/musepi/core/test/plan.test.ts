// MusePi core — plan mode 往返契约测试（镜像 harness tests/plan.test.mjs）。
// 回归守护：jiti 2.7.0 会对跨模块 `export let` 产生陈旧快照（生产实测：
// enter_plan_mode 写成功，exit_plan_mode 读到旧快照报 "not active"）。
// 状态现在放在 `export const` 容器（planModeState）里做属性级变更，
// 下面的跨模块断言（经 types.ts setter 写、经 plan/index.ts manager 读）
// 锁定这一契约，并验证容器对象 identity 在往返中保持稳定。
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { planManager } from "../src/plan/index.ts";
import { planModeState, setPlanActive } from "../src/plan/types.ts";

const cleanCwd = fs.mkdtempSync(path.join(os.tmpdir(), "plan-test-clean-"));
planManager.setSessionDir(cleanCwd);

after(() => {
	fs.rmSync(cleanCwd, { recursive: true, force: true });
});

describe("plan mode container contract", () => {
	it("enter → isActive → exit round trip, visible cross-module", () => {
		assert.equal(planManager.isPlanModeActive(), false);
		assert.equal(planModeState.isActive, false);

		const plan = planManager.enterPlanMode("test round trip");
		assert.equal(planManager.isPlanModeActive(), true);
		// cross-module read: manager wrote, container import sees it
		assert.equal(planModeState.isActive, true);
		assert.equal(planManager.getCurrentPlan()?.id, plan.id);

		const exited = planManager.exitPlanMode();
		assert.equal(exited?.id, plan.id);
		assert.equal(planManager.isPlanModeActive(), false);
		assert.equal(planModeState.isActive, false);
	});

	it("types.ts setter writes are visible through the manager", () => {
		planManager.enterPlanMode();
		setPlanActive(false);
		assert.equal(planManager.isPlanModeActive(), false);
		setPlanActive(true);
		assert.equal(planManager.isPlanModeActive(), true);
		planManager.exitPlanMode();
		assert.equal(planManager.isPlanModeActive(), false);
	});

	it("re-enter after exit sticks and history accumulates", () => {
		planManager.enterPlanMode();
		assert.equal(planManager.isPlanModeActive(), true);
		assert.ok(planModeState.history.length >= 2);
		planManager.exitPlanMode();
		assert.equal(planManager.isPlanModeActive(), false);
	});

	it("container object identity is stable across the round trip", () => {
		const ref = planModeState;
		planManager.enterPlanMode();
		assert.equal(planModeState, ref);
		planManager.exitPlanMode();
		assert.equal(planModeState, ref);
	});
});

describe("plan-mode bash gate understands rtk-wrapped commands", () => {
	it("rtk/env-wrapped read-only commands pass; writes stay blocked", () => {
		planManager.enterPlanMode("rtk gate tests");
		// pi-rtk-optimizer rewrites `ls "D:/x"` → `rtk ls "D:/x"` (optionally
		// with leading env assignments) before the gate vets the string.
		assert.equal(planManager.shouldBlockTool("bash", "", "rtk ls /tmp"), false);
		assert.equal(planManager.shouldBlockTool("bash", "", "FOO=bar RTK_X=1 rtk cat file.txt | head -5"), false);
		assert.equal(planManager.shouldBlockTool("bash", "", "rtk -q --no-color git status"), false);
		assert.equal(planManager.shouldBlockTool("bash", "", "dir"), false); // Windows read-only listing
		assert.equal(planManager.shouldBlockTool("bash", "", "rtk rm -rf x"), true);
		assert.equal(planManager.shouldBlockTool("bash", "", "rm -rf x"), true);
		assert.equal(planManager.shouldBlockTool("bash", "", "ls /tmp | head -5"), false);
		planManager.exitPlanMode();
	});
});

describe("reenterForRevision (Revise path)", () => {
	it("keeps the same plan id/path/content and re-activates plan mode", () => {
		const plan = planManager.enterPlanMode("revise test");
		const content = "# My Plan\n\nDo the thing.\n";
		fs.writeFileSync(plan.path, content, "utf-8"); // model wrote the plan file
		planManager.updatePlanContent(content);
		planManager.exitPlanMode();
		assert.equal(planManager.isPlanModeActive(), false);

		const revised = planManager.reenterForRevision();
		assert.equal(revised.id, plan.id);
		assert.equal(revised.path, plan.path);
		assert.equal(revised.content, content);
		assert.equal(revised.status, "writing");
		assert.equal(planManager.isPlanModeActive(), true);
		planManager.exitPlanMode();
	});
});

describe("validateRestoredState", () => {
	it("deactivates a stale active plan (empty content + missing file)", () => {
		planManager.restoreFromData({
			isActive: true,
			currentPlan: {
				id: "stale-1",
				content: "",
				path: path.join(cleanCwd, "plans", "does-not-exist.md"),
				status: "exploring",
				createdAt: 1,
			},
			history: [],
		});
		assert.equal(planManager.validateRestoredState(), false);
		assert.equal(planManager.isPlanModeActive(), false);
		assert.equal(planManager.getCurrentPlan(), null);
	});

	it("keeps an active plan whose file exists on disk", () => {
		const keptPath = path.join(cleanCwd, "plans", "kept.md");
		fs.mkdirSync(path.dirname(keptPath), { recursive: true });
		fs.writeFileSync(keptPath, "# Kept plan\n", "utf-8");
		planManager.restoreFromData({
			isActive: true,
			currentPlan: { id: "kept-1", content: "", path: keptPath, status: "writing", createdAt: 1 },
			history: [],
		});
		assert.equal(planManager.validateRestoredState(), true);
		assert.equal(planManager.isPlanModeActive(), true);
		planManager.exitPlanMode();
	});
});

describe("exitPlanMode disk sync", () => {
	it("syncs in-memory content from the on-disk plan file", () => {
		const plan = planManager.enterPlanMode("disk sync test");
		const diskContent = "# Disk Plan\n\nWritten straight to disk.\n";
		fs.writeFileSync(plan.path, diskContent, "utf-8"); // model wrote file; memory not updated
		assert.equal(planManager.getCurrentPlan()?.content, "");
		const exited = planManager.exitPlanMode();
		assert.equal(exited?.content, diskContent);
	});
});
