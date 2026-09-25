import path from "node:path";
import type { AgentSessionEvent } from "../../session/agent-session-events";
import type { ConfiguredThinkingLevel } from "../../thinking";
import type { ScheduledTaskHandle } from "../../tools/schedule-task";
import {
	type CronRun,
	type CronSchedule,
	type CronStatus,
	type CronTask,
	computeNextRun,
	loadCronRuns,
	loadCronTasks,
	mergeCronTask,
	nextCronScheduleRuns,
	saveCronRuns,
	saveCronTasks,
	validateCronSchedule,
	validateCronTask,
} from "../crons";
import type { DaemonService } from "./types";

/**
 * ScheduleService — 定时任务（cron）管理面（L2 宿主服务，P1 第十刀抽取）。
 *
 * 能力缝声明（M2-2.4）：
 * - 输入：RPC `cron.list` / `cron.upsert` / `cron.runs` / `cron.nextRuns` /
 *   `cron.delete` / `cron.toggle` / `cron.runNow`；另在每次会话创建时经
 *   宿主 setScheduledTaskProvider 领走 `schedule_task` 工具桥（taskHandle）。
 * - 输出：各 RPC 返回值原样；crons.json / cron-runs.json 落盘；任务状态
 *   变更广播经注入的 onCronsChanged 扇出（宿主侧接 EventService）。
 * - 生命周期：start 从磁盘加载任务与运行记录并启动 30s 扫描器（到期任务
 *   在新会话中执行，kimi cron parity）；stop 清除扫描器（加载/卸载可逆）。
 *
 * 范围边界（有意不包，P1 纪律）：
 * - 会话创建/寻址/删除仍归宿主（DaemonSessionHost），经 deps 结构接口注入，
 *   保持服务对宿主无传递依赖、可单测。
 * - crons.ts 工具函数本体与 `schedule_task` 工具实现（tools/schedule-task.ts）
 *   原地保留；#pushTaskCompletion 的渠道推送（host.onAgentEnd）不属于本服务。
 *
 * 从 server.ts 巨型 switch 的七个 case 与配套私有方法原样搬移（P1 纪律：
 * 纯搬移不改行为，docs/review/0.5.0-m2-daemon-host-layering.md §5）。
 */

/** 活跃会话的定时任务相关切面（结构类型，避免 import DaemonSessionHost）。 */
export interface ScheduleLiveSession {
	agentSession: {
		subscribe: (listener: (e: AgentSessionEvent) => void) => () => void;
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

export class ScheduleService implements DaemonService {
	readonly key = "schedule";
	readonly routes = {
		"cron.list": "list",
		"cron.upsert": "upsert",
		"cron.runs": "runs",
		"cron.nextRuns": "nextRuns",
		"cron.delete": "deleteTask",
		"cron.toggle": "toggle",
		"cron.runNow": "runNow",
	} as const;

	readonly #deps: ScheduleServiceDeps;

	/** Scheduled tasks (cron): loaded from ~/.musepi/crons.json; a 30s
	 *  scanner runs due tasks in fresh sessions (kimi cron parity). */
	#cronTasks: CronTask[] = [];
	#cronRuns: CronRun[] = [];
	#cronTimer: ReturnType<typeof setInterval> | null = null;
	#cronStarting = new Set<string>();

	constructor(deps: ScheduleServiceDeps) {
		this.#deps = deps;
	}

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

	/** Session ids owned by scheduled tasks (run history + last run per
	 *  task) — the GUI groups them apart from regular sessions. */
	sessionIds(): Set<string> {
		const ids = new Set<string>();
		for (const task of this.#cronTasks) {
			const last = task.state?.lastSessionId;
			if (last) ids.add(last);
		}
		for (const run of this.#cronRuns) {
			if (run.sessionId) ids.add(run.sessionId);
		}
		return ids;
	}

	/** Scheduled-task scanner: fire every enabled task whose nextRunAt is
	 *  due (or missing — first enable after a manual edit recomputes it on
	 *  the next tick). Runs are fire-and-forget; the per-session agent
	 *  subscription updates state when the turn finishes. */
	#cronScan(): void {
		const now = Date.now();
		for (const task of this.#cronTasks) {
			if (!task.enabled) continue;
			if (this.#cronStarting.has(task.id)) continue;
			if (task.state.nextRunAt === undefined || task.state.nextRunAt <= now) {
				void this.#cronRun(task);
			}
		}
	}

	/** Execute one scheduled task in a fresh session bound to its cwd. */
	async #cronRun(task: CronTask): Promise<void> {
		if (this.#cronStarting.has(task.id)) return;
		this.#cronStarting.add(task.id);
		const startedAt = Date.now();
		const run: CronRun = {
			id: `run-${task.id}-${startedAt}`,
			taskId: task.id,
			startedAt,
			status: "running",
		};
		this.#cronRuns.push(run);
		saveCronRuns(this.#cronRuns);
		task.state.lastRunAt = startedAt;
		task.state.lastStatus = "running";
		task.state.lastError = undefined;
		task.state.nextRunAt = computeNextRun(task, startedAt) ?? undefined;
		saveCronTasks(this.#cronTasks);
		this.#deps.onCronsChanged();
		let live: ScheduleLiveSession | undefined;
		try {
			const { sessionId } = await this.#deps.createSession({
				cwd: task.cwd || undefined,
				modelPattern: task.model || undefined,
				thinkingLevel:
					task.thinkingLevel && task.thinkingLevel !== "default"
						? (task.thinkingLevel as unknown as ConfiguredThinkingLevel)
						: undefined,
			});
			live = this.#deps.get(sessionId);
			if (!live) throw new Error("session not adopted");
			run.sessionId = sessionId;
			task.state.lastSessionId = sessionId;
			saveCronTasks(this.#cronTasks);
			const finish = (status: CronStatus, error?: string): void => {
				if (run.finishedAt !== undefined) return; // already settled (abort raced agent_end)
				run.status = status;
				run.finishedAt = Date.now();
				run.error = error;
				task.state.lastStatus = status;
				task.state.lastError = error;
				saveCronRuns(this.#cronRuns);
				saveCronTasks(this.#cronTasks);
				this.#cronStarting.delete(task.id);
				this.#deps.onCronsChanged();
			};
			const unsubscribe = live.agentSession.subscribe(e => {
				if (e.type !== "agent_end") return;
				unsubscribe();
				// A failed run is marked by the agent's final assistant message
				// (stopReason "aborted"/"error" + errorMessage); any other end
				// — including toolUse chain terminations — completed normally.
				const lastAssistant = [...e.messages].reverse().find(m => m.role === "assistant");
				const stop = lastAssistant?.stopReason;
				if (stop === "aborted" || stop === "error") {
					finish("error", lastAssistant?.errorMessage || `agent run ${stop}`);
				} else {
					finish("success");
				}
			});
			await live.agentSession.sendUserMessage(task.prompt);
		} catch (err) {
			run.status = "error";
			run.finishedAt = Date.now();
			run.error = err instanceof Error ? err.message : String(err);
			task.state.lastStatus = "error";
			task.state.lastError = run.error;
			saveCronRuns(this.#cronRuns);
			saveCronTasks(this.#cronTasks);
			this.#cronStarting.delete(task.id);
			this.#deps.onCronsChanged();
		}
	}

	/**
	 * Create/merge one scheduled task into the daemon-owned list and persist it
	 * (issue #11). Shared by the `cron.upsert` RPC and the in-session
	 * `schedule_task` tool — the daemon owns `#cronTasks` in memory, so a tool
	 * writing crons.json directly would be clobbered by the next save.
	 */
	#upsertCronTask(task: CronTask): CronTask {
		const now = Date.now();
		const existing = task.id ? this.#cronTasks.find(x => x.id === task.id) : undefined;
		const merged = mergeCronTask(existing, task, now, process.cwd());
		if (existing) this.#cronTasks = this.#cronTasks.map(x => (x.id === existing.id ? merged : x));
		else this.#cronTasks.push(merged);
		saveCronTasks(this.#cronTasks);
		this.#deps.onCronsChanged();
		return merged;
	}

	/** Bridge handed to the `schedule_task` tool on every session create.
	 *  `sessionCwd` is that session's workspace, which owns every `cwd` this
	 *  handle defaults — never the daemon's own launch directory (issue #30). */
	taskHandle(sessionCwd: string): ScheduledTaskHandle {
		// Resolve once, cross-platform-normalised: the GUI records projects
		// with native separators, so a task stored as `D:/x` would never
		// group under `D:\x` (issue #30, part 2).
		const fallbackCwd = path.resolve(sessionCwd || process.cwd());
		const resolveCwd = (raw: string | undefined): string => {
			const t = raw?.trim();
			// Blank means "the session's workspace" per the tool schema and the
			// task-center placeholder — not the daemon's cwd.
			return t ? path.resolve(t) : fallbackCwd;
		};
		return {
			upsert: async input => {
				const candidate = {
					id: input.id ?? "",
					name: input.name,
					enabled: true,
					schedule: input.schedule,
					prompt: input.prompt,
					cwd: resolveCwd(input.cwd),
					...(input.model ? { model: input.model } : {}),
					...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
					state: { createdAt: Date.now() },
				};
				// Same validator the RPC path uses — a bad schedule must fail
				// here with a clear message, not arm a task that never fires.
				const check = validateCronTask(candidate);
				if (!check.ok) throw new Error(check.error ?? "invalid schedule");
				return this.#upsertCronTask(candidate as CronTask);
			},
			list: async () => this.#cronTasks,
			defaultCwd: () => fallbackCwd,
		};
	}

	/** RPC cron.list：任务全量 + 全局最近 20 条运行记录。 */
	list(): { tasks: CronTask[]; runs: CronRun[] } {
		return { tasks: this.#cronTasks, runs: this.#cronRuns.slice(-20) };
	}

	/** RPC cron.upsert：校验并创建/合并一个定时任务。 */
	upsert(params: unknown): { tasks: CronTask[]; task: CronTask } {
		const { task } = (params ?? {}) as { task?: unknown };
		const check = validateCronTask(task);
		if (!check.ok) throw new Error(`cron.upsert: ${check.error}`);
		const merged = this.#upsertCronTask(task as CronTask);
		return { tasks: this.#cronTasks, task: merged };
	}

	/** RPC cron.runs：单任务运行历史（newest-first，受落盘 100 条窗口上限约束）。 */
	runs(params: unknown): { runs: CronRun[] } {
		// Per-task run history (cron.list only carries the global last
		// 20): newest-first, bounded by the on-disk 100-run window.
		const { id, limit } = (params ?? {}) as { id?: string; limit?: number };
		const cap = Math.min(Math.max(limit ?? 50, 1), 100);
		const runs = (id ? this.#cronRuns.filter(r => r.taskId === id) : this.#cronRuns).slice(-cap).reverse();
		return { runs };
	}

	/** RPC cron.nextRuns：编辑器预览——用 daemon 自己的解析器算未来触发点。 */
	nextRuns(params: unknown): { runs: number[] } {
		// Editor preview: the daemon's own parser (timezone +
		// idle-window semantics) so clients don't fork the logic.
		const { schedule, count } = (params ?? {}) as { schedule?: CronSchedule; count?: number };
		const check = validateCronSchedule(schedule);
		if (!check.ok) throw new Error(`cron.nextRuns: ${check.error}`);
		const runs = nextCronScheduleRuns(schedule as CronSchedule, Date.now(), Math.min(Math.max(count ?? 4, 1), 10));
		return { runs };
	}

	/** RPC cron.delete：删除任务；cleanup="delete" 时连带处置其全部会话。 */
	async deleteTask(params: unknown): Promise<{ tasks: CronTask[] }> {
		const { id, cleanup } = (params ?? {}) as { id?: string; cleanup?: "none" | "archive" | "delete" };
		if (!id) throw new Error("cron.delete: id required");
		const task = this.#cronTasks.find(t => t.id === id);
		this.#cronTasks = this.#cronTasks.filter(t => t.id !== id);
		this.#cronStarting.delete(id);
		saveCronTasks(this.#cronTasks);
		// Task-scoped session disposal (GUI asks after the delete
		// confirm dialog): "delete" removes each session the task ever
		// ran — journal, materialized row AND the SDK transcript file
		// (deleteSession now removes the transcript too), so the
		// file-scan history cannot resurrect it.
		if (cleanup === "delete" && task) {
			const sessionIds = new Set<string>();
			if (task.state.lastSessionId) sessionIds.add(task.state.lastSessionId);
			for (const run of this.#cronRuns) {
				if (run.taskId === task.id && run.sessionId) sessionIds.add(run.sessionId);
			}
			for (const sid of sessionIds) {
				await this.#deps.deleteSession(sid);
			}
			this.#cronRuns = this.#cronRuns.filter(r => r.taskId !== task.id);
			saveCronRuns(this.#cronRuns);
		}
		this.#deps.onCronsChanged();
		return { tasks: this.#cronTasks };
	}

	/** RPC cron.toggle：启停任务并重算（或清空）下次触发时间。 */
	toggle(params: unknown): { tasks: CronTask[] } {
		const { id, enabled } = (params ?? {}) as { id?: string; enabled?: boolean };
		const task = this.#cronTasks.find(t => t.id === id);
		if (!task) throw new Error(`cron.toggle: unknown task "${id}"`);
		task.enabled = enabled !== false;
		task.state.nextRunAt = task.enabled ? (computeNextRun(task, Date.now()) ?? undefined) : undefined;
		saveCronTasks(this.#cronTasks);
		this.#deps.onCronsChanged();
		return { tasks: this.#cronTasks };
	}

	/** RPC cron.runNow：立即在全新会话中执行一次任务（fire-and-forget）。 */
	runNow(params: unknown): { ok: true; tasks: CronTask[] } {
		const { id } = (params ?? {}) as { id?: string };
		const task = this.#cronTasks.find(t => t.id === id);
		if (!task) throw new Error(`cron.runNow: unknown task "${id}"`);
		void this.#cronRun(task);
		this.#deps.onCronsChanged();
		return { ok: true, tasks: this.#cronTasks };
	}
}
