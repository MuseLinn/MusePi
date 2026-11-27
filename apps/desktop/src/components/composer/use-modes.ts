import type { SessionEntry, SessionModeProjection } from "@musepi/pi-wire";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { RpcClient } from "../../lib/rpc";
import { todoPhasesFromEntries } from "./todo-from-transcript";
import type { TodoPhaseView } from "./todo-panel";

/** session.modes wire shape (TUI /goal /plan parity). */
export interface ComposerModes {
	goalMode: { enabled: boolean; objective?: string; status?: string } | null;
	planMode: boolean;
	isCompacting: boolean;
	todo: TodoPhaseView[];
	/** 会话预设 id（"design" 等）——design 会话的 composer 风格 chips 依赖它判型。 */
	agentPreset?: string | null;
}

/**
 * Goal / plan mode + todo progress (TUI /goal /plan parity).
 *
 * Nothing here polls for state. The TODO LIST derives from the transcript
 * (`todoPhasesFromEntries`), and GOAL / PLAN come from the daemon's
 * `sessionMode` projection (`sessionModeProjection`), which the host samples
 * and pushes after every RPC that writes them — so a switch flipped by the TUI
 * or another device lands as a frame instead of on a timer.
 *
 * `session.modes` is still fetched once per surface for the session preset and
 * the compaction flag (neither is projected yet); it is a one-shot read on
 * mount and after a local mutation, not a repeating poll.
 *
 * It also arms goal mode (one tap with no live goal makes the NEXT SENT
 * MESSAGE the objective) and routes todo mutations through session.todo.
 * `setModes` is returned so the composer's send path can apply a goal created
 * from the sent message.
 */
export function useModes(
	rpc: RpcClient | null,
	sessionId: string,
	entries: readonly SessionEntry[] = [],
	sessionMode: SessionModeProjection | null = null,
): {
	modes: ComposerModes | null;
	setModes(next: ComposerModes | null | ((prev: ComposerModes | null) => ComposerModes | null)): void;
	todo: TodoPhaseView[];
	todoTotal: number;
	todoDone: number;
	goalArmed: boolean;
	setGoalArmed(armed: boolean): void;
	toggleGoalMode(): void;
	togglePlanMode(): void;
	todoOp(op: "append" | "start" | "done" | "drop" | "rm", content?: string, phase?: string): void;
	refreshModes(): void;
	todoOpen: boolean;
	setTodoOpen(open: boolean | ((prev: boolean) => boolean)): void;
	appendText: string;
	setAppendText(value: string): void;
} {
	const [modes, setModes] = useState<ComposerModes | null>(null);
	const [todoOpen, setTodoOpen] = useState(false);
	const [appendText, setAppendText] = useState("");
	const refreshModes = useCallback((): void => {
		if (!rpc || !sessionId) return;
		void rpc
			.request<typeof modes>("session.modes", { sessionId })
			.then(res => {
				// Value-compare: keep the previous reference when nothing
				// changed so the tick never re-renders the composer.
				if (res) setModes(prev => (JSON.stringify(prev) === JSON.stringify(res) ? prev : res));
			})
			.catch(() => {});
	}, [rpc, sessionId]);
	// One-shot: the preset and compaction flag are not projected yet, so this
	// reads them once per surface. Goal and plan arrive as pushed projection
	// values (below) and never wait for it.
	useEffect(() => {
		refreshModes();
	}, [refreshModes]);
	// Armed goal: one tap with no live goal arms goal
	// mode — the NEXT SENT MESSAGE becomes the objective (no popup dialog,
	// same one-tap shape as the plan-mode toggle). A second tap disarms.
	const [goalArmed, setGoalArmed] = useState(false);
	// The projection is the live source; `modes` covers the first frame after
	// mount (before the snapshot's projection baseline has been read).
	const liveGoal = sessionMode ? sessionMode.goal : (modes?.goalMode ?? null);
	const livePlan = sessionMode ? sessionMode.plan : (modes?.planMode ?? false);
	// Callers read the badges off `modes`; merging the projection in here keeps
	// them unchanged while the live values become push-driven. `modes` still
	// answers for the preset/compaction fields it owns.
	const mergedModes: ComposerModes | null = modes
		? { ...modes, goalMode: liveGoal, planMode: livePlan }
		: sessionMode
			? { goalMode: liveGoal, planMode: livePlan, isCompacting: false, todo: [] }
			: null;
	// A goal arriving from the daemon (projection frame / own send) clears the
	// armed state.
	useEffect(() => {
		if (liveGoal?.enabled === true) setGoalArmed(false);
	}, [liveGoal?.enabled]);
	const toggleGoalMode = (): void => {
		if (!rpc || !sessionId) return;
		// End an active goal without prompting (TUI /goal off parity).
		if (liveGoal?.enabled === true) {
			void rpc
				.request("session.setGoal", { sessionId })
				.then(res => setModes(res as typeof modes))
				.catch(() => {});
			return;
		}
		setGoalArmed(v => !v);
	};
	const togglePlanMode = (): void => {
		if (!rpc || !sessionId) return;
		void rpc
			.request("session.setPlan", { sessionId })
			.then(res => setModes(res as typeof modes))
			.catch(() => {});
	};
	// The transcript is the live source: the agent's own `todo` results and the
	// panel's `user_todo_edit` rows both land there as pushed entries.
	const derivedTodo = useMemo(() => todoPhasesFromEntries(entries), [entries]);
	const todo = entries.length > 0 ? derivedTodo : (modes?.todo ?? []);
	const todoTotal = todo.reduce((n, p) => n + p.total, 0);
	const todoDone = todo.reduce((n, p) => n + p.done, 0);
	// Todo mutations (TUI /todo parity): the panel is read-only without
	// these; each op round-trips through the daemon (setTodoPhases +
	// user_todo_edit entry) and swaps the fresh snapshot into the polled
	// `modes` so the chips/bar update in place.
	const todoOp = useCallback(
		(op: "append" | "start" | "done" | "drop" | "rm", content?: string, phase?: string): void => {
			if (!rpc || !sessionId) return;
			void rpc
				.request<{ todo: typeof todo }>("session.todo", { sessionId, op, content, phase })
				.then(res => {
					if (res?.todo) setModes(prev => (prev ? { ...prev, todo: res.todo } : prev));
				})
				.catch(() => {});
		},
		[rpc, sessionId],
	);

	return {
		modes: mergedModes,
		setModes,
		todo,
		todoTotal,
		todoDone,
		goalArmed,
		setGoalArmed,
		toggleGoalMode,
		togglePlanMode,
		todoOp,
		refreshModes,
		todoOpen,
		setTodoOpen,
		appendText,
		setAppendText,
	};
}
