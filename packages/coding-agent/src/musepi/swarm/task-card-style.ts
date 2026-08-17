// ============================================================
// MusePi Task-Card Style Extension (swarm style)
//
// Registers the `display.taskCardStyle` setting via registerSetting so it
// appears in the settings panel ONLY while this extension is loaded
// (extension center: style:task-card-swarm). The setting gates:
//   - GUI: the additive swarm member-grid card beside the native task card
//     (desktop-web ToolView SwarmCard).
//   - TUI: a braille member grid painted above the editor while a `task`
//     call runs (the native framed task card stays in the transcript).
//
// The legacy `swarm_run` extension (braille widget + fake executor) was
// never wired into the extension system and is removed — task tool is the
// real executor.
// ============================================================

import { settings } from "../../config/settings";
import type { ExtensionAPI, ExtensionFactory, ExtensionUIContext } from "../../extensibility/extensions/types";

// ============================================================
// Constants
// ============================================================

const DEFAULT_REFRESH_INTERVAL_MS = 250;
const TASK_WIDGET_KEY = "task-swarm";
/** setInterval id — the legacy swarm-core package is removed; keep the
 *  alias local so this extension stays dependency-free. */
type SwarmTimerId = number;

// ============================================================
// Task-card swarm widget (TUI above-editor braille grid)
// ============================================================

interface TaskMemberView {
	id: string;
	label: string;
	status: "pending" | "running" | "done" | "failed";
	toolCalls: number;
	tokens: number;
}

function fmtTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
	return String(value);
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
		members.push({
			id,
			label:
				(typeof rec.description === "string" && rec.description) || (typeof rec.task === "string" ? rec.task : id),
			status:
				status === "completed"
					? "done"
					: status === "failed" || status === "aborted"
						? "failed"
						: status === "pending"
							? "pending"
							: "running",
			toolCalls: typeof rec.toolCount === "number" ? rec.toolCount : 0,
			tokens: typeof rec.tokens === "number" ? rec.tokens : 0,
		});
	}
	if (members.length === 0) return null;
	return members;
}

class TaskCardWidgetController {
	private readonly ui: ExtensionUIContext;
	private members: TaskMemberView[] = [];
	private settled = false;
	private frameTimer: SwarmTimerId | null = null;
	private lastWidth = 0;

	constructor(ui: ExtensionUIContext) {
		this.ui = ui;
	}

	start(members: TaskMemberView[]): void {
		this.members = members;
		this.settled = false;
		this.lastWidth = process.stdout.columns ?? 120;
		this.paint();
		this.frameTimer = setInterval(() => {
			const width = process.stdout.columns ?? 120;
			if (width !== this.lastWidth) {
				this.lastWidth = width;
				this.paint();
			}
		}, DEFAULT_REFRESH_INTERVAL_MS) as unknown as SwarmTimerId;
	}

	update(members: TaskMemberView[]): void {
		this.members = members;
		if (this.frameTimer === null) this.start(members);
		else this.paint();
	}

	settle(members: TaskMemberView[]): void {
		this.members = members;
		this.settled = true;
		this.paint();
		this.stop();
	}

	stop(): void {
		if (this.frameTimer) {
			clearInterval(this.frameTimer as unknown as number);
			this.frameTimer = null;
		}
		this.ui.setWidget(TASK_WIDGET_KEY, undefined);
	}

	private paint(): void {
		const width = this.lastWidth;
		const lines: string[] = [];
		const done = this.members.filter(m => m.status === "done" || m.status === "failed").length;
		lines.push(`Task · ${done}/${this.members.length} agent(s)${this.settled ? " · done" : ""}`);
		lines.push("");
		const cols = Math.max(1, Math.min(4, this.members.length));
		for (let i = 0; i < this.members.length; i += cols) {
			const row = this.members.slice(i, i + cols);
			lines.push(
				row
					.map(m => {
						const glyph =
							m.status === "done" ? "✓" : m.status === "failed" ? "✗" : m.status === "running" ? "⠋" : "·";
						const label = m.label.slice(0, Math.max(6, Math.floor(width / cols - 12))).padEnd(10, " ");
						return `${glyph} ${label}`;
					})
					.join("  "),
			);
		}
		if (this.members.some(m => m.toolCalls > 0 || m.tokens > 0)) {
			lines.push("");
			lines.push(
				this.members.map(m => `${m.toolCalls}t${m.tokens > 0 ? `/${fmtTokens(m.tokens)}` : ""}`).join(" · "),
			);
		}
		this.ui.setWidget(TASK_WIDGET_KEY, lines);
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
					"Render style for the task/swarm tool card. Swarm shows the Kimi-parity member grid with per-agent avatars, progress bars and accordion outputs; classic uses the plain tool-call card",
				options: [
					{
						value: "swarm",
						label: "Swarm",
						description: "Kimi-parity member grid: avatars, progress bars, per-member accordions",
					},
					{
						value: "classic",
						label: "Classic",
						description: "Plain tool-call card with summary chips",
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
	};
}
