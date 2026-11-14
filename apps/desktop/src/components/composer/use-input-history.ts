import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Composer input history (TUI editor history parity): ArrowUp/ArrowDown
 * browse previously submitted prompts. Stored per project dir (cwd) in
 * localStorage — same scope as the TUI's HistoryStorage, so the recall
 * ring follows the workspace you're working in rather than leaking across
 * projects.
 *
 * Navigation model mirrors the TUI editor:
 *  - ArrowUp on an empty box (or with the caret at the very start) starts
 *    browsing from the most recent entry; further ArrowUp walks older.
 *  - ArrowDown walks back toward the present, then restores the in-progress
 *    draft the user was typing when they started browsing.
 *  - Any genuine keystroke that edits the box exits browsing.
 *
 * The stored array is oldest → newest (append order); the browse index counts
 * from the newest end, so 0 is the most recent entry. {@link navigateHistory}
 * owns that mapping and {@link useInputHistory}'s `browseHistory` owns the
 * draft snapshot, so the composer only decides WHEN a key browses.
 */

const HISTORY_KEY_PREFIX = "musepi-gui-input-history";
const MAX_ENTRIES = 100;

export type HistoryDirection = "older" | "newer";

/**
 * One browse step over an oldest → newest ring. Returns the next cursor and
 * the text to show, or null when the cursor cannot move (empty history, ArrowUp
 * past the oldest entry, ArrowDown while not browsing) — the caller then leaves
 * the key to the editor. Reaching newer-than-newest returns index null and the
 * saved draft.
 */
export function navigateHistory(
	history: readonly string[],
	index: number | null,
	direction: HistoryDirection,
	draft: string,
): { index: number | null; text: string } | null {
	const at = (cursor: number): string => history[history.length - 1 - cursor] ?? "";
	if (direction === "older") {
		if (index === null) return history.length > 0 ? { index: 0, text: at(0) } : null;
		if (index >= history.length - 1) return null;
		return { index: index + 1, text: at(index + 1) };
	}
	if (index === null) return null;
	if (index === 0) return { index: null, text: draft };
	return { index: index - 1, text: at(index - 1) };
}

function storageKey(cwd?: string): string {
	// cwd is the session workspace root; a stable prefix keeps the key
	// namespaced per project. Missing cwd falls back to the shared key.
	return cwd ? `${HISTORY_KEY_PREFIX}:${cwd}` : HISTORY_KEY_PREFIX;
}

function load(key: string): string[] {
	try {
		const raw = localStorage.getItem(key);
		const parsed = raw ? (JSON.parse(raw) as unknown) : [];
		return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}

function save(key: string, value: string[]): void {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		/* storage unavailable — keep the in-memory ring for this session */
	}
}

export function useInputHistory(cwd?: string): {
	/** Browsable ring, oldest → newest (feed it to {@link navigateHistory}). */
	history: string[];
	/** Current browse index (null = not browsing). 0 = most recent. */
	historyIndex: number | null;
	/**
	 * Step the browse cursor and return the text the box should show, or null
	 * when the key should stay with the editor. `text` is the box's current
	 * content: the first step snapshots it — empty included — as the draft that
	 * walking back past the newest entry restores.
	 */
	browseHistory(direction: HistoryDirection, text: string): string | null;
	setHistoryIndex(index: number | null): void;
	/** Record a submitted prompt (a repeat moves back to the newest slot). */
	pushHistory(prompt: string): void;
} {
	const key = useMemo(() => storageKey(cwd), [cwd]);
	const [history, setHistory] = useState<string[]>(() => load(key));
	const [historyIndex, setHistoryIndex] = useState<number | null>(null);
	const draftBackupRef = useRef("");

	// The composer stays mounted across session switches (ChatView swaps the
	// store in place); when the project dir (and thus the history scope)
	// changes, swap the loaded ring and drop any in-progress browse.
	useEffect(() => {
		setHistory(load(key));
		setHistoryIndex(null);
		draftBackupRef.current = "";
	}, [key]);

	const browseHistory = useCallback(
		(direction: HistoryDirection, text: string): string | null => {
			const step = navigateHistory(history, historyIndex, direction, draftBackupRef.current);
			if (!step) return null;
			if (historyIndex === null) draftBackupRef.current = text;
			setHistoryIndex(step.index);
			return step.text;
		},
		[history, historyIndex],
	);

	const pushHistory = useCallback(
		(prompt: string): void => {
			const trimmed = prompt.trim();
			if (!trimmed) return;
			setHistory(prev => {
				// One slot per distinct prompt (TUI history table parity): a
				// re-submitted prompt — including one recalled from the middle of
				// the ring — moves to the newest slot instead of repeating.
				const kept = prev.filter(entry => entry !== trimmed);
				const capped = [...kept, trimmed].slice(-MAX_ENTRIES);
				save(key, capped);
				return capped;
			});
			// A real submission ends any browse session.
			setHistoryIndex(null);
		},
		[key],
	);

	return { history, historyIndex, browseHistory, setHistoryIndex, pushHistory };
}
