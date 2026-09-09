/**
 * Widget task metadata (kimi parity: cards can own a runnable task — a
 * 运行 button on the card head, a 查看任务 entry in the three-dot menu,
 * and a task info modal with status/name/description/recent runs).
 */
export interface WidgetTask {
	/** Task enabled toggle (小组件任务 modal). */
	enabled: boolean;
	name: string;
	desc: string;
	/** Recent runs, newest first. */
	runs: { time: string; success: boolean }[];
	/** Schedule: manual (run button only), hourly, daily. */
	schedule?: "manual" | "hourly" | "daily";
	/** Last auto/manual run (epoch ms) — the scheduler's clock for hourly /
	 *  daily due-ness. Set on first sight for scheduled tasks so a board
	 *  doesn't fire the instant it opens. */
	lastRunAt?: number;
}

export function hasTask(data: Record<string, unknown>): data is Record<string, unknown> & { task: WidgetTask } {
	const t = data?.task;
	return (
		typeof t === "object" &&
		t !== null &&
		typeof (t as WidgetTask).enabled === "boolean" &&
		typeof (t as WidgetTask).name === "string"
	);
}
