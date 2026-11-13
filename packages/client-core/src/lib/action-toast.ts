/**
 * In-app toast stack: every transient notice the app raises — undo offers,
 * action feedback (branch moved, annotation attached), session-level daemon
 * notices, and error reports routed from `musepi-gui-toast` — lands in ONE
 * floating surface with an icon, the message, and one optional action button.
 *
 * Shared by the desktop shell and the guest/mobile shell: the store lives
 * here so both views read the same list and the extension host module keeps
 * one identity across compiled plugins.
 *
 * Plain module state + listener set — no React, no i18n (mirrors
 * `update-ux.ts`). Components subscribe via `useSyncExternalStore` and
 * re-read `getToasts()`; the toast's view owns its dismissal timer.
 */

/** Visual kind: drives the leading icon and the tint. */
export type ActionToastKind = "info" | "success" | "warning" | "error";

export interface ActionToast {
	id: number;
	/** Visual kind; "info" is a neutral notice. */
	kind: ActionToastKind;
	/** Localized body copy, e.g. "已归档会话". */
	message: string;
	/** Optional concise heading above the body copy. */
	title?: string;
	/** Technical context that can wrap independently of the body copy. */
	details?: string;
	/** Stable source identity; replaces earlier content from that source. */
	dedupeKey?: string;
	/** Localized button copy. Omitted → a plain notice with no button. */
	actionLabel?: string;
	/** Runs on click, then the toast dismisses itself. */
	onAction?(): void;
	/** Optional secondary button; runs before the toast dismisses. */
	cancelLabel?: string;
	onCancel?(): void;
	/** Epoch ms; Infinity while paused or for persistent errors. */
	expiresAt: number;
}

/** Long enough to read and click, short enough not to stack up. */
export const ACTION_TOAST_TTL_MS = 6000;
/** Warnings get extra reading time because they name a condition to fix. */
export const WARNING_TOAST_TTL_MS = 8000;
/** Bound the visible corner; persistent errors do not crowd out newer errors. */
export const MAX_ACTION_TOASTS = 3;

/** Lifetime for one kind; errors stay until dismissed. */
export function ttlFor(kind: ActionToastKind): number {
	if (kind === "error") return Number.POSITIVE_INFINITY;
	return kind === "warning" ? WARNING_TOAST_TTL_MS : ACTION_TOAST_TTL_MS;
}

let toasts: readonly ActionToast[] = [];
let seq = 0;

const listeners = new Set<() => void>();
const pausedRemaining = new Map<number, number>();

function emit(): void {
	for (const listener of listeners) listener();
}

export function getToasts(): readonly ActionToast[] {
	return toasts;
}

export type ActionToastInput = Omit<ActionToast, "id" | "expiresAt" | "kind"> & {
	kind?: ActionToastKind;
	/** Override the kind-derived lifetime (Infinity keeps it until dismissed). */
	ttlMs?: number;
};

/** Show a toast. Repeated sources replace their earlier content. */
export function pushActionToast(toast: ActionToastInput): number {
	const id = ++seq;
	const kind = toast.kind ?? "info";
	const dedupeKey = toast.dedupeKey ?? `message:${toast.message}`;
	const { ttlMs, ...rest } = toast;
	const next: ActionToast = {
		...rest,
		kind,
		id,
		expiresAt: Date.now() + (ttlMs ?? ttlFor(kind)),
	};
	const retained = toasts.filter(previous => {
		const previousKey = previous.dedupeKey ?? `message:${previous.message}`;
		if (previousKey !== dedupeKey) return true;
		pausedRemaining.delete(previous.id);
		return false;
	});
	retained.push(next);
	while (retained.length > MAX_ACTION_TOASTS) {
		const transient = retained.findIndex(previous => previous.kind !== "error");
		const [evicted] = retained.splice(transient >= 0 ? transient : 0, 1);
		if (evicted) pausedRemaining.delete(evicted.id);
	}
	toasts = retained;
	emit();
	return id;
}

/** Freeze the remaining lifetime and publish an infinite deadline so the view drops its timer. */
export function pauseActionToast(id: number): void {
	const toast = toasts.find(t => t.id === id);
	if (!toast || pausedRemaining.has(id) || !Number.isFinite(toast.expiresAt)) return;
	pausedRemaining.set(id, Math.max(0, toast.expiresAt - Date.now()));
	toasts = toasts.map(t => (t.id === id ? { ...t, expiresAt: Number.POSITIVE_INFINITY } : t));
	emit();
}

/** Resume from the frozen remainder; unknown or unpaused ids are no-ops. */
export function resumeActionToast(id: number): void {
	const remaining = pausedRemaining.get(id);
	if (remaining === undefined) return;
	pausedRemaining.delete(id);
	toasts = toasts.map(t => (t.id === id ? { ...t, expiresAt: Date.now() + remaining } : t));
	emit();
}

/** Give a toast a new lifetime from now (e.g. when the window regains focus). */
export function setActionToastTtl(id: number, ttlMs: number): void {
	if (!toasts.some(t => t.id === id)) return;
	toasts = toasts.map(t => (t.id === id ? { ...t, expiresAt: Date.now() + ttlMs } : t));
	emit();
}

/** Drop one by id (the toast's own timer fired, or it was clicked). */
export function dismissActionToast(id: number): void {
	pausedRemaining.delete(id);
	if (!toasts.some(t => t.id === id)) return;
	toasts = toasts.filter(t => t.id !== id);
	emit();
}

/** Clear a recovered source without disturbing unrelated persistent errors. */
export function dismissActionToastSource(dedupeKey: string): void {
	const dismissed = toasts.filter(toast => toast.dedupeKey === dedupeKey);
	if (dismissed.length === 0) return;
	for (const toast of dismissed) pausedRemaining.delete(toast.id);
	toasts = toasts.filter(toast => toast.dedupeKey !== dedupeKey);
	emit();
}

export function subscribeActionToasts(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
