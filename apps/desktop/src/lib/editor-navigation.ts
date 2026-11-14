export interface EditorLocation {
	/** Absolute document path. Monaco lines and columns are one-based. */
	path: string;
	lineNumber: number;
	column: number;
}

export interface EditorHistory {
	readonly entries: readonly EditorLocation[];
	/** Index of the location currently shown; -1 for an empty history. */
	readonly index: number;
}

export interface EditorHistoryMove {
	history: EditorHistory;
	location: EditorLocation;
}

export type EditorHistoryDirection = "back" | "forward";

const MAX_EDITOR_HISTORY_ENTRIES = 100;

export const EMPTY_EDITOR_HISTORY: EditorHistory = { entries: [], index: -1 };

function samePath(a: string, b: string): boolean {
	const left = a.replace(/\\/g, "/");
	const right = b.replace(/\\/g, "/");
	// Windows drive paths and UNC shares are case-insensitive. POSIX paths are not.
	if (/^[A-Za-z]:\//.test(left) || left.startsWith("//")) return left.toLowerCase() === right.toLowerCase();
	return left === right;
}

function sameLocation(a: EditorLocation, b: EditorLocation): boolean {
	return samePath(a.path, b.path) && a.lineNumber === b.lineNumber && a.column === b.column;
}

function boundedHistory(entries: readonly EditorLocation[]): EditorHistory {
	const kept = entries.slice(-MAX_EDITOR_HISTORY_ENTRIES);
	return { entries: kept, index: kept.length - 1 };
}

/** Record a definition-style jump. The source is the latest cursor, not the
 * position captured when its file was first opened. */
export function pushEditorHistory(
	history: EditorHistory,
	source: EditorLocation,
	target: EditorLocation,
): EditorHistory {
	const entries = history.entries.slice(0, history.index + 1);
	const current = entries.at(-1);
	if (current && samePath(current.path, source.path)) entries[entries.length - 1] = source;
	else entries.push(source);
	if (!sameLocation(entries[entries.length - 1]!, target)) entries.push(target);
	return boundedHistory(entries);
}

/** Cursor movement updates the current entry; it does not create a new one. */
export function updateEditorHistoryCurrent(history: EditorHistory, location: EditorLocation): EditorHistory {
	const current = history.entries[history.index];
	if (!current || !samePath(current.path, location.path) || sameLocation(current, location)) return history;
	const entries = history.entries.slice();
	entries[history.index] = location;
	return { ...history, entries };
}

export function canMoveEditorHistory(history: EditorHistory, direction: EditorHistoryDirection): boolean {
	const target = direction === "back" ? history.index - 1 : history.index + 1;
	return target >= 0 && target < history.entries.length;
}

export function moveEditorHistory(history: EditorHistory, direction: EditorHistoryDirection): EditorHistoryMove | null {
	const target = direction === "back" ? history.index - 1 : history.index + 1;
	const location = history.entries[target];
	if (!location) return null;
	return { history: { ...history, index: target }, location };
}
