/**
 * One session's presence, derived from the live runtime plus its persisted row.
 *
 * This is the public session-state contract behind `session.list` and
 * `session.presence`: the GUI, tray and companion all consume the same shape
 * instead of each re-deriving phase/attention from live fields. A session that
 * is not live still gets a row-derived presence (idle/error), so background
 * sessions remain observable without a subscription.
 */

import type { SessionPresence, SessionPresencePhase } from "@musepi/pi-wire";

export interface SessionPresenceLive {
	agentSession?: {
		isStreaming?: boolean;
		isCompacting?: boolean;
	} | null;
	view?: {
		snapshot(): {
			state: {
				isStreaming?: boolean;
				isCompacting?: boolean;
			};
		};
	};
	activeToolCalls?: ReadonlyMap<string, { toolName: string }>;
	approvals?: {
		pending: ReadonlyMap<string, unknown>;
		pendingAsks: ReadonlyMap<string, unknown>;
	};
	pauseGate?: { paused?: boolean };
}

export interface SessionPresenceRow {
	sessionId: string;
	updatedAt: string;
	status?: string;
}

export function deriveSessionPresence(
	live: SessionPresenceLive | null | undefined,
	row: SessionPresenceRow,
): SessionPresence {
	const pendingApprovals = live?.approvals?.pending.size ?? 0;
	const pendingQuestions = live?.approvals?.pendingAsks.size ?? 0;
	const activeTool =
		live?.activeToolCalls && live.activeToolCalls.size > 0
			? ([...live.activeToolCalls.values()].at(-1)?.toolName ?? null)
			: null;

	const paused = live?.pauseGate?.paused === true;
	const snapshot = live?.view?.snapshot();
	const streaming = live?.agentSession?.isStreaming === true || snapshot?.state.isStreaming === true;
	const compacting = live?.agentSession?.isCompacting === true || snapshot?.state.isCompacting === true;

	const phase: SessionPresencePhase = paused
		? "paused"
		: pendingApprovals > 0
			? "awaiting-approval"
			: pendingQuestions > 0
				? "awaiting-input"
				: compacting
					? "compacting"
					: activeTool !== null
						? "tool"
						: streaming
							? "streaming"
							: row.status === "error"
								? "error"
								: live
									? "idle"
									: "idle";

	return {
		sessionId: row.sessionId,
		phase,
		working: paused ? false : streaming || compacting || activeTool !== null,
		live: live !== null && live !== undefined,
		paused,
		activeTool,
		pendingApprovals,
		pendingQuestions,
		updatedAt: row.updatedAt,
	};
}
