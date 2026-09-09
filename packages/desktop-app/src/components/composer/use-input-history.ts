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
 * The hook owns the history array + the browsing index; the caller decides
 * WHEN to navigate (it knows the caret position and menu-open state) and
 * calls the returned helpers.
 */

const HISTORY_KEY_PREFIX = "musepi-gui-input-history";
const MAX_ENTRIES = 100;

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
	/** Browsable ring, oldest → newest. */
	history: string[];
	/** Current browse index (null = not browsing). 0 = most recent. */
	historyIndex: number | null;
	/** In-progress draft saved when browsing starts, restored at the end. */
	draftBackupRef: React.MutableRefObject<string>;
	setHistoryIndex(index: number | null): void;
	/** Record a submitted prompt (dedupes a consecutive repeat). */
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
	}, [key]);

	const pushHistory = useCallback(
		(prompt: string): void => {
			const trimmed = prompt.trim();
			if (!trimmed) return;
			setHistory(prev => {
				const next = prev[prev.length - 1] === trimmed ? prev : [...prev, trimmed];
				const capped = next.slice(-MAX_ENTRIES);
				save(key, capped);
				return capped;
			});
			// A real submission ends any browse session.
			setHistoryIndex(null);
		},
		[key],
	);

	return { history, historyIndex, draftBackupRef, setHistoryIndex, pushHistory };
}
