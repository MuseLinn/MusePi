import { useCallback, useEffect, useState } from "react";
import type { RpcClient } from "../../lib/rpc";
import type { TodoPhaseView } from "./todo-panel";

/** session.modes wire shape (TUI /goal /plan parity). */
export interface ComposerModes {
	goalMode: { enabled: boolean; objective?: string; status?: string } | null;
	planMode: boolean;
	isCompacting: boolean;
	todo: TodoPhaseView[];
}

/**
 * Goal / plan mode + todo progress (TUI /goal /plan parity): polls
 * session.modes every 3s (visibility-gated), arms goal mode (one tap with
 * no live goal arms goal mode — the NEXT SENT MESSAGE becomes the
 * objective), and routes todo mutations through session.todo. `setModes`
 * is returned so the composer's send path can apply a goal created from
 * the sent message.
 */
export function useModes(rpc: RpcClient | null, sessionId: string): {
	modes: ComposerModes | null;
	setModes(
		next: ComposerModes | null | ((prev: ComposerModes | null) => ComposerModes | null),
	): void;
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
		let id = setInterval(refreshModes, 3000);
		// The poll is pure UI freshness — never run it while the tab is
		// hidden (background CPU + daemon RPCs for nothing).
		const onVis = (): void => {
			clearInterval(id);
			if (document.visibilityState === "visible") {
				refreshModes();
				id = setInterval(refreshModes, 3000);
			}
		};
		document.addEventListener("visibilitychange", onVis);
		return () => {
			clearInterval(id);
			document.removeEventListener("visibilitychange", onVis);
		};
	}, [refreshModes]);
	// Armed goal (openchamber parity): one tap with no live goal arms goal
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
	const todo = modes?.todo ?? [];
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
