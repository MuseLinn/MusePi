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
	AgentProgress,
	AgentSnapshot,
	SessionEntry,
	SessionHeader,
	SessionState,
	SubagentLifecyclePayload,
} from "@musepi/pi-wire";
import { Type } from "@sinclair/typebox";

/** Runtime-validated envelope (kind + seq); payload is pinned by the type layer. */
export const sessionStreamEnvelope = Type.Object({
	kind: Type.Union([
		Type.Literal("entry"),
		Type.Literal("event"),
		Type.Literal("state"),
		Type.Literal("approval-request"),
		Type.Literal("agent-lifecycle"),
		Type.Literal("agent-progress"),
		Type.Literal("pause-state"),
		Type.Literal("global-pause-state"),
		Type.Literal("stream-end"),
		Type.Literal("recap"),
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
	| { kind: "agent-lifecycle"; seq: number; payload: SubagentLifecyclePayload }
	| { kind: "agent-progress"; seq: number; payload: AgentProgress }
	| { kind: "pause-state"; seq: number; payload: { paused: boolean; pausedAt: number | null } }
	| { kind: "global-pause-state"; seq: number; payload: { paused: boolean; pausedAt: number | null } }
	| { kind: "stream-end"; seq: number; payload: { reason: string } }
	| { kind: "recap"; seq: number; payload: { text: string; at: number } };

export type { SessionStreamEnvelope } from "./events-types";

export const sessionSnapshot = Type.Object({
	header: Type.Unknown(),
	entries: Type.Array(Type.Unknown()),
	state: Type.Unknown(),
	agents: Type.Array(Type.Unknown()),
	/** Opaque cursor = last applied seq; pass to session.resume for catch-up. */
	cursor: Type.Integer({ minimum: 0 }),
});

export type SessionSnapshot = {
	header: SessionHeader;
	entries: SessionEntry[];
	state: SessionState;
	agents: AgentSnapshot[];
	cursor: number;
};
