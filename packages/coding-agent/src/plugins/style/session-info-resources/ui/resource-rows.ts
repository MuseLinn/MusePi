/**
 * 「资源」分区的读数投影：把一份 `system.resources` 采样变成三行「标签 / 条长 /
 * 数值」。组件只负责把这三行画出来，格式与百分比都在这里 —— 首次采样
 * `cpuPercent` 为 `null` 的显示规则是分区最容易被写错的一条（写成 0% 会被读成
 * 「刚测到空闲」），所以它有自己的可测边界。
 */

/** `system.resources` 的只读投影：本分区只读这些读数。 */
export interface ResourceSampleView {
	process: {
		/** 常驻集大小，字节。 */
		rss: number;
		/** JS 堆在用，字节。 */
		heapUsed: number;
		/** 距上一次采样的进程 CPU%（单核为 100%，多核可超过）；首次为 null。 */
		cpuPercent: number | null;
		/** 进程重启时间，毫秒。 */
		uptimeMs: number;
		/** 采样所属进程；行标题用它说明「这一行是谁」。 */
		pid: number;
	};
	system: {
		/** 距上一次采样的整机 CPU%，0–100；首次为 null。 */
		cpuPercent: number | null;
		/** 已用内存，字节。 */
		memUsed: number;
		/** 总内存，字节。 */
		memTotal: number;
		/** 逻辑核数：进程 CPU% 超过 100% 时，只有它能让读数说得通。 */
		cpuCount: number;
	};
}

/** 一行读数；`percent` 是条长，`null` 表示还没有基线（条形留空）。 */
export interface ResourceRowView {
	readonly label: string;
	readonly percent: number | null;
	readonly value: string;
	/**
	 * 悬停说明。读数本身放不进一行的东西（pid、堆、运行时长、核数）在这里，
	 * 而不是再加一行或把数字压成第二层。
	 */
	readonly title: string;
}

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * 1024;
const BYTES_PER_GB = BYTES_PER_MB * 1024;

/** 512 MB / 12.5 GB —— GB 以下取整 MB，KB 只用于极小的读数。 */
export function formatBytes(bytes: number): string {
	if (bytes >= BYTES_PER_GB) return `${(bytes / BYTES_PER_GB).toFixed(1)} GB`;
	if (bytes >= BYTES_PER_MB) return `${Math.round(bytes / BYTES_PER_MB)} MB`;
	return `${Math.round(bytes / BYTES_PER_KB)} KB`;
}

/** 3.2%；`null` 是「还没有差分」，显示 `—` 而不是 0%。 */
export function formatPercent(percent: number | null): string {
	return percent === null ? "—" : `${percent.toFixed(1)}%`;
}

/** 2h14m / 47m / 12s —— 进程运行时长。 */
export function formatUptime(uptimeMs: number): string {
	const seconds = Math.max(0, Math.floor(uptimeMs / 1000));
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	if (hours > 0) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
	if (minutes > 0) return `${minutes}m`;
	return `${seconds}s`;
}

/** 0–100 的条长；未知或非有限值返回 null，绝不画满。 */
function clampPercent(percent: number | null): number | null {
	if (percent === null || !Number.isFinite(percent)) return null;
	return Math.min(100, Math.max(0, percent));
}

/** part 占 total 的比例；total 非正（异常读数）时视为未知。 */
function share(part: number, total: number): number | null {
	return total > 0 ? clampPercent((part / total) * 100) : null;
}

/** 三行读数，顺序即卡片里的阅读顺序。 */
export function resourceRows(sample: ResourceSampleView): ResourceRowView[] {
	const proc = sample.process;
	const system = sample.system;
	return [
		{
			label: "MusePi",
			// 条长是进程常驻内存占整机内存的比例：回答「这个进程占了这台机器的多少」。
			percent: share(proc.rss, system.memTotal),
			value: `${formatBytes(proc.rss)} · ${formatPercent(proc.cpuPercent)}`,
			// 「daemon」不是装饰：读数来自 daemon 进程，连远程会话时它描述的是
			// 那台机器，而不是你正在看的界面。
			title: `MusePi daemon · pid ${proc.pid} · heap ${formatBytes(proc.heapUsed)} · up ${formatUptime(proc.uptimeMs)}`,
		},
		{
			label: "CPU",
			percent: clampPercent(system.cpuPercent),
			value: formatPercent(system.cpuPercent),
			// 进程读数按单核算，超过 100% 只在多核机器上可能；核数是它的单位。
			title: `${system.cpuCount} cores`,
		},
		{
			label: "Memory",
			percent: share(system.memUsed, system.memTotal),
			value: `${formatBytes(system.memUsed)} / ${formatBytes(system.memTotal)}`,
			title: `${formatBytes(system.memUsed)} of ${formatBytes(system.memTotal)}`,
		},
	];
}
