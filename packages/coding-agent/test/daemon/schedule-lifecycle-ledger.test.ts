/**
 * 收编第二刀：schedule 的生命周期权威移交给 cordis effect 账本。
 *
 * 改的是运行时装配顺序，不是业务逻辑：start 从"server.ts 构造器里手写的一行"
 * 变成"服务 apply 时由 cordis 代调"，stop 从"没人调"变成"disposer 反向回收"。
 * 两个方向各自钉一个可观测契约——
 *
 *  1. **start 侧（回归风险最高的那一侧）**：从盘加载。去掉手写 `start()` 而
 *     没把服务翻到 cordis 生命周期，`#cronTasks` 会停在字段初始值 `[]`，
 *     于是用户重启后定时任务**静默消失**——不报错、不加载，`list()` 只是空的。
 *     用例把一个任务先落盘，再断言 settle 之后 `list()` 能读回它。
 *  2. **stop 侧（本次新增的行为）**：daemon 关闭时真的让运行时清掉扫描器
 *     定时器。此前手写 start 没有对称的 stop，重启即漏一个 30s 定时器。
 *
 * 失败模式的共同形状都是"安静"：定时任务不跑，没有任何错误指向原因。
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { type CronTask, saveCronTasks } from "../../src/daemon/crons";
import { DaemonServer, type DaemonSessionHost } from "../../src/daemon/server";
import {
	isolateAgentDirForTest,
	isolateConfigRootForTest,
	restoreAgentDirForTest,
	restoreConfigRootForTest,
} from "../helpers/isolate-agent-dir";

/** setInterval 返回值别名：Node 是 Timeout、DOM 是 number，测试里只当不透明句柄。 */
type IntervalHandle = ReturnType<typeof setInterval>;
/** clearInterval 的入参在 Node 与 DOM 两套签名间不同，用 Parameters 取本仓实际那套。 */
type ClearableHandle = Parameters<typeof clearInterval>[0];

/** 只提供构造器真正碰到的面；其余宿主方法在 cron 路径上不被调用。 */
function makeServer(): DaemonServer {
	const host = {
		cwd: () => process.cwd(),
		get: () => undefined,
		snapshot: async () => ({ entries: [], state: {} }),
		setCollabToolProvider: () => {},
		setScheduledTaskProvider: () => {},
		setOnExtensionNotification: () => {},
	} as unknown as DaemonSessionHost;
	return new DaemonServer(host);
}

const SEEDED_TASK: CronTask = {
	id: "seeded-task",
	name: "nightly report",
	enabled: true,
	schedule: { kind: "daily", time: "03:00" },
	prompt: "run the suite",
	cwd: process.cwd(),
	state: { createdAt: 1_700_000_000_000 },
};

describe("收编第二刀 — schedule 生命周期归 cordis effect 账本", () => {
	let isolatedDir = "";
	let isolatedConfigRoot = "";

	beforeAll(async () => {
		// The cron store lives at the CONFIG ROOT (`<configRoot>/crons.json`),
		// which `setAgentDir` does not move — so the agent-dir redirect alone
		// let this suite's `saveCronTasks` seed `SEEDED_TASK` into the
		// developer's real `~/.musepi/crons.json`. Isolate both roots.
		isolatedDir = await isolateAgentDirForTest("schedule-ledger-");
		isolatedConfigRoot = await isolateConfigRootForTest("schedule-ledger-config-");
	});

	afterAll(async () => {
		await restoreConfigRootForTest(isolatedConfigRoot);
		await restoreAgentDirForTest(isolatedDir);
	}, 30000);

	test("settle 后定时任务从盘加载（start 由 apply 代调，非手写调用）", async () => {
		saveCronTasks([SEEDED_TASK]);
		const server = makeServer();
		await server.settleHostServices();
		const tasks = await server.scheduledTaskHandle(process.cwd()).list();
		// Failure mode if regressed: the manual `schedule.start()` is gone and the
		// service was never flipped onto the cordis lifecycle, so #cronTasks stays
		// `[]`. Every scheduled task silently vanishes on restart — no error, no
		// log line, just an empty task center.
		expect(tasks.map(t => t.id)).toContain(SEEDED_TASK.id);
		await server.disposeHostContext();
	});

	test("未 settle 不等于加载完成（挂载落定是启动方的责任）", async () => {
		saveCronTasks([SEEDED_TASK]);
		const server = makeServer();
		// Constructing alone must not be mistaken for a mounted daemon: the mount
		// promise is pending until someone awaits it. If a future refactor applies
		// services synchronously in the constructor, this assertion is the tripwire
		// that says startup ordering changed and needs a look.
		const beforeSettle = await server.scheduledTaskHandle(process.cwd()).list();
		expect(beforeSettle.map(t => t.id)).not.toContain(SEEDED_TASK.id);
		await server.settleHostServices();
		const afterSettle = await server.scheduledTaskHandle(process.cwd()).list();
		expect(afterSettle.map(t => t.id)).toContain(SEEDED_TASK.id);
		await server.disposeHostContext();
	});

	test("dispose 回收本进程生命周期内创建的全部定时器（手写 start 的对称缺口）", async () => {
		saveCronTasks([SEEDED_TASK]);
		const created: { handle: IntervalHandle; delay: number | undefined }[] = [];
		const cleared: unknown[] = [];
		// Spying across construction AND settle, not just settle: a leftover manual
		// `schedule.start()` fires in the constructor, before any settle-time spy.
		const setSpy = spyOn(globalThis, "setInterval").mockImplementation(
			(_handler: () => void, delay?: number): IntervalHandle => {
				const handle = { probe: created.length } as unknown as IntervalHandle;
				created.push({ handle, delay });
				return handle;
			},
		);
		// clearInterval is doubly-overloaded (Node Timeout / DOM number); the stub only
		// observes calls, so it is narrowed back to the real signature rather than
		// widened with ny.
		const clearSpy = spyOn(globalThis, "clearInterval").mockImplementation(((handle: ClearableHandle): void => {
			cleared.push(handle);
		}) as typeof clearInterval);
		try {
			const server = makeServer();
			await server.settleHostServices();
			await server.disposeHostContext();
			// Failure mode if regressed: start is called twice (once by the leftover
			// manual call, once by the cordis apply), so ScheduleService overwrites its
			// handle and the first interval is orphaned — one live 30s scanner per
			// restart, invisible until the process is long-lived. Asserting "all
			// created handles were cleared" catches that; asserting a count would not
			// (the second start overwrites the reference either way).
			expect(created.length).toBeGreaterThan(0);
			expect(created.filter(c => !cleared.includes(c.handle))).toEqual([]);
		} finally {
			setSpy.mockRestore();
			clearSpy.mockRestore();
		}
	});
});
