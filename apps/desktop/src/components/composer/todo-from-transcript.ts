/**
 * Todo progress derived from the transcript, not polled from the daemon.
 *
 * The composer's todo panel used to re-read `session.modes` every 3s purely to
 * notice that the agent had moved a task. That fact is already in the
 * transcript: every `todo` tool result carries the full phase list in
 * `details.phases`, and a user edit from the panel is a `user_todo_edit`
 * custom entry. Transcript entries are pushed (`entry` frames), so deriving
 * from them makes the panel update as the agent works instead of up to 3s
 * later.
 *
 * The rule mirrors the daemon's own `getLatestTodoPhasesFromEntries` (the
 * newest authoritative source wins, later entries beat earlier ones); it lives
 * here rather than in the daemon because the GUI has the entries, not the live
 * AgentSession.
 */
import type { SessionEntry } from "@musepi/pi-wire";
import type { TodoPhaseView } from "./todo-panel";

/** Custom-entry type the panel's own edits are persisted under (daemon-owned
 *  constant `USER_TODO_EDIT_CUSTOM_TYPE`). */
const USER_TODO_EDIT_CUSTOM_TYPE = "user_todo_edit";

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** Normalize one wire phase into the panel's view shape.
 *  A phase with neither a name nor any usable task is dropped: it would
 *  otherwise paint an empty progress row with a blank label. */
function toPhaseView(raw: unknown): TodoPhaseView | null {
	const record = asRecord(raw);
	if (!record) return null;
	const name = typeof record.name === "string" ? record.name : "";
	const rawTasks = Array.isArray(record.tasks) ? record.tasks : [];
	const tasks = rawTasks.flatMap(task => {
		const t = asRecord(task);
		if (!t || typeof t.content !== "string") return [];
		return [
			{
				content: t.content,
				status: typeof t.status === "string" ? t.status : "pending",
				...(typeof t.blocker === "string" ? { blocker: t.blocker } : {}),
			},
		];
	});
	if (name === "" && tasks.length === 0) return null;
	return {
		name,
		done: tasks.filter(task => task.status === "completed").length,
		total: tasks.length,
		tasks,
	};
}

/**
 * The phase list the panel should show: the newest entry that carries one,
 * preferring a whole-transcript scan backwards (a later edit always wins over
 * an earlier tool result, exactly as the daemon reads it).
 */
export function todoPhasesFromEntries(entries: readonly SessionEntry[]): TodoPhaseView[] {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; customType?: string; data?: unknown; message?: unknown };
		if (entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE) {
			const phases = asRecord(entry.data)?.phases;
			if (Array.isArray(phases)) return phases.flatMap(phase => toPhaseView(phase) ?? []);
			continue;
		}
		if (entry.type !== "message") continue;
		const message = asRecord(entry.message) as {
			role?: string;
			toolName?: string;
			details?: unknown;
			isError?: boolean;
		} | null;
		// Only a successful `todo` result is authoritative: a failed call means
		// the list did not move, so keep looking further back.
		if (message?.role !== "toolResult" || message.toolName !== "todo" || message.isError === true) continue;
		const phases = asRecord(message.details)?.phases;
		if (!Array.isArray(phases)) continue;
		return phases.flatMap(phase => toPhaseView(phase) ?? []);
	}
	return [];
}
