// ============================================================
// MusePi Task-Card Style Extension (swarm style)
//
// Registers the `display.taskCardStyle` setting via registerSetting so it
// appears in the settings panel ONLY while this extension is loaded
// (extension center: style:task-card-swarm). The setting gates:
//   - TUI: a Kimi-style braille member grid painted above the editor while
//     a `task` call runs — per-agent braille progress bars, phase symbols
//     and a segmented status line. Ported from the pi-muselinn-harness
//     swarm widget (itself a kimi-code `agent-swarm-progress` port), fed by
//     the `task` tool's `tool_execution_*` events. The native framed task
//     card stays in the transcript.
//   - GUI: the additive swarm member-grid card beside the native task card
//     (desktop-web ToolView SwarmCard).
//
// The legacy `swarm_run` extension (braille widget + fake executor) was
// never wired into the extension system and is removed — task tool is the
// real executor.
// ============================================================

import { truncateToWidth, visibleWidth } from "@musepi/pi-tui";
import { settings } from "../../config/settings";
import type { ExtensionAPI, ExtensionFactory, ExtensionUIContext } from "../../extensibility/extensions/types";
import type { Theme, ThemeColor } from "../../modes/theme/theme";

// ============================================================
// Constants (kimi-code swarm parity — pi-muselinn-harness port)
// ============================================================

const FRAME_INTERVAL_MS = 250;
const TASK_WIDGET_KEY = "task-swarm";
/** setInterval id — the legacy swarm-core package is removed; keep the
 *  alias local so this extension stays dependency-free. */
type SwarmTimerId = number;

/** Braille progress-bar glyphs (kimi-code agent-swarm-progress parity). */
const BRAILLE_LEVELS = ["⣀", "⣄", "⣤", "⣦", "⣶", "⣷", "⣿"] as const;
const BRAILLE_EMPTY = "⣀";
const BRAILLE_BAR_FILLED = "⣿";
const BRAILLE_BAR_MAX_WIDTH = 8;
const BRAILLE_BAR_MIN_WIDTH = 4;
const MIN_LABEL_WIDTH = 5;
const CELL_GAP = "  ";
const STATUS_BAR_CHAR = "━";
const LEFT_INDENT = " ";
/** Completed/failed fill-animation window (ms). */
const COMPLETE_FILL_MS = 360;
/** Grid height budget (rows) before the layout compacts. */
const GRID_HEIGHT = 10;

/** Per-member phase glyph (kimi parity). */
const STATUS_SYMBOLS: Record<TaskMemberStatus, string> = {
	pending: "○",
	running: "◉",
	done: "✓",
	failed: "✗",
	aborted: "⊘",
};

type TaskMemberStatus = "pending" | "running" | "done" | "failed" | "aborted";

interface TaskMemberView {
	id: string;
	label: string;
	status: TaskMemberStatus;
	toolCalls: number;
	tokens: number;
	/** Current tool/last intent (the "doing what" line for a live cell). */
	action: string;
	error: string;
}

function fmtTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
	return String(value);
}

// ============================================================
// Braille grid helpers (ported from pi-muselinn-harness
// packages/core/swarm/{helpers,types}.ts — kimi-code parity)
// ============================================================

/** Progress of a member: done/failed/aborted → full; running grows on tool
 *  calls via a soft asymptote (the daemon streams no estimated total, so a
 *  known-looking fraction would be fake — a growing bar reads honest). */
function computeProgress(m: TaskMemberView): number {
	if (m.status === "done" || m.status === "failed" || m.status === "aborted") return 1;
	if (m.status === "pending" || m.toolCalls <= 0) return 0;
	return Math.min(1, m.toolCalls / (m.toolCalls + 2));
}

/** Renders a braille progress bar for `progress` in [0, 1], with the same
 *  smooth completed-fill animation kimi-code uses (0 → 100% over
 *  COMPLETE_FILL_MS once the member settles). */
function accumulatedBrailleBar(
	progress: number,
	width: number,
	status: TaskMemberStatus,
	completedAtMs: number | undefined,
	nowMs: number,
): string {
	const innerWidth = Math.max(1, width);
	const dotsPerCell = BRAILLE_LEVELS.length;
	let displayProgress = progress;
	if ((status === "done" || status === "failed" || status === "aborted") && completedAtMs !== undefined) {
		const elapsed = Math.max(0, nowMs - completedAtMs);
		displayProgress = Math.min(1, progress + (1 - progress) * Math.min(1, elapsed / COMPLETE_FILL_MS));
	}
	displayProgress = Math.max(0, Math.min(1, displayProgress));
	const totalDots = Math.round(displayProgress * innerWidth * dotsPerCell);
	const cells: string[] = [];
	for (let i = 0; i < innerWidth; i++) {
		const cellStart = i * dotsPerCell;
		const filledDots = Math.max(0, Math.min(dotsPerCell, totalDots - cellStart));
		if (filledDots >= dotsPerCell) cells.push(BRAILLE_BAR_FILLED);
		else if (filledDots > 0) cells.push(BRAILLE_LEVELS[filledDots - 1]);
		else cells.push(BRAILLE_EMPTY);
	}
	return `[${cells.join("")}]`;
}

/** Kimi-style adaptive grid: text mode first, compact rows when the swarm
 *  outgrows the height budget. */
function gridLayout(
	count: number,
	availableWidth: number,
	availableHeight: number,
): { columns: number; rows: number; cellWidth: number; barCells: number } {
	if (count <= 0) return { columns: 1, rows: 0, cellWidth: 0, barCells: 1 };
	const gapWidth = visibleWidth(CELL_GAP);
	const idWidth = Math.max(3, String(count).length);
	const minCellWidth = idWidth + 1 + BRAILLE_BAR_MAX_WIDTH + 2 + MIN_LABEL_WIDTH + 2;
	const columns = Math.max(
		1,
		Math.min(count, Math.floor((availableWidth + gapWidth) / (Math.max(1, minCellWidth) + gapWidth))),
	);
	const rows = Math.ceil(count / columns);
	if (rows <= Math.max(1, availableHeight)) {
		const cellWidth = Math.floor((availableWidth - gapWidth * Math.max(0, columns - 1)) / columns);
		const barCells = Math.max(
			BRAILLE_BAR_MIN_WIDTH,
			Math.min(BRAILLE_BAR_MAX_WIDTH, cellWidth - idWidth - MIN_LABEL_WIDTH - 6),
		);
		return { columns, rows, cellWidth, barCells };
	}
	// Compact mode: same kimi fallback — narrower cells, more rows.
	const compactCols = Math.max(1, Math.min(count, Math.ceil(count / Math.max(1, availableHeight))));
	const compactRows = Math.ceil(count / compactCols);
	const compactCellWidth = Math.floor((availableWidth - gapWidth * Math.max(0, compactCols - 1)) / compactCols);
	const compactBarCells = Math.max(1, compactCellWidth - idWidth - 5);
	return { columns: compactCols, rows: compactRows, cellWidth: compactCellWidth, barCells: compactBarCells };
}

/** Extract per-member progress/results from a TaskToolDetails payload. */
function taskMembersFromDetails(details: unknown): TaskMemberView[] | null {
	if (!details || typeof details !== "object") return null;
	const d = details as Record<string, unknown>;
	const members: TaskMemberView[] = [];
	const seen = new Set<string>();
	for (const p of Array.isArray(d.progress) ? (d.progress as unknown[]) : []) {
		if (!p || typeof p !== "object") continue;
		const rec = p as Record<string, unknown>;
		const id = typeof rec.id === "string" ? rec.id : "";
		if (!id || seen.has(id)) continue;
		seen.add(id);
		const status = typeof rec.status === "string" ? rec.status : "running";
		const action =
			typeof rec.lastIntent === "string" && rec.lastIntent.length > 0
				? rec.lastIntent
				: typeof rec.currentTool === "string"
					? rec.currentTool
					: "";
		members.push({
			id,
			label:
				(typeof rec.description === "string" && rec.description) || (typeof rec.task === "string" ? rec.task : id),
			status:
				status === "completed"
					? "done"
					: status === "failed"
						? "failed"
						: status === "aborted"
							? "aborted"
							: status === "pending"
								? "pending"
								: "running",
			toolCalls: typeof rec.toolCount === "number" ? rec.toolCount : 0,
			tokens: typeof rec.tokens === "number" ? rec.tokens : 0,
			action,
			error: typeof rec.error === "string" ? rec.error : "",
		});
	}
	if (members.length === 0) return null;
	return members;
}

// ============================================================
// Task-card swarm widget (TUI above-editor braille grid)
// ============================================================

class TaskCardWidgetController {
	private readonly ui: ExtensionUIContext;
	private members: TaskMemberView[] = [];
	private settled = false;
	private frameTimer: SwarmTimerId | null = null;
	private lastWidth = 0;
	/** Per-member completion timestamp — drives the settled fill animation. */
	private readonly completedAt = new Map<string, number>();

	constructor(ui: ExtensionUIContext) {
		this.ui = ui;
	}

	start(members: TaskMemberView[]): void {
		this.members = members;
		this.settled = false;
		this.completedAt.clear();
		this.lastWidth = process.stdout.columns ?? 120;
		this.paint();
		this.frameTimer = setInterval(() => this.#tick(), FRAME_INTERVAL_MS) as unknown as SwarmTimerId;
	}

	update(members: TaskMemberView[]): void {
		this.members = members;
		if (this.frameTimer === null) this.start(members);
		else this.paint();
	}

	settle(members: TaskMemberView[]): void {
		this.members = members;
		this.settled = true;
		// Stamp completion times so the fill animation can play; the tick
		// keeps repainting until the fill settles, then stops itself.
		const now = Date.now();
		for (const m of this.members) {
			if ((m.status === "done" || m.status === "failed" || m.status === "aborted") && !this.completedAt.has(m.id)) {
				this.completedAt.set(m.id, now);
			}
		}
		this.paint(now);
		if (!this.#needsFrames(now)) this.stop();
	}

	stop(): void {
		if (this.frameTimer !== null) {
			clearInterval(this.frameTimer as unknown as number);
			this.frameTimer = null;
		}
		this.ui.setWidget(TASK_WIDGET_KEY, undefined);
	}

	/** True while the spinner / growing bars / fill animation need frames. */
	#needsFrames(nowMs: number): boolean {
		for (const m of this.members) {
			if (m.status === "running") return true;
			if ((m.status === "done" || m.status === "failed" || m.status === "aborted") && this.completedAt.has(m.id)) {
				const at = this.completedAt.get(m.id) ?? 0;
				if (nowMs - at < COMPLETE_FILL_MS) return true;
			}
		}
		return false;
	}

	#tick(): void {
		const width = process.stdout.columns ?? 120;
		const now = Date.now();
		if (width !== this.lastWidth) {
			this.lastWidth = width;
			this.paint(now);
			return;
		}
		if (this.#needsFrames(now)) {
			this.paint(now);
			return;
		}
		if (this.settled) this.stop();
	}

	private paint(nowMs = Date.now()): void {
		const theme = this.ui.theme;
		const width = this.lastWidth;
		const members = this.members;
		const total = members.length;
		let done = 0;
		let running = 0;
		let failed = 0;
		let aborted = 0;
		for (const m of members) {
			if (m.status === "done") done++;
			else if (m.status === "running") running++;
			else if (m.status === "failed") failed++;
			else if (m.status === "aborted") aborted++;
		}

		const lines: string[] = [];

		// Header: title + count chip, plus the first task description when
		// it fits on the same line.
		const title = theme.bold(theme.fg("accent", "Task"));
		let header = `${LEFT_INDENT}─ ${title}${theme.fg("muted", ` · ${done + failed + aborted}/${total} agent(s)`)}`;
		const firstLabel = members
			.find(m => m.label && m.label !== m.id)
			?.label.replace(/\s+/g, " ")
			.trim();
		if (firstLabel && firstLabel.length > 0) {
			const avail = width - visibleWidth(header) - 2;
			if (avail > 12) header += theme.fg("muted", ` ─ ${truncateToWidth(firstLabel, avail - 1)}`);
		}
		lines.push(truncateToWidth(header, width));

		// Kimi-style braille member grid: `id [braille-bar] ◉ action`.
		const grid = gridLayout(total, width - 2, GRID_HEIGHT);
		for (let row = 0; row < grid.rows; row++) {
			const cells: string[] = [];
			for (let col = 0; col < grid.columns; col++) {
				const idx = row * grid.columns + col;
				if (idx >= total) continue;
				const m = members[idx];
				const bar = accumulatedBrailleBar(
					computeProgress(m),
					grid.barCells,
					m.status,
					this.completedAt.get(m.id),
					nowMs,
				);
				const labelMaxWidth = Math.max(
					MIN_LABEL_WIDTH,
					grid.cellWidth - visibleWidth(m.id) - visibleWidth(bar) - 2,
				);
				const label = this.cellLabel(m, labelMaxWidth, theme);
				cells.push(`${theme.fg("muted", m.id)} ${this.colorBar(bar, m.status, theme)} ${label}`);
			}
			lines.push(LEFT_INDENT + cells.join(CELL_GAP));
		}

		// Status line: spinner + phase label + counts + segmented bar.
		const statusLine = this.buildStatusLine(theme, done, running, failed, aborted, total, nowMs, width);
		if (statusLine) lines.push(statusLine);

		// Tool/token footer (muted).
		if (members.some(m => m.toolCalls > 0 || m.tokens > 0)) {
			lines.push(
				LEFT_INDENT +
					theme.fg(
						"dim",
						truncateToWidth(
							members.map(m => `${m.toolCalls}t${m.tokens > 0 ? `/${fmtTokens(m.tokens)}` : ""}`).join(" · "),
							width - 2,
						),
					),
			);
		}
		this.ui.setWidget(TASK_WIDGET_KEY, lines);
	}

	private colorBar(bar: string, status: TaskMemberStatus, theme: Theme): string {
		switch (status) {
			case "running":
				return theme.fg("warning", bar);
			case "done":
				return theme.fg("success", bar);
			case "failed":
				return theme.fg("error", bar);
			case "aborted":
				return theme.fg("warning", bar);
			default:
				return theme.fg("muted", bar);
		}
	}

	/** One grid cell label: status glyph + current action (kimi parity). */
	private cellLabel(m: TaskMemberView, maxWidth: number, theme: Theme): string {
		const sym = STATUS_SYMBOLS[m.status] ?? "○";
		let label = `${sym} `;
		switch (m.status) {
			case "done":
				label += this.sanitize(m.action) || "Completed.";
				break;
			case "failed":
				label += theme.fg("error", this.sanitize(m.error) || "Failed.");
				break;
			case "aborted":
				label += theme.fg("warning", this.sanitize(m.error) || "Aborted.");
				break;
			case "running":
				label += this.sanitize(m.action) || "Working…";
				break;
			default:
				label += "Queued…";
		}
		return truncateToWidth(label, maxWidth);
	}

	private sanitize(text: string): string {
		return text.replace(/\s+/g, " ").trim();
	}

	/** Status line: spinner + phase label + per-phase counts + segmented bar. */
	private buildStatusLine(
		theme: Theme,
		done: number,
		running: number,
		failed: number,
		aborted: number,
		total: number,
		nowMs: number,
		width: number,
	): string {
		const phases: Array<{ count: number; color: ThemeColor }> = [];
		if (done > 0) phases.push({ count: done, color: "success" });
		if (running > 0) phases.push({ count: running, color: "warning" });
		const queued = total - done - running - failed - aborted;
		if (queued > 0) phases.push({ count: queued, color: "muted" });
		if (failed > 0) phases.push({ count: failed, color: "error" });
		if (aborted > 0) phases.push({ count: aborted, color: "warning" });
		if (phases.length === 0) return "";

		const frames = theme.spinnerFrames;
		const spinFrame = running > 0 ? `${frames[Math.floor(nowMs / 120) % frames.length] ?? "⠋"} ` : "";
		const label =
			running > 0 ? "Working…" : done === total ? "Completed." : failed > 0 || aborted > 0 ? "Failed." : "Pending.";
		const color: ThemeColor = running > 0 ? "warning" : done === total ? "success" : "error";
		const perPhase = [
			done > 0 ? `${done}✓` : "",
			running > 0 ? `${running}▶` : "",
			queued > 0 ? `${queued}○` : "",
			failed > 0 ? `${failed}✗` : "",
			aborted > 0 ? `${aborted}⊘` : "",
		]
			.filter(Boolean)
			.join(" ");
		const barWidth = Math.max(4, Math.min(40, Math.floor(width * 0.25)));
		const totalCount = phases.reduce((s, p) => s + p.count, 0);
		const segments = phases
			.map(p =>
				theme.fg(p.color, STATUS_BAR_CHAR.repeat(Math.max(1, Math.round((p.count / totalCount) * barWidth)))),
			)
			.join("");
		return truncateToWidth(
			`${LEFT_INDENT}${theme.fg(color, ` ${spinFrame}${label}`)} ${theme.fg("muted", perPhase)} ${segments}`,
			width,
		);
	}
}

// ============================================================
// Extension factory
// ============================================================

export function createTaskCardStyleExtension(options?: { enabled?: boolean }): ExtensionFactory {
	return (api: ExtensionAPI): void => {
		if (options?.enabled === false) return;
		api.registerSetting({
			key: "display.taskCardStyle",
			type: "enum",
			default: "swarm",
			ui: {
				tab: "appearance",
				group: "Display",
				label: "Task Card Style",
				description:
					"Task/swarm card render style: MusePi Swarm shows the member grid (TUI braille progress bars / GUI floating avatar grid); OMP original (Classic) keeps only the native tool-call card",
				options: [
					{
						value: "swarm",
						label: "MusePi Swarm",
						description:
							"Kimi-style member grid: per-agent braille progress bars (TUI) and avatar+progress floating card (GUI)",
					},
					{
						value: "classic",
						label: "OMP original (Classic)",
						description: "Plain tool-call card only — no swarm member grid",
					},
				],
			},
		});

		// TUI half: while a `task` call runs in swarm style, paint a braille
		// member grid above the editor (the native framed task card stays in
		// the transcript). Classic style keeps the plain card only.
		let widget: TaskCardWidgetController | null = null;
		const wantSwarm = (): boolean => {
			try {
				const raw = settings.getRaw("display.taskCardStyle");
				return raw !== "classic";
			} catch {
				return true; // settings not initialized yet — default swarm
			}
		};
		api.on("tool_execution_start", (event, ctx) => {
			if (event.toolName !== "task" || !wantSwarm() || !ctx.ui) return;
			// Start event args are the raw tool params (tasks array); prime
			// pending members — update events carry real TaskToolDetails.
			const args = event.args as { tasks?: unknown[] } | null | undefined;
			const list = Array.isArray(args?.tasks) ? args.tasks : [];
			const members: TaskMemberView[] = list.map((t, i) => ({
				id: typeof (t as { id?: unknown })?.id === "string" ? String((t as { id: unknown }).id) : `task-${i + 1}`,
				label:
					(typeof (t as { description?: unknown })?.description === "string" &&
						String((t as { description: unknown }).description)) ||
					(typeof (t as { task?: unknown })?.task === "string" ? String((t as { task: unknown }).task) : ""),
				status: "pending",
				toolCalls: 0,
				tokens: 0,
				action: "",
				error: "",
			}));
			if (members.length === 0) return;
			widget ??= new TaskCardWidgetController(ctx.ui);
			widget.start(members);
		});
		api.on("tool_execution_update", (event, ctx) => {
			if (event.toolName !== "task" || !wantSwarm() || !ctx.ui || widget === null) return;
			const details = (event.partialResult as { details?: unknown } | null | undefined)?.details;
			const members = taskMembersFromDetails(details);
			if (members) widget.update(members);
		});
		api.on("tool_execution_end", (event, ctx) => {
			if (event.toolName !== "task" || !ctx.ui || widget === null) return;
			const details = (event.result as { details?: unknown } | null | undefined)?.details;
			const members = taskMembersFromDetails(details);
			if (members) widget.settle(members);
			else widget.stop();
		});

		// Fallback cleanup: an interrupted/aborted `task` run may never send a
		// `tool_execution_end` (cursor.ts only synthesizes one for server
		// tools), which would leave the widget pinned above the editor after
		// the run. agent_end/session_shutdown are the reliable teardown
		// boundaries — drop the widget unconditionally there.
		const dropWidget = (): void => {
			if (widget === null) return;
			widget.stop();
			widget = null;
		};
		api.on("agent_end", () => {
			dropWidget();
		});
		api.on("session_shutdown", () => {
			dropWidget();
		});
	};
}
