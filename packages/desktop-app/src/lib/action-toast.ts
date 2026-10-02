/**
 * Undo-action toasts (openchamber parity: "archive … every archive message
 * offers Undo").
 *
 * Destructive sidebar/session actions need a reversal, and the reversal here
 * is always cheap: archiving is a localStorage list edit
 * (client-core session-archive), not a daemon mutation, so undo restores the
 * row without a round trip and without a confirmation dialog.
 *
 * Plain module state + listener set — no React, no external store (mirrors
 * lib/update-ux.ts). Components subscribe via useEffect and re-read
 * getToasts(); the toast itself owns its dismissal timer.
 */

export interface ActionToast {
	id: number;
	/** Localized body copy, e.g. "已归档会话". */
	message: string;
	/** Localized button copy. Omitted → a plain notice with no button. */
	actionLabel?: string;
	/** Runs on click, then the toast dismisses itself. */
	onAction?(): void;
	/** Epoch ms; the toast is gone by then. */
	expiresAt: number;
}

/** Long enough to read and click, short enough not to stack up. */
export const ACTION_TOAST_TTL_MS = 6000;

let toasts: readonly ActionToast[] = [];
let seq = 0;

const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) listener();
}

export function getToasts(): readonly ActionToast[] {
	return toasts;
}

/** Show a toast. A new toast replaces any earlier one carrying the same
 *  message — repeated archiving of different sessions should not stack up
 *  identical rows, and the newest undo is the relevant one. */
export function pushActionToast(toast: Omit<ActionToast, "id" | "expiresAt">): number {
	const id = ++seq;
	const next: ActionToast = {
		...toast,
		id,
		expiresAt: Date.now() + ACTION_TOAST_TTL_MS,
	};
	toasts = [...toasts.filter(t => t.message !== toast.message), next];
	emit();
	return id;
}

/** Drop one by id (the toast's own timer fired, or it was clicked). */
export function dismissActionToast(id: number): void {
	if (!toasts.some(t => t.id === id)) return;
	toasts = toasts.filter(t => t.id !== id);
	emit();
}

export function subscribeActionToasts(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
