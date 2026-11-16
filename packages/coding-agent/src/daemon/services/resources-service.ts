import * as os from "node:os";
import type { DaemonService } from "./types";

/**
 * ResourcesService — 进程与整机资源读数（L2 宿主服务）。
 *
 * 能力缝声明：
 * - 名称/命名空间：`resources`；RPC `system.resources`。
 * - 输入：无参数。
 * - 输出：`ResourceSample`——进程 pid/rss/heapUsed/cpuPercent/uptimeMs 与整机
 *   cpuPercent/memUsed/memTotal/cpuCount。两个 cpuPercent 都是「距上一次采样」
 *   的相对值，首次调用为 `null`。
 * - 生命周期：惰性差分，无定时器；实例只保存上一次的墙钟与 CPU 累计快照，
 *   每次 `sample()` 推进基线。调用方决定采样节奏：多个轮询者共享同一条
 *   基线，CPU% 因此是彼此间隔的切分，而不是窗口平均值。
 * - 启停：常驻，无启停副作用；快照只是内存中的两个计数器。
 * - 冲突：只读采样，不触碰会话、事件、设置或连接面。0/负的墙钟或 CPU
 *   差值（时钟回退、计数器回绕）返回 `null`，不产生 NaN/Infinity。
 */
export interface ResourceSample {
	/** 采样时刻（服务端时钟毫秒）。 */
	sampledAt: number;
	process: {
		pid: number;
		/** 常驻集大小，字节。 */
		rss: number;
		/** JS 堆在用，字节。 */
		heapUsed: number;
		/** 相对上一次采样的进程 CPU 占用，按单核百分比（多核可超过 100）；首次调用为 null。 */
		cpuPercent: number | null;
		uptimeMs: number;
	};
	system: {
		/** 相对上一次采样的整机 CPU 占用，按全部核心平均，0–100；首次调用为 null。 */
		cpuPercent: number | null;
		/** 已用内存，字节（totalmem - freemem）。 */
		memUsed: number;
		memTotal: number;
		cpuCount: number;
	};
}

/** 一次 CPU 累计快照：墙钟毫秒 + 进程微秒累计 + 整机 idle/total 毫秒累计。 */
interface CpuSnapshot {
	wallClockMs: number;
	processMicros: number;
	systemIdleMs: number;
	systemTotalMs: number;
}

export class ResourcesService implements DaemonService {
	readonly key = "resources";
	readonly routes = {
		"system.resources": "sample",
	} as const;

	#previous: CpuSnapshot | undefined;

	sample(): ResourceSample {
		const sampledAt = Date.now();
		const usage = process.cpuUsage();
		const memory = process.memoryUsage();
		const current: CpuSnapshot = {
			wallClockMs: sampledAt,
			processMicros: usage.user + usage.system,
			...systemCpuTotals(os.cpus()),
		};

		const previous = this.#previous;
		let processCpuPercent: number | null = null;
		let systemCpuPercent: number | null = null;
		if (previous) {
			const wallDeltaMs = current.wallClockMs - previous.wallClockMs;
			// 时钟回退或同毫秒重入：保留旧基线，下一次采样仍从它起算。
			if (wallDeltaMs > 0) {
				processCpuPercent = percentOf(current.processMicros - previous.processMicros, wallDeltaMs * 1000);
				systemCpuPercent = systemCpuPercentOf(current, previous);
				this.#previous = current;
			}
		} else {
			this.#previous = current;
		}

		const memTotal = os.totalmem();
		return {
			sampledAt,
			process: {
				pid: process.pid,
				rss: memory.rss,
				heapUsed: memory.heapUsed,
				cpuPercent: processCpuPercent,
				uptimeMs: Math.round(process.uptime() * 1000),
			},
			system: {
				cpuPercent: systemCpuPercent,
				memUsed: Math.max(0, memTotal - os.freemem()),
				memTotal,
				cpuCount: os.cpus().length,
			},
		};
	}
}

function systemCpuTotals(cpus: os.CpuInfo[]): { systemIdleMs: number; systemTotalMs: number } {
	let idle = 0;
	let total = 0;
	for (const cpu of cpus) {
		const { user, nice, sys, idle: cpuIdle, irq } = cpu.times;
		idle += cpuIdle;
		total += user + nice + sys + cpuIdle + irq;
	}
	return { systemIdleMs: idle, systemTotalMs: total };
}

/** 进程 CPU 时间占墙钟的比例，单核为 100%（多核可超过 100）。 */
function percentOf(deltaMicros: number, wallDeltaMicros: number): number | null {
	if (deltaMicros < 0 || wallDeltaMicros <= 0) return null;
	return (deltaMicros / wallDeltaMicros) * 100;
}

/** 整机 CPU 占用 = 1 - idle 增量 / total 增量，按全部核心平均。 */
function systemCpuPercentOf(current: CpuSnapshot, previous: CpuSnapshot): number | null {
	const idleDelta = current.systemIdleMs - previous.systemIdleMs;
	const totalDelta = current.systemTotalMs - previous.systemTotalMs;
	if (totalDelta <= 0 || idleDelta < 0) return null;
	return Math.min(100, Math.max(0, (1 - idleDelta / totalDelta) * 100));
}
