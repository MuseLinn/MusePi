// ============================================================
// MusePi native todo integration (coding-agent, no extension host).
//
// todo_list is a built-in tool; the inline panel renders through the
// interactive-mode widget channel directly (not ctx.ui.setWidget);
// ctrl+t toggles the panel when todos exist and falls back to pi's
// thinking-block toggle when the list is empty. State persists via
// SessionManager.appendCustomEntry (survives hot-reload; a fresh
// session always starts empty).
// ============================================================

import {
	normalizeTodos,
	selectVisibleTodos,
	summarizeTodos,
	TODO_ENTRY_TYPE,
	type TodoItem,
} from "@musepi/core/todo/types.js";
import type { ToolDefinition } from "../core/extensions/index.ts";
import type { SessionManager } from "../core/session-manager.ts";
import type { Theme } from "../modes/interactive/theme/theme.ts";

interface TodoRuntime {
	todos: TodoItem[];
	expanded: boolean;
	maxVisible: number;
	sessionManager: SessionManager | null;
	setWidget: ((key: string, content: string[] | undefined) => void) | null;
	theme: Theme | null;
}

const rt: TodoRuntime = {
	todos: [],
	expanded: false,
	maxVisible: 5,
	sessionManager: null,
	setWidget: null,
	theme: null,
};

// ── Rendering ─────────────────────────────────────────────────

function statusLine(t: TodoItem, theme: Theme): string {
	if (t.status === "in_progress") return theme.fg("accent", theme.bold("● ")) + theme.fg("text", t.title);
	if (t.status === "done") return theme.fg("success", "✓ ") + theme.fg("dim", t.title);
	return theme.fg("dim", "○ ") + theme.fg("dim", t.title);
}

function buildWidgetLines(theme: Theme): string[] | undefined {
	if (rt.todos.length === 0) return undefined;
	const counts = summarizeTodos(rt.todos);
	const head = theme.fg(
		"dim",
		`─ todo (${counts.in_progress} active · ${counts.pending} pending · ${counts.done} done) ─`,
	);
	if (rt.expanded) {
		return [head, ...rt.todos.map((t) => statusLine(t, theme)), theme.fg("dim", "ctrl+t collapse")];
	}
	const { rows, hidden, hiddenCounts } = selectVisibleTodos(rt.todos, rt.maxVisible);
	const lines = [head, ...rows.map((t) => statusLine(t, theme))];
	if (hidden > 0) {
		lines.push(
			theme.fg(
				"dim",
				`… +${hidden} more (${hiddenCounts.done} done · ${hiddenCounts.in_progress} in progress) · ctrl+t expand`,
			),
		);
	}
	return lines;
}

function refreshPanel(): void {
	if (!rt.setWidget || !rt.theme) return;
	try {
		rt.setWidget("musepi-todo", buildWidgetLines(rt.theme));
	} catch {
		/* stale host — fail safe */
	}
}

// ── Persistence ───────────────────────────────────────────────

function persist(): void {
	if (!rt.sessionManager) return;
	try {
		rt.sessionManager.appendCustomEntry(TODO_ENTRY_TYPE, { todos: rt.todos });
	} catch {
		/* session replaced mid-flight — fail safe */
	}
}

/** Restore the latest persisted list; no entry means a fresh session. */
function restore(): void {
	rt.todos = [];
	if (!rt.sessionManager) return;
	try {
		const entries = rt.sessionManager.getEntries() as Array<{ type?: string; customType?: string; data?: any }>;
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e?.type === "custom" && e.customType === TODO_ENTRY_TYPE && Array.isArray(e.data?.todos)) {
				rt.todos = e.data.todos.filter((t: any) => t && typeof t.title === "string");
				return;
			}
		}
	} catch {
		/* not critical */
	}
}

// ── Public API ────────────────────────────────────────────────

export interface MusepiTodoHost {
	sessionManager: SessionManager;
	theme: Theme;
	setWidget(key: string, content: string[] | undefined): void;
	/** From settings: max rows in the folded panel (default 5). */
	maxVisible?: number;
}

/** Bind the todo runtime to a session: restore state + show the panel. */
export function initMusepiTodo(host: MusepiTodoHost): void {
	rt.sessionManager = host.sessionManager;
	rt.theme = host.theme;
	rt.maxVisible = host.maxVisible ?? 5;
	rt.setWidget = (key, content) => host.setWidget(key, content);
	restore();
	refreshPanel();
}

/** ctrl+t handler: toggles the panel; returns false when the list is
 *  empty so the caller can fall back to the thinking-block toggle. */
export function toggleMusepiTodoPanel(): boolean {
	if (rt.todos.length === 0) return false;
	rt.expanded = !rt.expanded;
	refreshPanel();
	return true;
}

/** The todo_list tool definition (native registration). */
export const musepiTodoToolDef: ToolDefinition<any, any> = {
	name: "todo_list",
	label: "Todo List",
	description: "Track a task plan as an inline todo panel (update / read / clear)",
	promptSnippet: "todo_list: track your own task plan (update / read / clear)",
	promptGuidelines: [
		"Use todo_list action=update with the FULL rewritten list to plan multi-step work and keep it current",
		"Mark exactly one item in_progress at a time; mark items done as soon as they finish",
		"The list is shown to the user inline — write titles for the user, not for yourself",
	],
	parameters: {
		type: "object",
		properties: {
			action: { type: "string", description: "update | read | clear" },
			todos: {
				type: "array",
				description: "For update: the full new list, [{id?, title, status: pending|in_progress|done}]",
				items: { type: "object" },
			},
		},
		required: ["action"],
	},
	async execute(_toolCallId: string, params: any): Promise<any> {
		const action = String(params?.action ?? "");
		if (action === "update") {
			try {
				rt.todos = normalizeTodos(params.todos);
			} catch (err: any) {
				return { content: [{ type: "text", text: err?.message ?? String(err) }] };
			}
			persist();
			refreshPanel();
			const c = summarizeTodos(rt.todos);
			return {
				content: [
					{
						type: "text",
						text: `todo updated: ${c.in_progress} in progress · ${c.pending} pending · ${c.done} done (${rt.todos.length} total)`,
					},
				],
			};
		}
		if (action === "clear") {
			rt.todos = [];
			persist();
			refreshPanel();
			return { content: [{ type: "text", text: "todo list cleared" }] };
		}
		if (action === "read") {
			if (rt.todos.length === 0) return { content: [{ type: "text", text: "(todo list is empty)" }] };
			const lines = rt.todos.map((t) => `- [${t.status}] ${t.title} (${t.id})`);
			return { content: [{ type: "text", text: lines.join("\n") }] };
		}
		return {
			content: [{ type: "text", text: `todo_list: unknown action "${action}" (expected update|read|clear)` }],
		};
	},
};
