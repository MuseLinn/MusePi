/**
 * Todo policy shared by the tool and the surfaces that render its state.
 *
 * These questions — is a todo settled, which rows belong in a collapsed
 * viewport, does a live subagent's description name this todo — are answered by
 * the TUI, the daemon and the model-facing tool alike. They live here rather
 * than in `tools/todo.ts` because the renderer must not import the tool
 * implementation to ask them; the tool re-exports everything below so existing
 * callers keep one source of truth.
 */

import { sanitizeText } from "@musepi/pi-utils";
import { formatMoreItems, pluralize, replaceTabs } from "../render/render-utils";
import type { TodoPhase, TodoStatus } from "../tools/contract";

/** Minimum overlap (after normalization) required for a substring match.
 * Picked at six chars to admit single-word identifiers like "review" /
 * "Sonnet" without admitting tiny common substrings like "test" / "fix"
 * that would collide across unrelated todos. */
const TODO_DESCRIPTION_MIN_OVERLAP = 6;

function normalizeForTodoMatch(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

/**
 * Report whether `content` likely names the same work as any entry in
 * `descriptions`. Used by the sticky todo panel to light up a pending todo
 * when an in-flight subagent is doing the work for it, without requiring
 * the caller to flip the todo's status.
 *
 * Matching is normalize-then-equal first (lowercased; punctuation and
 * whitespace runs both collapsed to a single space; trimmed), with a
 * substring fallback in either direction so minor wording drift
 * ("Sonnet #2: bug scan" vs "Sonnet #2") still links up. The substring
 * fallback requires at least {@link TODO_DESCRIPTION_MIN_OVERLAP} chars on
 * the contained side.
 */
export function todoMatchesAnyDescription(content: string, descriptions: readonly string[]): boolean {
	const target = normalizeForTodoMatch(content);
	if (!target) return false;
	for (const desc of descriptions) {
		const candidate = normalizeForTodoMatch(desc);
		if (!candidate) continue;
		if (target === candidate) return true;
		if (target.length >= TODO_DESCRIPTION_MIN_OVERLAP && candidate.includes(target)) return true;
		if (candidate.length >= TODO_DESCRIPTION_MIN_OVERLAP && target.includes(candidate)) return true;
	}
	return false;
}

/** Whether a todo is settled: completed or deliberately abandoned. Shared so
 *  the collapsed viewport, the HUD progress counters, and the HUD's closed-todo
 *  auto-clear can never disagree about what "done" hides. */
export function isClosedTodo<T extends { status: TodoStatus }>(task: T): boolean {
	return task.status === "completed" || task.status === "abandoned";
}

function isActiveTodo<T extends { status: TodoStatus }>(task: T, isMatched: (task: T) => boolean): boolean {
	return task.status === "in_progress" || (task.status === "pending" && isMatched(task));
}

/** Result of {@link selectCollapsedTodos}: the rows to render plus an optional
 *  summary line (empty string ⇒ no summary row). */
export interface CollapsedTodoSelection<T> {
	items: T[];
	summary: string;
}

/**
 * Closed rows kept directly above the open window so finishing a task is
 * visible as it happens. Without this the collapsed viewport only ever renders
 * unchecked boxes while a phase has open work: every completion silently
 * removes a row, so a plan mid-flight looks untouched, and the card's
 * completion strike animation animated a row that was never rendered.
 */
const COLLAPSED_CLOSED_CONTEXT = 1;

/**
 * Rows to show for a display base already reduced to the relevant tasks.
 *
 * 1. Every active task (in-progress, or pending matched to a live subagent) is
 *    placed at the head in stable todo order — never dropped for lying outside
 *    an ordinary window.
 * 2. Remaining rows up to `cap` are filled with the pending tasks that follow
 *    the first active one, in todo order (falling back to leading pending tasks
 *    when no active task exists), so a freshly-promoted task leads the preview.
 * 3. When active tasks alone exceed `cap`, only the first `cap` active tasks are
 *    shown and the summary counts the hidden *active* todos, never replacing
 *    them with unrelated pending rows.
 */
function selectWithinCap<T extends { status: TodoStatus }>(
	base: T[],
	isMatched: (task: T) => boolean,
	cap: number,
): CollapsedTodoSelection<T> {
	if (base.length <= cap) return { items: base, summary: "" };

	const active = base.filter(task => isActiveTodo(task, isMatched));
	// Only when active work strictly exceeds the cap do we drop pending rows and
	// count hidden *actives*. At exactly `cap` actives, fall through so the normal
	// branch still surfaces any following pending work in the summary.
	if (active.length > cap) {
		const hiddenActive = active.length - cap;
		return {
			items: active.slice(0, cap),
			summary: `… ${hiddenActive} more active ${pluralize("todo", hiddenActive)}`,
		};
	}

	// Fill trailing rows with tasks following the first active one, so the
	// promoted/current task leads and its successors follow in todo order.
	const firstActiveIdx = active.length > 0 ? base.indexOf(active[0]) : 0;
	const fill: T[] = [];
	for (let i = firstActiveIdx; i < base.length && active.length + fill.length < cap; i++) {
		const task = base[i];
		if (isActiveTodo(task, isMatched)) continue;
		fill.push(task);
	}
	const items = [...active, ...fill];
	const hidden = base.length - items.length;
	return { items, summary: hidden > 0 ? formatMoreItems(hidden, "todo") : "" };
}

/**
 * Walking-viewport selection for a phase's collapsed todo preview.
 *
 * Applied to `tasks` in todo order: the open tasks run through
 * {@link selectWithinCap}, led by the last {@link COLLAPSED_CLOSED_CONTEXT}
 * closed tasks in todo order so a checked row remains visible even when callers
 * complete work out of sequence. The lead is additive — it never costs an open
 * row — and a phase with no open work left falls back to its closed tasks so the
 * sticky HUD's closed-todo persistence still has something to render.
 *
 * `summary` counts the open tasks that did not fit; the closed lead is context,
 * not part of the budget.
 */
export function selectCollapsedTodos<T extends { status: TodoStatus }>(
	tasks: T[],
	isMatched: (task: T) => boolean,
	cap: number,
): CollapsedTodoSelection<T> {
	const open = tasks.filter(task => !isClosedTodo(task));
	// Closed tasks are never active, so a settled phase selects over itself.
	if (open.length === 0) return selectWithinCap(tasks, isMatched, cap);
	// `done` accepts any named task, so closed tasks are not necessarily a prefix.
	const lead = tasks.filter(isClosedTodo).slice(-COLLAPSED_CLOSED_CONTEXT);
	const selected = selectWithinCap(open, isMatched, cap);
	return { items: [...lead, ...selected.items], summary: selected.summary };
}

const ROMAN_PAIRS: Array<[number, string]> = [
	[1000, "M"],
	[900, "CM"],
	[500, "D"],
	[400, "CD"],
	[100, "C"],
	[90, "XC"],
	[50, "L"],
	[40, "XL"],
	[10, "X"],
	[9, "IX"],
	[5, "V"],
	[4, "IV"],
	[1, "I"],
];

export function phaseRomanNumeral(oneBasedIndex: number): string {
	if (oneBasedIndex <= 0) return "";
	let out = "";
	let rem = oneBasedIndex;
	for (const [value, sym] of ROMAN_PAIRS) {
		while (rem >= value) {
			out += sym;
			rem -= value;
		}
	}
	return out;
}

/**
 * Every render boundary funnels display text through here.
 *
 * `sanitizeText` strips ANSI/C0 sequences but deliberately preserves tabs, and
 * a raw tab punches holes in bordered TUI output, so both are needed. The raw
 * value stays untouched everywhere else: task content and phase names are the
 * identity keys the local list is looked up by, and what gets persisted.
 */
function forDisplay(text: string): string {
	return replaceTabs(sanitizeText(text));
}

/**
 * Display-only phase header: `I. Foundation`. State and prompts never see this.
 *
 * Sanitized for the same reason task labels are: this is a render boundary and
 * the name may carry provider or session text holding control sequences. The
 * raw `phase.name` stays the lookup key everywhere else.
 */
export function formatPhaseDisplayName(name: string, oneBasedIndex: number): string {
	return `${phaseRomanNumeral(oneBasedIndex)}. ${forDisplay(name)}`;
}

let activeTodoDescriptionsProvider: () => readonly string[] = () => [];

/** The description source the sticky panel matches pending todos against. */
export function activeTodoDescriptions(): readonly string[] {
	return activeTodoDescriptionsProvider();
}

export function setActiveTodoDescriptionsProvider(provider: () => readonly string[]): void {
	activeTodoDescriptionsProvider = provider;
}

export type { TodoPhase, TodoStatus };
