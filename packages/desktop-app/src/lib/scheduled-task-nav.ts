/**
 * Task-center two-tier state bridge (2026-11-08).
 *
 * The destination's LEFT PANEL lives in the app's sidebar slot (the same
 * place the home session list uses), while ScheduledTasksPage owns the main
 * surface. They are separate React subtrees, so they share one snapshot and
 * one action channel here — no second `cron.list` poll, no duplicated
 * selection state.
 *
 * The snapshot is deliberately a small projection (id/name/enabled/cwd/
 * lastStatus): the page keeps its full CronTask objects and run history.
 */
import type { TaskCenterView } from "./scheduled-task-types";

interface TaskNavItem {
	id: string;
	name: string;
	enabled: boolean;
	cwd: string;
	lastStatus?: string;
}

export interface TaskNavSnapshot {
	tasks: readonly TaskNavItem[];
	selectedId: string | null;
	view: TaskCenterView;
	busy: boolean;
}

export type TaskNavAction =
	| { type: "select"; id: string }
	| { type: "new" }
	| { type: "view"; view: TaskCenterView }
	| { type: "refresh" };

const EMPTY: TaskNavSnapshot = { tasks: [], selectedId: null, view: "tasks", busy: false };
let snapshot: TaskNavSnapshot = EMPTY;
const stateListeners = new Set<() => void>();
const actionListeners = new Set<(action: TaskNavAction) => void>();
/**
 * An action emitted while the page is not mounted. Hover-peek renders the
 * panel beside a different destination, and the destination swap mounts the
 * page ~150ms later; retaining the last action lets the row click that
 * committed the swap still open the task it named. Last write wins.
 */
let pendingAction: TaskNavAction | null = null;

export function publishTaskNav(next: TaskNavSnapshot): void {
	snapshot = next;
	for (const listener of stateListeners) listener();
}

export function readTaskNav(): TaskNavSnapshot {
	return snapshot;
}

export function subscribeTaskNav(listener: () => void): () => void {
	stateListeners.add(listener);
	return () => stateListeners.delete(listener);
}

export function emitTaskNavAction(action: TaskNavAction): void {
	if (actionListeners.size === 0) {
		pendingAction = action;
		return;
	}
	pendingAction = null;
	for (const listener of actionListeners) listener(action);
}

export function subscribeTaskNavAction(listener: (action: TaskNavAction) => void): () => void {
	actionListeners.add(listener);
	const pending = pendingAction;
	if (pending) {
		pendingAction = null;
		listener(pending);
	}
	return () => actionListeners.delete(listener);
}

/** Reset on unmount so a later visit cannot flash the previous session's
 *  task list before the page publishes its first snapshot. */
export function clearTaskNav(): void {
	publishTaskNav(EMPTY);
}
