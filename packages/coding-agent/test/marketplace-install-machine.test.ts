import { afterEach, describe, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { zipSync } from "fflate";
import { MarketplaceInstallMachine, type MarketplaceInstallView } from "../src/skills/marketplace-install-machine";

/**
 * marketplace 安装状态机三场景契约（M2-2.2）：
 *   - 断网：downloading 阶段 fetch 失败 → failed{kind:network}（stub fetch，
 *     不碰真网络）；
 *   - 取消：真实 cancel 调用 → cancelled，且 staging 半成品目录被清理；
 *   - 脚本拦截：含 install.sh 的 zip → awaiting-approval，批准 → done，
 *     拒绝 → failed{kind:script-declined} 且不落盘。
 * 断言全部落在事件流（onState 视图）与文件系统这两条对外可见的缝上。
 */

function makeZip(files: Record<string, string>): Uint8Array {
	return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new TextEncoder().encode(v)])));
}

const SKILL_MD = `---
name: mkt-machine-skill
description: state machine fixture
---
body
`;

/** 事件采集 + 条件等待（事件异步到达，轮询缝上有 5s 上限）。 */
function collect(): { events: MarketplaceInstallView[]; onState: (v: MarketplaceInstallView) => void } {
	const events: MarketplaceInstallView[] = [];
	return { events, onState: v => events.push({ ...v }) };
}

async function waitFor(
	events: MarketplaceInstallView[],
	pred: (v: MarketplaceInstallView) => boolean,
	what: string,
): Promise<MarketplaceInstallView> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const hit = [...events].reverse().find(pred);
		if (hit) return hit;
		await Bun.sleep(10);
	}
	throw new Error(`condition not met: ${what}; events=${JSON.stringify(events)}`);
}

async function makeDest(): Promise<string> {
	return mkdtemp(path.join(tmpdir(), "mkt-machine-dest-"));
}

/** fetch stub 的跨用例登记（afterEach 统一 restore）。 */
const fetchSpyRef: { value: { mockRestore(): void } | null } = { value: null };

/** typeof fetch 要求 preconnect 静态方法，stub 实现要顺手带上。 */
function asFetch(impl: () => Promise<Response>): typeof fetch {
	return Object.assign(impl, { preconnect: globalThis.fetch.preconnect });
}

afterEach(() => {
	// 全套恢复：网络 stub 绝不泄漏到相邻测试文件。
	fetchSpyRef.value?.mockRestore();
	fetchSpyRef.value = null;
});

describe("marketplace install state machine", () => {
	test("断网：downloading 阶段失败归类 failed{kind:network}，可重试语义", async () => {
		const dest = await makeDest();
		try {
			const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
			fetchSpyRef.value = fetchSpy;
			const { events, onState } = collect();
			const machine = new MarketplaceInstallMachine(onState);

			const installId = machine.start({ source: "skillhub", slug: "demo" }, dest);
			assert.ok(installId.length > 0);

			const terminal = await waitFor(events, v => v.state === "failed", "failed");
			assert.equal(terminal.installId, installId);
			assert.equal(terminal.kind, "network");
			// 状态可查询（skills.marketplace.status 契约）：终态记录在场。
			const status = machine.status();
			assert.ok(status.installs.some(i => i.installId === installId && i.state === "failed"));

			// 重试语义：重新发起一次（stub 切回正常 zip）即从头装，不做续传。
			fetchSpy.mockImplementation(asFetch(async () => new Response(makeZip({ "SKILL.md": SKILL_MD }), { status: 200 })));
			const retryEvents = collect();
			const retryMachine = new MarketplaceInstallMachine(retryEvents.onState);
			const retryId = retryMachine.start({ source: "skillhub", slug: "demo" }, dest);
			await waitFor(retryEvents.events, v => v.installId === retryId && v.state === "done", "retry done");
			assert.ok(existsSync(path.join(dest, "mkt-machine-skill", "SKILL.md")));
		} finally {
			await rm(dest, { recursive: true, force: true });
		}
	});

	test("取消：awaiting-approval 期间 cancel → cancelled，staging 半成品被清理", async () => {
		const dest = await makeDest();
		try {
			const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
				asFetch(
					async () =>
						new Response(makeZip({ "SKILL.md": SKILL_MD, "scripts/install.sh": "echo hi" }), { status: 200 }),
				),
			);
			fetchSpyRef.value = fetchSpy;
			const { events, onState } = collect();
			const machine = new MarketplaceInstallMachine(onState);

			const installId = machine.start({ source: "skillhub", slug: "demo" }, dest);
			const paused = await waitFor(events, v => v.state === "awaiting-approval", "awaiting-approval");
			// 半成品在场：staging 已落盘且含未批准的脚本。
			const stagingDir = paused.stagingDir;
			assert.ok(stagingDir && existsSync(stagingDir), "staging dir must exist while paused");

			const res = machine.cancel(installId);
			assert.equal(res.status, "cancelled");
			const terminal = await waitFor(events, v => v.state === "cancelled", "cancelled");
			assert.equal(terminal.installId, installId);
			assert.ok(!existsSync(stagingDir), "staging must be removed after cancel");
			assert.ok(!existsSync(path.join(dest, "mkt-machine-skill")), "dest must not be written on cancel");
		} finally {
			await rm(dest, { recursive: true, force: true });
		}
	});

	test("脚本拦截：批准后安装继续且文件落盘；拒绝则 failed{script-declined} 不落盘", async () => {
		const dest = await makeDest();
		try {
			const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
				asFetch(
					async () =>
						new Response(makeZip({ "SKILL.md": SKILL_MD, "scripts/install.sh": "echo hi" }), { status: 200 }),
				),
			);
			fetchSpyRef.value = fetchSpy;
			const { events, onState } = collect();
			const machine = new MarketplaceInstallMachine(onState);

			// ── 批准路径：awaiting-approval → approve → done ──
			const installId = machine.start({ source: "skillhub", slug: "demo" }, dest);
			const paused = await waitFor(events, v => v.state === "awaiting-approval", "awaiting-approval");
			assert.deepEqual(paused.scripts, ["scripts/install.sh"]);
			const approved = machine.approve(installId, true);
			assert.equal(approved.ok, true);
			await waitFor(events, v => v.state === "done", "done");
			assert.equal(await readFile(path.join(dest, "mkt-machine-skill", "scripts", "install.sh"), "utf8"), "echo hi");
			// 批准不是豁免 staging 清理：终态后暂存目录照删。
			const final = machine.status().installs.find(i => i.installId === installId);
			assert.ok(final?.state === "done" && !final.stagingDir);

			// ── 拒绝路径：独立 dest 上的全新安装，拒绝脚本 → 不落盘 ──
			const denyDest = await makeDest();
			try {
				const denyEvents = collect();
				const denyMachine = new MarketplaceInstallMachine(denyEvents.onState);
				const denyId = denyMachine.start({ source: "skillhub", slug: "demo" }, denyDest);
				await waitFor(denyEvents.events, v => v.state === "awaiting-approval", "deny paused");
				assert.equal(denyMachine.approve(denyId, false).ok, true);
				const denied = await waitFor(denyEvents.events, v => v.state === "failed", "deny failed");
				assert.equal(denied.kind, "script-declined");
				assert.ok(!existsSync(path.join(denyDest, "mkt-machine-skill")), "declined install must not write dest");
			} finally {
				await rm(denyDest, { recursive: true, force: true });
			}
		} finally {
			await rm(dest, { recursive: true, force: true });
		}
	});

	test("分支守卫：同名冲突归 failed{conflict}；skills.sh 缺 repo 在入口被拒", async () => {
		const dest = await makeDest();
		try {
			const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
				asFetch(async () => new Response(makeZip({ "SKILL.md": SKILL_MD }), { status: 200 })),
			);
			fetchSpyRef.value = fetchSpy;
			const { events, onState } = collect();
			const machine = new MarketplaceInstallMachine(onState);

			// 入口参数校验（RPC 400 语义，不走状态机）。
			assert.throws(() => machine.start({ source: "skills.sh", slug: "x" }, dest), /repo required/);

			const first = machine.start({ source: "skillhub", slug: "demo" }, dest);
			await waitFor(events, v => v.state === "done", "first done");
			// 无 overwrite 的第二次安装：verify 阶段预检冲突。
			const second = machine.start({ source: "skillhub", slug: "demo" }, dest);
			assert.notEqual(second, first);
			const conflict = await waitFor(events, v => v.installId === second && v.state === "failed", "conflict");
			assert.equal(conflict.kind, "conflict");
		} finally {
			await rm(dest, { recursive: true, force: true });
		}
	});
});
