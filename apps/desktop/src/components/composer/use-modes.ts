import type { SessionEntry } from "@musepi/pi-wire";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { RpcClient } from "../../lib/rpc";
import { todoPhasesFromEntries } from "./todo-from-transcript";
import type { TodoPhaseView } from "./todo-panel";

/** Reconciliation cadence for what the transcript cannot express (goal/plan
 *  mode, session preset). The todo list no longer depends on it. */
const MODES_RECONCILE_MS = 30_000;

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
 * The TODO LIST is derived from the transcript (`todoPhasesFromEntries`),
 * not polled: entries are pushed, so the panel follows the agent as it works
 * instead of up to 3s behind. `session.modes` is still read, but now only for
 * what the transcript cannot express — goal/plan mode, the session preset and
 * the compaction flag — and on a reconciliation interval rather than as the
 * source of every tick.
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
	useEffect(() => {
		refreshModes();
		// Reconciliation only: the todo list comes from the transcript and
		// local goal/plan/todo mutations merge their own RPC response, so this
		// catches a goal or preset changed elsewhere (the TUI, a `/goal` in a
		// terminal). Never runs while the tab is hidden.
		let id = setInterval(refreshModes, MODES_RECONCILE_MS);
		const onVis = (): void => {
			clearInterval(id);
			if (document.visibilityState === "visible") {
				refreshModes();
				id = setInterval(refreshModes, MODES_RECONCILE_MS);
			}
		};
		document.addEventListener("visibilitychange", onVis);
		return () => {
			clearInterval(id);
			document.removeEventListener("visibilitychange", onVis);
		};
	}, [refreshModes]);
	// Armed goal: one tap with no live goal arms goal
	// mode — the NEXT SENT MESSAGE becomes the objective (no popup dialog,
	// same one-tap shape as the plan-mode toggle). A second tap disarms.
	const [goalArmed, setGoalArmed] = useState(false);
	// A goal arriving from the daemon (poll/own send) clears the armed state.
	useEffect(() => {
		if (modes?.goalMode?.enabled === true) setGoalArmed(false);
	}, [modes?.goalMode?.enabled]);
	const toggleGoalMode = (): void => {
		if (!rpc || !sessionId) return;
		// End an active goal without prompting (TUI /goal off parity).
		if (modes?.goalMode?.enabled === true) {
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
		modes,
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
