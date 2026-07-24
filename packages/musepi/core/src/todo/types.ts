// ============================================================
// Todo — phased task list model + mutation helpers (pure, no host
// imports). Ported from pi-muselinn-harness/packages/core/todo/types.
// ============================================================

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned";
export type TodoOperation =
	| "init"
	| "start"
	| "done"
	| "rm"
	| "drop"
	| "append"
	| "add_notes"
	| "update_details"
	| "view";

export interface TodoItem {
	content: string;
	status: TodoStatus;
	notes?: string[];
	details?: string;
}

export interface TodoPhase {
	name: string;
	tasks: TodoItem[];
}

export interface InitListEntry {
	phase: string;
	items: string[];
}

export interface TodoCompletionTransition {
	phase: string;
	content: string;
	from: TodoStatus;
	to: TodoStatus;
}

export interface VisibleTodos {
	rows: TodoItem[];
	hidden: number;
	hiddenCounts: Record<TodoStatus, number>;
}

export type TodoOpParams = {
	op: TodoOperation;
	list?: InitListEntry[];
	task?: string;
	phase?: string;
	items?: string[];
	notes?: string[];
	details?: string;
};

export const MAX_VISIBLE_TODOS = 5;
export const TODO_ENTRY_TYPE = "muselinn_todo";
const DEFAULT_INIT_PHASE = "Tasks";
const MAX_ITEMS = 50;

const VALID_STATUS: readonly TodoStatus[] = [
	"pending",
	"in_progress",
	"completed",
	"abandoned",
];

// ── Helpers ────────────────────────────────────────────────────

export function findTaskByContent(
	phases: TodoPhase[],
	content: string,
): { task: TodoItem; phase: TodoPhase } | undefined {
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.content === content) return { task, phase };
		}
	}
	return undefined;
}

export function findPhaseByName(
	phases: TodoPhase[],
	name: string,
): TodoPhase | undefined {
	return phases.find((p) => p.name === name);
}

export function clonePhases(phases: TodoPhase[]): TodoPhase[] {
	return phases.map((p) => ({
		name: p.name,
		tasks: p.tasks.map((t) => ({ ...t, notes: t.notes ? [...t.notes] : undefined })),
	}));
}

function todoTransitionKey(phase: string, content: string): string {
	return `${phase}\0${content}`;
}

export function getCompletionTransitions(
	previous: TodoPhase[],
	updated: TodoPhase[],
): TodoCompletionTransition[] {
	const prev = new Map<string, TodoStatus>();
	for (const p of previous) {
		for (const t of p.tasks) {
			prev.set(todoTransitionKey(p.name, t.content), t.status);
		}
	}
	const result: TodoCompletionTransition[] = [];
	for (const p of updated) {
		for (const t of p.tasks) {
			const key = todoTransitionKey(p.name, t.content);
			const prevStatus = prev.get(key);
			if (prevStatus && prevStatus !== t.status) {
				result.push({ phase: p.name, content: t.content, from: prevStatus, to: t.status });
			}
		}
	}
	return result;
}

/** Ensure at most one task is in_progress (the earliest pending or in_progress). */
export function normalizeInProgressTask(phases: TodoPhase[]): void {
	let found = false;
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.status === "in_progress") {
				if (found) {
					task.status = "pending";
				} else {
					found = true;
				}
			}
		}
	}
	if (!found) {
		for (const phase of phases) {
			for (const task of phase.tasks) {
				if (task.status === "pending" || task.status === "abandoned") {
					task.status = "pending";
					break;
				}
			}
			if (found) break;
		}
	}
}

/** Return the first pending task across all phases. */
export function nextActionableTask(
	phases: readonly TodoPhase[],
): TodoItem | undefined {
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.status === "pending") return task;
		}
	}
	return undefined;
}

// ── Operation helpers ──────────────────────────────────────────

function initPhases(
	entry: TodoOpParams,
	errors: string[],
): TodoPhase[] {
	const list = entry.list;
	if (!list || !Array.isArray(list) || list.length === 0) {
		// Flat items fallback: { items: ["foo", "bar"] } → single "Tasks" phase
		const items = entry.items;
		if (Array.isArray(items) && items.length > 0) {
			if (items.length > MAX_ITEMS) {
				errors.push(`too many items (max ${MAX_ITEMS})`);
				return [];
			}
			return [
				{
					name: DEFAULT_INIT_PHASE,
					tasks: items.map((t: string) => ({ content: String(t).slice(0, 200), status: "pending" as const })),
				},
			];
		}
		errors.push('todo_list: "list" array required for op=init');
		return [];
	}

	if (list.length > 20) {
		errors.push("too many phases (max 20)");
		return [];
	}
	const phases: TodoPhase[] = [];
	const seen = new Set<string>();
	for (const entry of list) {
		if (!entry.phase || !Array.isArray(entry.items)) {
			errors.push('each list entry needs "phase" (string) and "items" (array)');
			continue;
		}
		if (seen.has(entry.phase)) {
			errors.push(`duplicate phase "${entry.phase}"`);
			continue;
		}
		seen.add(entry.phase);
		if (entry.items.length > MAX_ITEMS) {
			errors.push(`too many items in phase "${entry.phase}" (max ${MAX_ITEMS})`);
			continue;
		}
		phases.push({
			name: entry.phase,
			tasks: entry.items.map((t: string) => ({
				content: String(t).slice(0, 200),
				status: "pending" as const,
			})),
		});
	}
	return phases;
}

function appendItems(
	phases: TodoPhase[],
	entry: TodoOpParams,
	errors: string[],
): TodoPhase[] {
	const phaseName = entry.phase || DEFAULT_INIT_PHASE;
	const items = entry.items;
	if (!Array.isArray(items) || items.length === 0) {
		errors.push('append needs "items" array');
		return phases;
	}
	const result = clonePhases(phases);
	let phase = result.find((p) => p.name === phaseName);
	if (!phase) {
		phase = { name: phaseName, tasks: [] };
		result.push(phase);
	}
	if (phase.tasks.length + items.length > MAX_ITEMS) {
		errors.push(`too many items in phase "${phaseName}" (max ${MAX_ITEMS})`);
		return phases;
	}
	for (const item of items) {
		phase.tasks.push({ content: String(item).slice(0, 200), status: "pending" });
	}
	return result;
}

function resolveTaskOrError(
	phases: TodoPhase[],
	content: string | undefined,
	errors: string[],
): { task: TodoItem; phase: TodoPhase } | undefined {
	if (!content) {
		errors.push('"task" (content) is required');
		return undefined;
	}
	const found = findTaskByContent(phases, content);
	if (!found) {
		errors.push(`task not found: "${content}"`);
		return undefined;
	}
	return found;
}

function resolvePhaseOrError(
	phases: TodoPhase[],
	name: string | undefined,
	errors: string[],
): TodoPhase | undefined {
	if (!name) {
		errors.push('"phase" name is required');
		return undefined;
	}
	const found = findPhaseByName(phases, name);
	if (!found) {
		errors.push(`phase not found: "${name}"`);
		return undefined;
	}
	return found;
}

function removeTasks(
	phases: TodoPhase[],
	entry: TodoOpParams,
	errors: string[],
): TodoPhase[] {
	if (entry.task) {
		const found = resolveTaskOrError(phases, entry.task, errors);
		if (!found) return phases;
		const result = clonePhases(phases);
		const phase = result.find((p) => p.name === found.phase.name)!;
		phase.tasks = phase.tasks.filter((t) => t.content !== entry.task);
		if (phase.tasks.length === 0) {
			return result.filter((p) => p.name !== found.phase.name);
		}
		return result;
	}
	if (entry.phase) {
		const found = resolvePhaseOrError(phases, entry.phase, errors);
		if (!found) return phases;
		return clonePhases(phases).filter((p) => p.name !== found.name);
	}
	errors.push('"task" or "phase" required for rm');
	return phases;
}

function markTasks(
	phases: TodoPhase[],
	entry: TodoOpParams,
	targetStatus: TodoStatus,
	errors: string[],
): TodoPhase[] {
	if (entry.task) {
		const found = resolveTaskOrError(phases, entry.task, errors);
		if (!found) return phases;
		const result = clonePhases(phases);
		const phase = result.find((p) => p.name === found.phase.name)!;
		const task = phase.tasks.find((t) => t.content === entry.task)!;
		task.status = targetStatus;
		return result;
	}
	if (entry.phase) {
		const found = resolvePhaseOrError(phases, entry.phase, errors);
		if (!found) return phases;
		const result = clonePhases(phases);
		const phase = result.find((p) => p.name === found.name)!;
		for (const task of phase.tasks) {
			task.status = targetStatus;
		}
		return result;
	}
	// No task or phase → mark all
	return clonePhases(phases).map((p) => ({
		...p,
		tasks: p.tasks.map((t) => ({ ...t, status: targetStatus })),
	}));
}

function applyEntry(
	phases: TodoPhase[],
	entry: TodoOpParams,
	errors: string[],
): TodoPhase[] {
	switch (entry.op) {
		case "init":
			return initPhases(entry, errors);
		case "start": {
			const result = markTasks(phases, entry, "in_progress", errors);
			normalizeInProgressTask(result);
			return result;
		}
		case "done":
			return markTasks(phases, entry, "completed", errors);
		case "drop":
			return markTasks(phases, entry, "abandoned", errors);
		case "rm":
			return removeTasks(phases, entry, errors);
		case "append":
			return appendItems(phases, entry, errors);
		case "add_notes": {
			if (!entry.task) {
				errors.push('"task" required for add_notes');
				return phases;
			}
			const found = resolveTaskOrError(phases, entry.task, errors);
			if (!found) return phases;
			const result = clonePhases(phases);
			const phase = result.find((p) => p.name === found.phase.name)!;
			const task = phase.tasks.find((t) => t.content === entry.task)!;
			const notes = entry.notes || [];
			task.notes = [...(task.notes || []), ...notes];
			return result;
		}
		case "update_details": {
			if (!entry.task) {
				errors.push('"task" required for update_details');
				return phases;
			}
			if (!entry.details && entry.details !== "") {
				errors.push('"details" required for update_details');
				return phases;
			}
			const found = resolveTaskOrError(phases, entry.task, errors);
			if (!found) return phases;
			const result = clonePhases(phases);
			const phase = result.find((p) => p.name === found.phase.name)!;
			const task = phase.tasks.find((t) => t.content === entry.task)!;
			task.details = entry.details;
			return result;
		}
		case "view":
			return clonePhases(phases);
		default:
			errors.push(`unknown op: ${entry.op}`);
			return phases;
	}
}

export function applyOpsToPhases(
	currentPhases: TodoPhase[],
	ops: TodoOpParams[],
): { phases: TodoPhase[]; errors: string[] } {
	let phases = clonePhases(currentPhases);
	const allErrors: string[] = [];
	for (const op of ops) {
		phases = applyEntry(phases, op, allErrors);
	}
	return { phases, errors: allErrors };
}

/**
 * Normalize a single op (the most common path) into applyOpsToPhases.
 */
export function applyOp(
	currentPhases: TodoPhase[],
	op: TodoOpParams,
): { phases: TodoPhase[]; errors: string[] } {
	return applyOpsToPhases(currentPhases, [op]);
}

// ── Counts ─────────────────────────────────────────────────────

export interface PhaseCounts {
	total: number;
	activeTasks: number;
	completedTasks: number;
}

export function summarizePhases(
	phases: readonly TodoPhase[],
): PhaseCounts {
	let total = 0;
	let activeTasks = 0;
	let completedTasks = 0;
	for (const phase of phases) {
		total += phase.tasks.length;
		for (const task of phase.tasks) {
			if (task.status === "in_progress") activeTasks++;
			if (task.status === "completed") completedTasks++;
		}
	}
	return { total, activeTasks, completedTasks };
}

export function summarizeTodos(
	todos: readonly TodoItem[],
): Record<TodoStatus, number> {
	const counts: Record<string, number> = {
		pending: 0,
		in_progress: 0,
		completed: 0,
		abandoned: 0,
	};
	for (const t of todos) {
		counts[t.status] = (counts[t.status] || 0) + 1;
	}
	return counts as Record<TodoStatus, number>;
}
// ── Text output ────────────────────────────────────────────────

/** Plain-text status symbol for each status. */
export const STATUS_SYMBOL: Record<TodoStatus, string> = {
	pending: "○",
	in_progress: "●",
	completed: "✓",
	abandoned: "✗",
};

/**
 * Minimal theme interface for Pi-compatible rendering.
 * When null/undefined, falls back to plain text.
 */
export type TodoTheme = {
	fg: (color: string, text: string) => string;
	bold?: (text: string) => string;
	strikethrough?: (text: string) => string;
} | null;

/** Resolve a TodoTheme to always-callable functions (plain-text fallback). */
function resolveTh(th: TodoTheme): {
	fg: (c: string, t: string) => string;
	bold: (t: string) => string;
	strikethrough: (t: string) => string;
} {
	if (!th) return { fg: (_, t) => t, bold: (t) => t, strikethrough: (t) => t };
	return {
		fg: (c, t) => th.fg(c, t),
		bold: (t) => th.bold?.(t) ?? t,
		strikethrough: (t) => th.strikethrough?.(t) ?? t,
	};
}

/** Styled status symbol — colored with theme or plain text fallback. */
export function todoSymbol(status: TodoStatus, th: TodoTheme): string {
	if (!th) return STATUS_SYMBOL[status];
	switch (status) {
		case "in_progress":
			return th.fg("accent", "●");
		case "completed":
			return th.fg("success", "✓");
		case "abandoned":
			return th.fg("error", "✗");
		default:
			return th.fg("dim", "○");
	}
}

/** Render one task line with consistent symbol + content styling. */
export function formatTodoLine(
	task: TodoItem,
	th: TodoTheme,
	notesCount = 0,
	matched = false,
): string {
	const r = resolveTh(th);
	const sym = todoSymbol(task.status, th);
	const noteTag = notesCount > 0 ? r.fg("dim", ` +${notesCount}`) : "";

	switch (task.status) {
		case "completed":
		case "abandoned":
			return `${sym} ${r.strikethrough(r.fg(task.status === "completed" ? "success" : "error", task.content))}${noteTag}`;
		case "in_progress":
			return `${sym} ${r.fg("accent", task.content)}${noteTag}`;
		default:
			return `${sym} ${r.fg(matched ? "accent" : "dim", task.content)}${noteTag}`;
	}
}

/** Render one phase header line. */
export function formatPhaseLine(
	phase: TodoPhase,
	oneBasedIdx: number,
	multiPhase: boolean,
	th: TodoTheme,
): string {
	const r = resolveTh(th);
	const label = multiPhase ? formatPhaseDisplayName(phase.name, oneBasedIdx) : phase.name;
	const done = phase.tasks.filter((t) => t.status === "completed" || t.status === "abandoned").length;
	const hasActive = phase.tasks.some((t) => t.status === "in_progress");
	const count = phase.tasks.length > 0 ? `  ${done}/${phase.tasks.length}` : "";
	const line = `${label}${count}`;
	return hasActive ? r.fg("accent", r.bold(line)) : line;
}

/** Render a one-line collapsed summary for an untouched phase. */
export function formatPhaseSummaryLine(
	phase: TodoPhase,
	oneBasedIdx: number,
	multiPhase: boolean,
	th: TodoTheme,
): string {
	const r = resolveTh(th);
	const label = multiPhase ? formatPhaseDisplayName(phase.name, oneBasedIdx) : phase.name;
	const done = phase.tasks.filter((t) => t.status === "completed" || t.status === "abandoned").length;
	return r.fg("dim", `${label}  ${done}/${phase.tasks.length}`);
}

/**
 * AI-readable summary with phase tree. Uses collapsible phases
 * and compact summary line. Pass `th = null` for plain text output
 * (AI-facing), or a `TodoTheme` wrapper for styled widget rendering.
 */
export function formatSummary(
	phases: TodoPhase[],
	errors: string[],
	readOnly = false,
	th: TodoTheme = null,
): string {
	const tasks = phases.flatMap((p) => p.tasks);
	if (tasks.length === 0) {
		if (errors.length > 0) return `**Errors:** ${errors.join("; ")}`;
		return readOnly ? "Todo list is empty." : "Todo list cleared.";
	}

	const r = resolveTh(th);
	const remaining = tasks.filter((t) => t.status === "pending" || t.status === "in_progress");
	const closedAll = tasks.filter((t) => t.status === "completed" || t.status === "abandoned").length;
	const multi = phases.length > 1;

	const lines: string[] = [];
	if (errors.length > 0) lines.push(`**Errors:** ${errors.join("; ")}`);

	// AI-readable summary line (compact)
	if (remaining.length > 0) {
		const remainingByPhase = phases
			.map((p) => ({
				name: p.name,
				tasks: p.tasks.filter((t) => t.status === "pending" || t.status === "in_progress"),
			}))
			.filter((p) => p.tasks.length > 0);

		let currentIdx = phases.findIndex((p) =>
			p.tasks.some((t) => t.status === "pending" || t.status === "in_progress"),
		);
		if (currentIdx === -1) currentIdx = phases.length - 1;
		const current = phases[currentIdx];
		const done = current.tasks.filter((t) => t.status === "completed" || t.status === "abandoned").length;

		lines.push(`> **Todo ·** ${remaining.length} remaining · ${closedAll}/${tasks.length} done · active phase ${currentIdx + 1}/${phases.length} "${current.name}" (${done}/${current.tasks.length})`);
	}

	// Phase tree
	for (let i = 0; i < phases.length; i++) {
		const p = phases[i];
		const phaseTasks = p.tasks;
		const doneInPhase = phaseTasks.filter((t) => t.status === "completed" || t.status === "abandoned").length;
		const total = phaseTasks.length;
		const hasOpen = phaseTasks.some((t) => t.status === "pending" || t.status === "in_progress");

		if (!hasOpen && remaining.length > 0) {
			// Collapsed phase summary (when there are open tasks elsewhere)
			lines.push(`  **${formatPhaseDisplayName(p.name, i + 1)}** ✓ ${doneInPhase}/${total}`);
			continue;
		}

		const label = multi ? formatPhaseDisplayName(p.name, i + 1) : p.name;
		lines.push(`  **${label}**${remaining.length === 0 ? ` ✓ ${doneInPhase}/${total}` : ""}`);
		for (const task of phaseTasks) {
			const notesCount = task.notes?.length ?? 0;
			lines.push(`    ${formatTodoLine(task, th, notesCount)}`);
		}
	}
	return lines.join("\n");
}


// ── Markdown round-trip helpers ─────────────────────────────────

const STATUS_TO_MARKER: Record<TodoStatus, string> = {
	pending: "[ ]",
	in_progress: "[~]",
	completed: "[x]",
	abandoned: "[-]",
};

const MARKER_TO_STATUS: Record<string, TodoStatus> = {
	"[ ]": "pending",
	"[~]": "in_progress",
	"[x]": "completed",
	"[-]": "abandoned",
};
/**
 * Markdown round-trip format: markdown with [# headers, - [ ] tasks].
 * Kept separate from formatSummary for /todo command round-trip.
 */
export function formatSummaryMarkdown(
	phases: TodoPhase[],
	errors: string[],
	readOnly = false,
): string {
	const lines: string[] = [];
	for (let i = 0; i < phases.length; i++) {
		if (i > 0) lines.push("");
		const display = formatPhaseDisplayName(phases[i].name, i + 1);
		lines.push(`# ${display}`);
		for (const task of phases[i].tasks) {
			const marker = STATUS_TO_MARKER[task.status];
			lines.push(`- ${marker} ${task.content}`);
			if (task.notes && task.notes.length > 0) {
				for (const note of task.notes) {
					lines.push(`  > ${note}`);
				}
			}
			if (task.details) {
				lines.push(`  \`${task.details}\``);
			}
		}
	}
	if (errors.length > 0) {
		lines.push("");
		lines.push(`> Errors: ${errors.join("; ")}`);
	}
	if (readOnly) {
		lines.push("");
		lines.push("> (read-only view)");
	}
	return lines.join("\n");
}

// ── Markdown round-trip (for /todo command) ────────────────────

export function phasesToMarkdown(phases: TodoPhase[]): string {
	return formatSummaryMarkdown(phases, [], false);
}

export function markdownToPhases(
	md: string,
): { phases: TodoPhase[]; errors: string[] } {
	const errors: string[] = [];
	const phases: TodoPhase[] = [];
	let currentPhase: TodoPhase | undefined;

	for (const line of md.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		// Phase header: # I. Name or ## Name
		const headerMatch = trimmed.match(/^#{1,2}\s*(?:\w+\.\s*)?(.+)$/);
		if (headerMatch) {
			currentPhase = { name: headerMatch[1].trim(), tasks: [] };
			phases.push(currentPhase);
			continue;
		}

		// Task line: - [ ] content
		const taskMatch = trimmed.match(/^-\s*(\[[ ~x-]\])\s*(.+)$/);
		if (taskMatch && currentPhase) {
			const marker = taskMatch[1];
			const content = taskMatch[2].trim();
			const status = MARKER_TO_STATUS[marker] || "pending";
			currentPhase.tasks.push({ content, status });
			continue;
		}

		// Note line: > note
		const noteMatch = trimmed.match(/^>\s*(.+)$/);
		if (noteMatch && currentPhase && currentPhase.tasks.length > 0) {
			const last = currentPhase.tasks[currentPhase.tasks.length - 1];
			last.notes = [...(last.notes || []), noteMatch[1].trim()];
			continue;
		}
	}

	if (phases.length === 0) {
		errors.push("no phases or tasks found in markdown");
	}
	return { phases, errors };
}

const ROMAN_PAIRS: Array<[number, string]> = [
	[10, "X"],
	[9, "IX"],
	[5, "V"],
	[4, "IV"],
	[1, "I"],
];

export function phaseRomanNumeral(oneBasedIndex: number): string {
	let n = oneBasedIndex;
	let result = "";
	for (const [value, numeral] of ROMAN_PAIRS) {
		while (n >= value) {
			result += numeral;
			n -= value;
		}
	}
	return result;
}

export function formatPhaseDisplayName(
	name: string,
	oneBasedIndex: number,
): string {
	return `${phaseRomanNumeral(oneBasedIndex)}. ${name}`;
}

// ── Widget selection helpers ───────────────────────────────────

/**
 * Fold the list of ALL tasks (all phases flattened) to at most
 * maxVisible rows: in_progress first, then earliest pending, keeping
 * one slot for the most recent completed.
 *
 * Returns items WITH their source phase name for display.
 */
export function selectVisibleTodos(
	todos: readonly TodoItem[],
	maxVisible: number = MAX_VISIBLE_TODOS,
): VisibleTodos {
	const inProgress: TodoItem[] = [];
	const pending: TodoItem[] = [];
	const done: TodoItem[] = [];
	const abandoned: TodoItem[] = [];

	for (const t of todos) {
		if (t.status === "in_progress") inProgress.push(t);
		else if (t.status === "pending") pending.push(t);
		else if (t.status === "completed") done.push(t);
		else abandoned.push(t);
	}

	// All in_progress first
	const selected: TodoItem[] = [...inProgress];
	let remaining = maxVisible - selected.length;

	// Then earliest pending
	if (remaining > 0 && pending.length > 0) {
		selected.push(...pending.slice(0, remaining));
		remaining = maxVisible - selected.length;
	}

	// Keep one slot for the most recent done
	if (remaining <= 0 && done.length > 0) {
		// Replace the last pending if we're at capacity
		selected[selected.length - 1] = done[0];
	} else if (remaining > 0 && done.length > 0) {
		selected.push(done[0]);
	}

	const hiddenCounts: Record<TodoStatus, number> = {
		pending: pending.length,
		in_progress: inProgress.length,
		completed: done.length,
		abandoned: abandoned.length,
	};

	// Subtract visible from hidden counts
	for (const t of selected) {
		hiddenCounts[t.status]--;
	}

	const totalInList = inProgress.length + pending.length + done.length + abandoned.length;
	const hidden = totalInList - selected.length;

	return { rows: selected, hidden, hiddenCounts };
}

// ── Flat list backward compat ────────────────────────────────

/**
 * Normalize tool input into a clean TodoItem list (flat format, Kimi
 * compat). Used only by tests / old tool integrations; new code should
 * use applyOp with the phased model.
 */
export function normalizeTodos(input: unknown): TodoItem[] {
	if (!Array.isArray(input)) throw new Error('todo_list: "todos" must be an array');
	if (input.length > MAX_ITEMS)
		throw new Error("todo_list: too many items (max 50)");
	const seen = new Set<string>();
	const STATUS_MAP: Record<string, TodoStatus> = {
		pending: "pending",
		in_progress: "in_progress",
		done: "completed",
		completed: "completed",
		abandoned: "abandoned",
	};
	return input.map((raw: unknown, i: number) => {
		const rawObj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
		const content = String(rawObj.title ?? rawObj.content ?? `task ${i + 1}`).slice(0, 200);
		if (seen.has(content)) throw new Error(`duplicate task: "${content}"`);
		seen.add(content);
		const statusRaw = String(rawObj.status ?? "pending");
		const status = STATUS_MAP[statusRaw] || "pending";
		const notes = Array.isArray(rawObj.notes) ? (rawObj.notes as string[]) : undefined;
		const details = typeof rawObj.details === "string" ? rawObj.details : undefined;
		return { content, status, notes, details };
	});
}

/**
 * Convert flat TodoItem[] to a single-phase TodoPhase[].
 */
export function todosToPhases(todos: TodoItem[]): TodoPhase[] {
	if (todos.length === 0) return [];
	return [{ name: DEFAULT_INIT_PHASE, tasks: todos }];
}

// ── Subagent task matching ───────────────────────────────────

const TODO_DESCRIPTION_MIN_OVERLAP = 6;

function normalizeForTodoMatch(value: string): string {
	return value
		.toLowerCase()
		.replace(
			/[^a-z0-9\u00C0-\u024F\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]+/g,
			" ",
		)
		.trim();
}

export function todoMatchesAnyDescription(
	content: string,
	descriptions: readonly string[],
): boolean {
	const normalized = normalizeForTodoMatch(content);
	if (!normalized) return false;
	const tokens = normalized.split(/\s+/);
	for (const desc of descriptions) {
		const normalizedDesc = normalizeForTodoMatch(desc);
		if (!normalizedDesc) continue;
		const descTokens = new Set(normalizedDesc.split(/\s+/));
		let overlap = 0;
		for (const token of tokens) {
			if (descTokens.has(token)) overlap++;
		}
		if (overlap >= TODO_DESCRIPTION_MIN_OVERLAP) return true;
	}
	return false;
}

export type TodoActiveDescriptionsProvider = () => readonly string[];
let activeTodoDescriptions: TodoActiveDescriptionsProvider = () => [];

export function setActiveTodoDescriptionsProvider(
	provider: TodoActiveDescriptionsProvider,
): void {
	activeTodoDescriptions = provider;
}

export function getActiveTodoDescriptions(): readonly string[] {
	return activeTodoDescriptions();
}
