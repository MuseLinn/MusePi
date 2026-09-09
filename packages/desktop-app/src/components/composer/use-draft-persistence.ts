import { useCallback, useEffect, useRef } from "react";
import type { RpcClient } from "../../lib/rpc";

/**
 * Draft persistence (persistDraft parity) + idle-recap editor-draft guard:
 * restore the per-session draft when the composer mounts or the session
 * switches, save every change, and report the un-sent draft to the daemon
 * (session.setDraft) so a scheduled idle recap is suppressed while the
 * user is composing. The composer stays mounted across session switches
 * (ChatView swaps the store in place), so the box must be RESET to the
 * incoming session's draft — the old restore only FILLED empty boxes and
 * never cleared, so text recalled in one session ("撤回还原") stayed in the
 * box for every later session and the save effect then wrote it under the
 * new session's draft key.
 */
export function useDraftPersistence({
	sessionId,
	rpc,
	text,
	setText,
}: {
	sessionId: string;
	rpc: RpcClient | null;
	text: string;
	setText(value: string): void;
}): void {
	// Stable identity: the draft RESTORE effect keys on draftEnabled, so a
	// fresh closure per render would re-run the restore on EVERY render —
	// deleting the last character (text → "") then resurrects the stale
	// localStorage draft ("最后一个字删不掉"). useCallback keeps the
	// restore scoped to sessionId changes.
	const draftEnabled = useCallback((): boolean => {
		try {
			return localStorage.getItem("musepi-gui-chat-draft") !== "0";
		} catch {
			return true;
		}
	}, []);
	const sessionResetRef = useRef(true);
	useEffect(() => {
		// Keyed on sessionId only: re-running on draftEnabled toggles would
		// clobber in-progress text when the pref flips.
		sessionResetRef.current = true;
		let next = "";
		if (draftEnabled()) {
			try {
				next = localStorage.getItem(`musepi-gui-draft:${sessionId}`) ?? "";
			} catch {
				// localStorage unavailable — start empty
			}
		}
		setText(next);
	}, [sessionId, draftEnabled]);
	// Idle-recap editor-draft guard (TUI parity): report the un-sent draft
	// to the daemon (session.setDraft) so a scheduled idle recap is
	// suppressed while the user is composing. `true` is debounced (typing
	// bursts), `false` goes out immediately — a cleared box must not miss
	// the next agent_end's recap scheduling window.
	const lastSentDraftRef = useRef<boolean | null>(null);
	const draftReportTimerRef = useRef<Timer | null>(null);
	useEffect(() => {
		const hasDraft = text.trim().length > 0;
		if (hasDraft === lastSentDraftRef.current) return;
		if (!hasDraft) {
			if (draftReportTimerRef.current) {
				clearTimeout(draftReportTimerRef.current);
				draftReportTimerRef.current = null;
			}
			lastSentDraftRef.current = false;
			if (rpc && sessionId) {
				void rpc.request("session.setDraft", { sessionId, draft: false }).catch(() => {});
			}
			return;
		}
		if (draftReportTimerRef.current) return;
		draftReportTimerRef.current = setTimeout(() => {
			draftReportTimerRef.current = null;
			lastSentDraftRef.current = true;
			if (rpc && sessionId) {
				void rpc.request("session.setDraft", { sessionId, draft: true }).catch(() => {});
			}
		}, 300);
	}, [text, sessionId, rpc]);
	useEffect(() => {
		return () => {
			if (draftReportTimerRef.current) {
				clearTimeout(draftReportTimerRef.current);
				draftReportTimerRef.current = null;
			}
			if (lastSentDraftRef.current === true && rpc && sessionId) {
				void rpc.request("session.setDraft", { sessionId, draft: false }).catch(() => {});
			}
		};
	}, [rpc, sessionId]);
	useEffect(() => {
		if (sessionResetRef.current) {
			// The text in this commit is either stale (belongs to the
			// previous session) or was just restored by the reset effect —
			// skip writing so old-session text can't leak into the new
			// session's draft key.
			sessionResetRef.current = false;
			return;
		}
		if (!draftEnabled()) return;
		try {
			if (text.length > 0) localStorage.setItem(`musepi-gui-draft:${sessionId}`, text);
			else localStorage.removeItem(`musepi-gui-draft:${sessionId}`);
		} catch {
			// ignore
		}
	}, [text, sessionId, draftEnabled]);
}
