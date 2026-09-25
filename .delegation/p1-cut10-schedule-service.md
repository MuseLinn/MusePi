# P1 第十刀：ScheduleService 抽取（cron.* 一组，7 路由）

你在 `musepi-omp` 仓库（Bun monorepo）执行一次**纯搬移式**服务抽取。纪律：不改行为、不改消息文本、不改时序语义；只搬代码、改委托接线。先例文件（必须先读，照抄其结构与注释风格）：

- `packages/coding-agent/src/daemon/services/approval-service.ts`（结构切面注入先例）
- `packages/coding-agent/src/daemon/services/types.ts`（DaemonService 接口；start/stop 已定义但尚无服务实现——本刀是第一个）
- `packages/coding-agent/src/daemon/services/remote-service.ts`（薄服务 + routes 映射先例）
- `packages/coding-agent/src/daemon/services/route-coverage.test.ts`（注册 stub 先例）

设计约束文档：`docs/review/0.5.0-m2-daemon-host-layering.md`（§5 P1 顺序、§能力缝纪律）。头注释用简体中文、遵循"能力缝声明 + 范围边界"两段式（照抄 approval-service.ts 的写法）。

## 一、新建 `packages/coding-agent/src/daemon/services/schedule-service.ts`

`key = "schedule"`，routes：

```ts
readonly routes = {
	"cron.list": "list",
	"cron.upsert": "upsert",
	"cron.runs": "runs",
	"cron.nextRuns": "nextRuns",
	"cron.delete": "deleteTask",
	"cron.toggle": "toggle",
	"cron.runNow": "runNow",
} as const;
```

### 依赖注入（构造 deps，全部 lazy 调用，避免循环）

```ts
export interface ScheduleLiveSession {
	agentSession: {
		subscribe: (listener: (e: never) => void) => () => void;
		sendUserMessage: (text: string) => Promise<void>;
	};
}
export interface ScheduleServiceDeps {
	createSession(opts: {
		cwd?: string;
		modelPattern?: string;
		thinkingLevel?: ConfiguredThinkingLevel;
	}): Promise<{ sessionId: string }>;
	get(sessionId: string): ScheduleLiveSession | undefined;
	deleteSession(sessionId: string): Promise<void>;
	onCronsChanged(): void;
}
```

`subscribe` 的实际事件类型以 server.ts `#cronRun` 里 `live.agentSession.subscribe(e => {...})` 的用法为准——用与 AgentSession 匹配的真实类型（import type 即可），上面 `never` 只是示意；**调用形状必须与原代码逐字一致**（`e.type !== "agent_end"`、`e.messages`、`stopReason`、`errorMessage`、`unsubscribe()` 返回值）。

### 拥有的状态（从 DaemonServer 原样搬入，私有字段同名）

`#cronTasks: CronTask[]`、`#cronRuns: CronRun[]`、`#cronTimer`、`#cronStarting: Set<string>`。

### 方法（全部从 server.ts 原样搬移，逻辑逐字）

- `list()` ← case "cron.list"（server.ts:5208-5210）：`return { tasks: this.#cronTasks, runs: this.#cronRuns.slice(-20) };`
- `upsert(params)` ← case "cron.upsert"（5211-5217）：validateCronTask 校验、`cron.upsert: ${check.error}` 抛错、走 `#upsertCronTask`。
- `runs(params)` ← case "cron.runs"（5218-5225）：cap 夹取逻辑原样（`Math.min(Math.max(limit ?? 50, 1), 100)`），注释也搬。
- `nextRuns(params)` ← case "cron.nextRuns"（5226-5238）：validateCronSchedule、`nextCronScheduleRuns`、count 夹取（1..10），注释搬。
- `deleteTask(params)` ← case "cron.delete"（5239-5265）：**含全部 cleanup 语义**——id 必填抛 `cron.delete: id required`；从 `#cronTasks` 过滤、`#cronStarting.delete(id)`、`saveCronTasks`；`cleanup === "delete" && task` 时收集 `task.state.lastSessionId` + 该 task 全部 run 的 sessionId，`await this.#deps.deleteSession(sid)` 逐个删，然后 `#cronRuns` 过滤 + `saveCronRuns`；最后 `this.#deps.onCronsChanged()`。上方 4 行英文注释（issue 说明）原样搬。
- `toggle(params)` ← case "cron.toggle"（5266-5275）：未知 task 抛 `cron.toggle: unknown task "${id}"`；enabled/nextRunAt/computeNextRun 逻辑原样。
- `runNow(params)` ← case "cron.runNow"（5276-5283）：未知 task 抛 `cron.runNow: unknown task "${id}"`；`void this.#cronRun(task)`（方法内部改用直接调用）、`onCronsChanged`、`{ ok: true, tasks: this.#cronTasks }`。
- `taskHandle(sessionCwd: string): ScheduledTaskHandle` ← `scheduledTaskHandle`（3634-3667）整体搬入改为公开方法 `taskHandle`：`resolveCwd`/`fallbackCwd`（`path.resolve(sessionCwd || process.cwd())`）、upsert 候选构造、`validateCronTask` 失败抛 `check.error ?? "invalid schedule"`、内部走本类 `#upsertCronTask`、`list: async () => this.#cronTasks`、`defaultCwd`。**上方的英文 doc 注释（"Bridge handed to the `schedule_task` tool…" 与 issue #30 两行）原样保留。**
- `sessionIds(): Set<string>` ← `#cronSessionIds()`（3018-3028），连同其上方两行 doc 注释。
- 私有 `#upsertCronTask(task)` ← 3620-3629（含上方 5 行 doc 注释，其中 "the daemon owns `#cronTasks`" 措辞保留）。
- 私有 `#cronScan()` ← 3244-3253。
- 私有 `#cronRun(task)` ← 3371-3442 **整段逐字**：`#cronStarting` 守卫、run 记录构造、`saveCronRuns`/`saveCronTasks`、3 处 `onCronsChanged` 改为 `this.#deps.onCronsChanged()`、`this.#deps.createSession({...})`（thinkingLevel 三元与 `as unknown as ConfiguredThinkingLevel` 保留）、`live` 非空否则 throw `session not adopted`、`finish` 闭包（含 already-settled 注释）、subscribe agent_end 判定（stopReason "aborted"/"error"、errorMessage、`agent run ${stop}` 模板串）、catch 块错误落盘。`this.#host.get` 改为 `this.#deps.get`。

### 生命周期（DaemonService.start/stop 的首次落地）

```ts
start(): void {
	this.#cronTasks = loadCronTasks();
	this.#cronRuns = loadCronRuns();
	this.#cronTimer = setInterval(() => this.#cronScan(), 30_000);
	this.#cronTimer.unref?.();
}
stop(): void {
	if (this.#cronTimer) clearInterval(this.#cronTimer);
	this.#cronTimer = null;
}
```

字段初始值改为空（`#cronTasks: CronTask[] = []` 等），加载职责归 start。

### 服务文件 import

从 `"../crons"` 引：`type CronRun`、`type CronSchedule`、`type CronStatus`、`type CronTask`、`computeNextRun`、`loadCronRuns`、`loadCronTasks`、`mergeCronTask`、`nextCronScheduleRuns`、`saveCronRuns`、`saveCronTasks`、`validateCronSchedule`、`validateCronTask`；从 `"../tools/schedule-task"` 引 `type ScheduledTaskHandle`；`import path from "node:path"`；`ConfiguredThinkingLevel` 的类型来源照抄 server.ts 现有 import（grep 确认出处）。`type { DaemonService } from "./types"`。

## 二、server.ts 改动（行号基于 HEAD，允许因编辑轻微漂移，以标识符为准）

1. **删除 cron 状态与逻辑**：字段 3005-3008（4 个）、`#cronSessionIds` 3016-3028、`#cronScan` 3244-3253、`#cronRun` 3371-3442、`#upsertCronTask` 3614-3629、公开方法 `scheduledTaskHandle` 3631-3667。
2. **构造函数注册**（RemoteService 注册行 3079 之后、原 cron 初始化 3080-3083 处）：

```ts
const schedule = new ScheduleService({
	createSession: opts => this.#host.createSession(opts),
	get: sessionId => this.#host.get(sessionId),
	deleteSession: sessionId => this.#host.deleteSession(sessionId),
	onCronsChanged: () => this.#services.get<EventService>("events").broadcastCronsChanged(),
});
this.#services.register(schedule);
schedule.start();
```

   替换掉 3080-3083 四行（loadCronTasks/loadCronRuns/setInterval/unref）。**不要**写 `void schedule.start()`——start 是 sync void；也不要把它塞进 register() 参数里（需要引用实例）。
3. **3032 行** `host.setScheduledTaskProvider(sessionCwd => this.scheduledTaskHandle(sessionCwd));` 改为
   `host.setScheduledTaskProvider(sessionCwd => this.#services.get<ScheduleService>("schedule").taskHandle(sessionCwd));`（lambda 是 lazy 的，注册后才被调用，无顺序问题；保留原行注释语境）。
4. **7 个 case**（5208-5283）整体替换为一行委托，带注释 `// 实现归 ScheduleService（cron 状态机语义不变）。`，形状照抄本文件已有先例：
   - `case "cron.list": return this.#services.get<ScheduleService>("schedule").list();`
   - `case "cron.upsert": return this.#services.get<ScheduleService>("schedule").upsert(params ?? {});`
   - `case "cron.runs":` / `case "cron.nextRuns":` / `case "cron.delete":` / `case "cron.toggle":` / `case "cron.runNow":` 同理（方法名见 routes 映射）。
5. **tray.state 等 3 处**（4039、4089、4261）`this.#cronSessionIds()` 改 `this.#services.get<ScheduleService>("schedule").sessionIds()`。
6. **import 清理**：server.ts 135-148 的 `"./crons"` 导入块整体删除（已确认 CronTask/CronRun/CronSchedule 的全部使用都在被搬代码内）；130 行 `ScheduledTaskHandle` 类型 import 保留（1183 行字段还在）；新增 `import { ScheduleService } from "./services/schedule-service";`（放在其他服务 import 旁，顺序按现有字母序）；`ConfiguredThinkingLevel` 若 server.ts 别处仍在用则保留，grep 确认后删不再用的。顶部 import `EventService` 保留。
7. **`import type { LiveSession }`**：若 `#cronRun` 删除后 LiveSession 在 server.ts 仍有其他使用则保留（grep 确认）。

## 三、legacy-routes.ts 与 route-coverage.test.ts

- `legacy-routes.ts`：删除 39-45 行 7 条 `cron.*`（保持字母序、无空行残留）。
- `route-coverage.test.ts`：import ScheduleService；注册 stub：
  `services.register(new ScheduleService({ createSession: async () => ({ sessionId: "" }), get: () => undefined, deleteSession: async () => {}, onCronsChanged: () => {} }));`
  （放在 RemoteService stub 旁，加一行 `// ScheduleService：stub 化宿主访问，仅参与路由表。`）

## 四、严禁触碰（P1 纪律）

- `#pushTaskCompletion`（3350 行起）及其 3148 行调用点（`host.onAgentEnd` 渠道推送，**不属于 cron 面**，原样保留）。
- channels/collab/extension watcher 初始化区（3084-3155）。
- crons.ts 工具函数本体、`schedule_task` 工具实现（`tools/schedule-task.ts`）。
- 任何行为/消息文本/时序改动；不得"顺手优化"。
- 注释块内不得出现 `git.`、`*/` 等会提前闭合块注释的序列。

## 五、验证（全部必须亲自跑过并在回复中贴结果）

```bash
cd packages/coding-agent
bunx biome check --write src/daemon
bun test src/daemon test/daemon
```

期望：daemon 相关测试 195 pass / 0 fail（与上一刀同基线）。

```bash
# 仓库根目录
bun run check:ts 2>&1 | grep -c "error TS"   # 期望 0
```

`git diff --stat` 汇报：新增 schedule-service.ts 行数、server.ts 净减行数。完成后回复：改动文件清单、验证输出原文、任何与原指令的偏差及理由。
