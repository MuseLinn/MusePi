// ============================================================
// MusePi native todo integration (coding-agent, no extension host).
//
// todo_list is a built-in tool (phased model, ops: init/start/done/
// drop/rm/append/add_notes/update_details/view). The inline panel
// renders through the interactive-mode widget channel; ctrl+t toggles
// the panel when todos exist. Reminder system nudges after N turns
// with no todo update. State persists via
// SessionManager.appendCustomEntry.
// ============================================================

import {
	applyOp,
	formatPhaseLine,
	formatPhaseSummaryLine,
	formatSummary,
	formatTodoLine,
	markdownToPhases,
	selectVisibleTodos,
	summarizeTodos,
	TODO_ENTRY_TYPE,
	type TodoOpParams,
	type TodoPhase,
	type TodoTheme,
} from "@musepi/core/todo/types.js";
import type { ToolDefinition } from "../core/extensions/index.ts";
import type { SessionManager } from "../core/session-manager.ts";
import type { Theme } from "../modes/interactive/theme/theme.ts";

// ── Runtime state ──────────────────────────────────────────────

interface TodoRuntime {
	phases: TodoPhase[];
	expanded: boolean;
	maxVisible: number;
	sessionManager: SessionManager | null;
	theme: Theme | null;
	setWidget: ((key: string, content: string[] | undefined) => void) | null;

	// Reminder tracking
	turnsSinceTodoTouch: number;
	reminderPending: boolean;
}

const rt: TodoRuntime = {
	phases: [],
	expanded: false,
	maxVisible: 5,
	sessionManager: null,
	theme: null,
	setWidget: null,
	turnsSinceTodoTouch: 0,
	reminderPending: false,
};

// ── Rendering ─────────────────────────────────────────────────

/** Wrap a Theme into a TodoTheme for the rendering helpers. */
function wrapTodoTheme(th: Theme): Exclude<TodoTheme, null> {
	return {
		fg: (color: string, text: string) => (th as any).fg(color, text),
		bold: (text: string) => th.bold(text),
		strikethrough: (text: string) => th.strikethrough(text),
	};
}

function buildWidgetLines(theme: Theme): string[] | undefined {
	if (rt.phases.length === 0) return undefined;
	const counts = summarizeTodos(rt.phases.flatMap((p) => p.tasks));
	const head = theme.fg(
		"dim",
		`─ todo (${counts.in_progress} active · ${counts.pending} pending · ${counts.completed} done) ─`,
	);
	const th = wrapTodoTheme(theme);
	if (rt.expanded) {
		const lines: string[] = [head];
		for (let i = 0; i < rt.phases.length; i++) {
			const p = rt.phases[i];
			lines.push(formatPhaseLine(p, i + 1, rt.phases.length > 1, th));
			for (const t of p.tasks) {
				const notesCount = t.notes?.length ?? 0;
				lines.push(`  ${formatTodoLine(t, th, notesCount)}`);
			}
		}
		lines.push(theme.fg("dim", "ctrl+t collapse"));
		return lines;
	}

	// Collapsed: flat selectVisibleTodos with summary for completed phases
	const flatTodos = rt.phases.flatMap((p) => p.tasks);
	const { rows, hidden, hiddenCounts } = selectVisibleTodos(flatTodos, rt.maxVisible);
	const lines = [head];
	for (let i = 0; i < rt.phases.length; i++) {
		const p = rt.phases[i];
		const hasOpen = p.tasks.some((t) => t.status === "pending" || t.status === "in_progress");
		if (!hasOpen && flatTodos.some((t) => t.status === "pending" || t.status === "in_progress")) {
			// Collapsed phase: summary line
			lines.push(`  ${formatPhaseSummaryLine(p, i + 1, rt.phases.length > 1, th)}`);
		}
	}
	for (const t of rows) {
		const notesCount = t.notes?.length ?? 0;
		lines.push(`  ${formatTodoLine(t, th, notesCount)}`);
	}
	if (hidden > 0) {
		lines.push(
			theme.fg(
				"dim",
				`  +${hidden} more (${hiddenCounts.in_progress} active · ${hiddenCounts.pending} pending · ${hiddenCounts.completed} done)`,
			),
		);
	}
	lines.push(theme.fg("dim", ctrlHint()));
	return lines;
}

function ctrlHint(): string {
	return rt.expanded ? "ctrl+t collapse" : "alt+t expand · ctrl+t toggle";
}

function refreshPanel(): void {
	if (!rt.theme || !rt.setWidget) return;
	try {
		rt.setWidget("musepi-todo", buildWidgetLines(rt.theme));
	} catch {
		/* stale host — fail safe */
	}
}

// ── Persistence ────────────────────────────────────────────────

function persist(): void {
	if (!rt.sessionManager) return;
	try {
		rt.sessionManager.appendCustomEntry(TODO_ENTRY_TYPE, { phases: rt.phases });
	} catch {
		/* session replaced mid-flight — fail safe */
	}
}

/** Restore the latest persisted list; handles both new phased format
 *  and old flat format ({todos: [{id, title, status}]}). */
function restore(): void {
	rt.phases = [];
	if (!rt.sessionManager) return;
	try {
		const entries = rt.sessionManager.getEntries() as Array<{
			type?: string;
			customType?: string;
			data?: any;
		}>;
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e?.type === "custom" && e.customType === TODO_ENTRY_TYPE && e.data) {
				// New phased format
				if (Array.isArray(e.data.phases)) {
					rt.phases = e.data.phases.map((p: any) => ({
						name: String(p.name ?? "Tasks"),
						tasks: Array.isArray(p.tasks)
							? p.tasks.map((t: any) => ({
									content: String(t.content ?? t.title ?? ""),
									status: t.status ?? "pending",
									notes: Array.isArray(t.notes) ? [...t.notes] : undefined,
									details: typeof t.details === "string" ? t.details : undefined,
								}))
							: [],
					}));
					return;
				}
				// Old flat format: convert to single phase
				if (Array.isArray(e.data.todos)) {
					rt.phases = [
						{
							name: "Tasks",
							tasks: e.data.todos.map((t: any) => ({
								content: String(t.title ?? t.content ?? ""),
								status: t.status === "done" ? "completed" : (t.status ?? "pending"),
								notes: Array.isArray(t.notes) ? [...t.notes] : undefined,
								details: typeof t.details === "string" ? t.details : undefined,
							})),
						},
					];
					return;
				}
			}
		}
	} catch {
		/* deserialization failed — start fresh */
	}
}

// ── Public API ────────────────────────────────────────────────

export interface MusepiTodoHost {
	sessionManager: SessionManager;
	theme: Theme;
	setWidget: (key: string, content: string[] | undefined, opts?: { placement: string }) => void;
	maxVisible: number;
}

/** Bind the todo runtime to a session: restore state + show the panel. */
export function initMusepiTodo(host: MusepiTodoHost): void {
	rt.sessionManager = host.sessionManager;
	rt.theme = host.theme;
	rt.maxVisible = host.maxVisible;
	rt.setWidget = (key, content) => host.setWidget(key, content, { placement: "aboveEditor" });
	restore();
	refreshPanel();
}

/** ctrl+t handler: toggles the panel; returns false when the list is
 *  empty so the caller can fall back to the thinking-block toggle. */
export function toggleMusepiTodoPanel(): boolean {
	if (rt.phases.length === 0) return false;
	rt.expanded = !rt.expanded;
	refreshPanel();
	return true;
}

/** alt+t handler: toggle expand/collapse (separate from ctrl+t). */
export function toggleMusepiTodoExpand(): void {
	if (rt.phases.length === 0) return;
	rt.expanded = !rt.expanded;
	refreshPanel();
}

// ── Reminder system ──────────────────────────────────────────

const MAX_REMINDER_TURNS = 8;

export function notifyTodoMutation(): void {
	rt.turnsSinceTodoTouch = 0;
	rt.reminderPending = false;
}

export function checkTodoReminder(): string | null {
	if (rt.phases.length === 0) return null;

	// Count incomplete tasks
	let incomplete = 0;
	for (const p of rt.phases) {
		for (const t of p.tasks) {
			if (t.status !== "completed" && t.status !== "abandoned") incomplete++;
		}
	}
	if (incomplete === 0) return null;

	rt.turnsSinceTodoTouch++;
	if (rt.turnsSinceTodoTouch < MAX_REMINDER_TURNS) return null;
	if (rt.reminderPending) return null;
	rt.reminderPending = true;

	const counts = summarizeTodos(rt.phases.flatMap((p) => p.tasks));
	return `[todo] ${counts.in_progress} active, ${counts.pending} pending — use todo_list tool or /todo to update progress`;
}

export function incrementTodoTurnCounter(): void {
	rt.turnsSinceTodoTouch++;
}

// ── /todo command handler ─────────────────────────────────────

/** Parse /todo command text and mutate the todo list.
 *  Returns the formatted result to display to the user. */
export function handleTodoCommand(args: string): string {
	const trimmed = args.trim();
	if (!trimmed || trimmed === "view") {
		return formatSummary(rt.phases, [], true);
	}

	// Check for shorthand: /todo init I. Foundation|Foo|Bar
	if (trimmed.startsWith("init ")) {
		const body = trimmed.slice(5).trim();
		const list = parseInitArgs(body);
		const { phases, errors } = applyOp(rt.phases, { op: "init", list });
		if (errors.length === 0) {
			rt.phases = phases;
			persist();
			notifyTodoMutation();
			refreshPanel();
		}
		return formatSummary(rt.phases, errors);
	}

	// Shorthand: /todo done "task content" [/phase]
	// Shorthand: /todo start "task content"
	const opMatch = trimmed.match(/^(start|done|drop|rm)\s+(.+)$/);
	if (opMatch) {
		const op = opMatch[1] as TodoOpParams["op"];
		const rest = opMatch[2].trim();
		// Check for "/phase" suffix
		const phaseMatch = rest.match(/^(.+?)\s+\/(.+)$/);
		const task = phaseMatch ? phaseMatch[1].trim() : rest;
		const phase = phaseMatch ? phaseMatch[2].trim() : undefined;
		const { phases, errors } = applyOp(rt.phases, {
			op,
			task: task.replace(/^"(.*)"$/, "$1"),
			phase,
		});
		if (errors.length === 0) {
			rt.phases = phases;
			persist();
			notifyTodoMutation();
			refreshPanel();
		}
		return formatSummary(rt.phases, errors);
	}

	// Shorthand: /todo append "phase name" item1|item2
	const appendMatch = trimmed.match(/^append\s+(.+?)\s+(.+)$/);
	if (appendMatch) {
		const phaseName = appendMatch[1].replace(/^"(.*)"$/, "$1").trim();
		const items = appendMatch[2]
			.split("|")
			.map((s) => s.trim())
			.filter(Boolean);
		const { phases, errors } = applyOp(rt.phases, { op: "append", phase: phaseName, items });
		if (errors.length === 0) {
			rt.phases = phases;
			persist();
			notifyTodoMutation();
			refreshPanel();
		}
		return formatSummary(rt.phases, errors);
	}

	// Markdown round-trip: full /todo with markdown body
	const { phases, errors } = markdownToPhases(trimmed);
	if (errors.length === 0 && phases.length > 0) {
		rt.phases = phases;
		persist();
		notifyTodoMutation();
		refreshPanel();
		return formatSummary(rt.phases, []);
	}
	// If markdown parse failed, try as op=init with items
	return `Invalid /todo syntax. Usage:\n/todo view\n/todo init <Phase>|<item1>|<item2>\n/todo start|done|drop|rm "<task>" [/phase]\n/todo append "<phase>" item1|item2\nOr paste markdown todo list.`;
}

function parseInitArgs(body: string): Array<{ phase: string; items: string[] }> {
	// Split on | for flat list, or detect phase: items pattern
	const phases: Array<{ phase: string; items: string[] }> = [];

	// Check for roman numeral prefix: /todo init I. Foundation
	const romanSplit = body.match(/^\w+\.\s+(.+?)\s*[|]/);
	if (romanSplit) {
		// Multi-phase: split by double newline or roman numeral
		const parts = body.split(/\n+/).filter(Boolean);
		let currentPhase = "";
		let currentItems: string[] = [];
		for (const part of parts) {
			const headerMatch = part.match(/^(?:\w+\.\s*)?(.+?)\s*[|]/);
			if (headerMatch && headerMatch[0].length < part.length) {
				if (currentPhase && currentItems.length > 0) {
					phases.push({ phase: currentPhase, items: currentItems });
				}
				currentPhase = headerMatch[1].trim();
				currentItems = part
					.slice(headerMatch[0].length)
					.split("|")
					.map((s) => s.trim())
					.filter(Boolean);
			} else {
				currentItems.push(
					...part
						.split("|")
						.map((s) => s.trim())
						.filter(Boolean),
				);
			}
		}
		if (currentPhase && currentItems.length > 0) {
			phases.push({ phase: currentPhase, items: currentItems });
		}
	}

	if (phases.length > 0) return phases;

	// If body starts with a known phase name pattern, try single phase
	const pipeSplit = body
		.split("|")
		.map((s) => s.trim())
		.filter(Boolean);
	if (pipeSplit.length > 0) {
		return [{ phase: pipeSplit[0], items: pipeSplit.slice(1) }];
	}

	return [];
}

// markdownToPhases imported at top of file — this comment intentionally left blank

// ── Tool registration ─────────────────────────────────────────

/** The todo_list tool definition (native registration). */
export const musepiTodoToolDef: ToolDefinition<any, any> = {
	name: "todo_list",
	label: "Todo List",
	description:
		"Manage a phased task plan (init / start / done / drop / rm / append / add_notes / update_details / view)",
	promptGuidelines: [
		"Use op=init with list=[{phase, items}] to initialize a full phased plan covering the whole request",
		"Use op=start task=... to mark a task in_progress (only one in_progress at a time)",
		"Use op=done task=... to mark a task completed; omit task to mark all open tasks done",
		"Use op=append phase=... items=[...] to add tasks to an existing phase",
		"Keep tasks to concise 5-10 word labels",
		"Call todo_list after completing tasks to keep progress visible — reminders fire if you stop with open items",
	],
	parameters: {
		type: "object",
		properties: {
			op: {
				type: "string",
				enum: ["init", "start", "done", "drop", "rm", "append", "add_notes", "update_details", "view"],
				description: "Operation to apply",
			},
			list: {
				type: "array",
				description: "Phased task list (for init): [{phase, items}]",
				items: {
					type: "object",
					properties: {
						phase: { type: "string", description: "Phase name" },
						items: { type: "array", items: { type: "string" }, description: "Task contents" },
					},
					required: ["phase", "items"],
				},
			},
			task: {
				type: "string",
				description: "Task content to target (for start/done/drop/rm/add_notes/update_details)",
			},
			phase: {
				type: "string",
				description: "Phase name (for done/drop/rm/append)",
			},
			items: {
				type: "array",
				items: { type: "string" },
				description: "Tasks to append (for append)",
			},
			notes: {
				type: "array",
				items: { type: "string" },
				description: "Notes to attach (for add_notes op)",
			},
			details: {
				type: "string",
				description: "Details text for a task (for update_details op)",
			},
		},
		required: ["op"],
	},
	async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, _ctx: any) {
		const op = String(params?.op ?? "");
		const entry: TodoOpParams = {
			op: op as TodoOpParams["op"],
			list: params.list,
			notes: params.notes,
			task: params.task,
			phase: params.phase,
			items: params.items,
			details: params.details,
		};

		const { phases, errors } = applyOp(rt.phases, entry);
		if (errors.length > 0) {
			return { content: [{ type: "text" as const, text: `Errors: ${errors.join("; ")}` }], details: undefined };
		}
		rt.phases = phases;
		persist();
		notifyTodoMutation();
		refreshPanel();

		return {
			content: [
				{
					type: "text" as const,
					text: formatSummary(rt.phases, []),
				},
			],
			details: undefined,
		};
	},
};
