import type { ActionToastKind } from "./action-toast";

export interface NotificationHistoryEntry {
	id: number;
	kind: ActionToastKind;
	title?: string;
	message: string;
	createdAt: number;
	read: boolean;
}

export const MAX_NOTIFICATION_HISTORY = 100;

let entries: readonly NotificationHistoryEntry[] = [];
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) listener();
}

export function listNotificationHistory(): readonly NotificationHistoryEntry[] {
	return entries;
}

export function unreadNotificationHistoryCount(): number {
	return entries.reduce((count, entry) => count + (entry.read ? 0 : 1), 0);
}

export function recordNotificationHistory(input: Omit<NotificationHistoryEntry, "read">): void {
	if (entries.some(entry => entry.id === input.id)) return;
	entries = [{ ...input, read: false }, ...entries].slice(0, MAX_NOTIFICATION_HISTORY);
	emit();
}

export function markAllNotificationHistoryRead(): void {
	if (!entries.some(entry => !entry.read)) return;
	entries = entries.map(entry => (entry.read ? entry : { ...entry, read: true }));
	emit();
}

export function clearNotificationHistory(): void {
	if (entries.length === 0) return;
	entries = [];
	emit();
}

export function subscribeNotificationHistory(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
