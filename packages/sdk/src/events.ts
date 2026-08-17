/**
 * Session stream contract — subscribe/resume envelope + event union.
 *
 * Architecture risk #1: the Phase 2 contract MUST cover incremental deltas,
 * cancel, reconnect, approval and subagent events. Tightening these later
 * would break generated types.
 *
 * Design: the ENVELOPE is runtime-validated with TypeBox (kind/seq); payloads
 * are typed by reference to pi-wire (SessionEntry / SessionState / AgentEvent
 * / AgentProgress / SubagentLifecyclePayload) — no mirrored schemas, so the
 * duplicated-implementation problem Phase 1 removed does not come back. The
 * payload field stays `unknown` at runtime; the type layer below pins it.
 *
 * seq is a monotonically increasing per-stream sequence. Reconnect hands the
 * last seen seq to session.resume, which replays a snapshot plus deltas after
 * it (mirrors collab replication-shrink).
 */

import type {
	AgentEvent,
	AgentSnapshot,
	SessionEntry,
	SessionHeader,
	SessionState,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "@musepi/pi-wire";
import { Type } from "@sinclair/typebox";

/** Wire shape of one multi-question ask-dialog question (mode "dialog"). */
export interface AskDialogQuestionWire {
	id: string;
	question: string;
	header?: string;
	options: { label: string; description?: string; preview?: string }[];
	multi?: boolean;
	recommended?: number;
}

/** Runtime-validated envelope (kind + seq); payload is pinned by the type layer. */
export const sessionStreamEnvelope = Type.Object({
	kind: Type.Union([
		Type.Literal("entry"),
		Type.Literal("event"),
		Type.Literal("state"),
		Type.Literal("approval-request"),
		Type.Literal("ask-request"),
		Type.Literal("agent-lifecycle"),
		Type.Literal("agent-progress"),
		Type.Literal("pause-state"),
		Type.Literal("global-pause-state"),
		Type.Literal("stream-end"),
		Type.Literal("recap"),
		Type.Literal("title"),
	]),
	seq: Type.Integer({ minimum: 0 }),
	payload: Type.Unknown(),
});

/** The typed event union — payloads reference pi-wire types directly. */
export type SessionStreamEvent =
	| { kind: "entry"; seq: number; payload: SessionEntry }
	| { kind: "event"; seq: number; payload: AgentEvent }
	| { kind: "state"; seq: number; payload: SessionState }
	| {
			kind: "approval-request";
			seq: number;
			payload: { requestId: string; tool: string; args: unknown; scope?: string };
	  }
	// ask tool question / custom input pushed to the GUI (TUI ask parity):
	// the client answers via session.askAnswer. Single select/input keep the
	// flat shape; multi-question dialogs (ask `questions: [...]`) carry the
	// questions array and answer with an ExtensionAskDialogResult-shaped
	// payload via session.askAnswer.
	| {
			kind: "ask-request";
			seq: number;
			payload:
				| {
						requestId: string;
						title: string;
						options: string[] | null;
						multi: boolean;
						mode: "select" | "input";
				  }
				| {
						requestId: string;
						title: string;
						mode: "dialog";
						questions: AskDialogQuestionWire[] | null;
				  };
	  }
	| { kind: "agent-lifecycle"; seq: number; payload: SubagentLifecyclePayload }
	// Daemon forwards the EventBus wrapper (SubagentProgressPayload), not the
	// bare AgentProgress — the AgentProgress lives at `payload.progress`.
	| { kind: "agent-progress"; seq: number; payload: SubagentProgressPayload }
	| { kind: "pause-state"; seq: number; payload: { paused: boolean; pausedAt: number | null } }
	| { kind: "global-pause-state"; seq: number; payload: { paused: boolean; pausedAt: number | null } }
	| { kind: "stream-end"; seq: number; payload: { reason: string } }
	| { kind: "recap"; seq: number; payload: { text: string; at: number } }
	// Session title changed (auto-generated after the first user message, or
	// a replan refresh) — the GUI refreshes its session tree label on this.
	| { kind: "title"; seq: number; payload: { title: string | null } };

export type { SessionStreamEnvelope } from "./events-types";

export const sessionSnapshot = Type.Object({
	header: Type.Unknown(),
	entries: Type.Array(Type.Unknown()),
	state: Type.Unknown(),
	agents: Type.Array(Type.Unknown()),
	/** Opaque cursor = last applied seq; pass to session.resume for catch-up. */
	cursor: Type.Integer({ minimum: 0 }),
	/** Completed-round totals: [final assistant msg ts, duration ms] pairs,
	 *  recorded at agent_end (survive the persisted-snapshot round-trip). */
	roundDurations: Type.Optional(Type.Array(Type.Tuple([Type.Integer(), Type.Integer()]))),
});

export type SessionSnapshot = {
	header: SessionHeader;
	entries: SessionEntry[];
	state: SessionState;
	agents: AgentSnapshot[];
	cursor: number;
	roundDurations?: [number, number][];
};
