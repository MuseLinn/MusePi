/**
 * Session domain — the OMP session tree (id/parentId hierarchy), subscribe
 * stream, send, archive/rename/label.
 *
 * Maps to coding-agent session layer: `SessionManager` /
 * `session/session-entries.ts` (`getTree()` → `SessionTreeNode[]`) and
 * `sdk.ts` `createAgentSession()` for session creation.
 */
import { Type } from "@sinclair/typebox";
import { sessionSnapshot } from "../events";
import type { MethodEntry } from "../index";

const sessionId = Type.String({ minLength: 1, description: "Session entry id" });

/** Create a new session in the daemon (lazy-loads the agent runtime). */
export const sessionCreate = {
	method: "session.create",
	auth: "local",
	params: Type.Object({
		cwd: Type.Optional(Type.String()),
		title: Type.Optional(Type.String()),
	}),
	result: Type.Object({ sessionId: Type.String() }),
	impl: "createAgentSession() (daemon runtime)",
} satisfies MethodEntry;

export const sessionList = {
	method: "session.list",
	auth: "session",
	params: Type.Object({
		scope: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("all")], { default: "active" })),
	}),
	result: Type.Array(
		Type.Object({
			id: sessionId,
			parentId: Type.Union([Type.String(), Type.Null()]),
			title: Type.Optional(Type.String()),
			label: Type.Optional(Type.String()),
			kind: Type.String(),
			timestamp: Type.String(),
			children: Type.Any({ description: "Recursive SessionTreeNode[]" }),
			/** Cross-session metadata (daemon materialized view). */
			model: Type.Optional(Type.String()),
			messageCount: Type.Optional(Type.Integer({ minimum: 0 })),
			cwd: Type.Optional(Type.String()),
		}),
	),
	impl: "SessionManager.getTree() / session/session-entries.ts",
} satisfies MethodEntry;

export const sessionSubscribe = {
	method: "session.subscribe",
	auth: "session",
	params: Type.Object({
		sessionId,
		/** Last seq the client applied; server starts after it (incremental catch-up). */
		lastSeq: Type.Optional(Type.Integer({ minimum: 0 })),
	}),
	result: Type.Object({
		/** Stream handle; server pushes SessionStreamEvent envelopes (kind+seq). */
		stream: Type.String(),
		initial: sessionSnapshot,
	}),
	impl: "createAgentSession() → AgentSessionEvent stream (runtime)",
} satisfies MethodEntry;

/** Cancel a subscription (server stops pushing; stream handle becomes invalid). */
export const sessionCancel = {
	method: "session.cancel",
	auth: "session",
	params: Type.Object({
		stream: Type.String(),
	}),
	result: Type.Object({ ok: Type.Boolean() }),
	impl: "stream teardown (runtime)",
} satisfies MethodEntry;

/**
 * Reconnect with an opaque cursor: server replays a fresh snapshot plus
 * deltas after the cursor (incremental catch-up, mirrors replication-shrink
 * semantics from collab).
 */
export const sessionResume = {
	method: "session.resume",
	auth: "session",
	params: Type.Object({
		sessionId,
		cursor: Type.Optional(Type.Integer({ minimum: 0 })),
	}),
	result: Type.Object({
		stream: Type.String(),
		snapshot: sessionSnapshot,
		/** True when deltas before `cursor` were compacted away; client must
		 *  refresh any local view it derived from the pre-cursor tail. */
		compactedThrough: Type.Optional(Type.Boolean()),
	}),
	impl: "replication-shrink + session replay (runtime)",
} satisfies MethodEntry;

export const sessionSend = {
	method: "session.send",
	auth: "session",
	params: Type.Object({
		sessionId,
		text: Type.String(),
		attachments: Type.Optional(Type.Array(Type.Object({ kind: Type.String(), data: Type.String() }))),
		/** delivery semantics: plain prompt, live steer (no new turn), or follow-up (continues current turn). */
		deliverAs: Type.Optional(
			Type.Union([Type.Literal("prompt"), Type.Literal("steer"), Type.Literal("followUp")], {
				default: "prompt",
			}),
		),
	}),
	result: Type.Object({ accepted: Type.Boolean() }),
	impl: "AgentSession.sendUserMessage(content, {deliverAs}) (runtime)",
} satisfies MethodEntry;

export const sessionFork = {
	method: "session.fork",
	auth: "local",
	params: Type.Object({ sessionId }),
	result: Type.Object({ ok: Type.Boolean(), newSessionId: Type.Optional(Type.String()) }),
	impl: "AgentSession.fork() (runtime)",
} satisfies MethodEntry;

export const sessionBranch = {
	method: "session.branch",
	auth: "local",
	params: Type.Object({
		sessionId,
		entryId: sessionId,
	}),
	result: Type.Object({ ok: Type.Boolean() }),
	impl: "AgentSession.branch(entryId) (runtime)",
} satisfies MethodEntry;

export const sessionAbort = {
	method: "session.abort",
	auth: "local",
	params: Type.Object({ sessionId }),
	result: Type.Object({ ok: Type.Boolean() }),
	impl: "AgentSession.abort() (runtime)",
} satisfies MethodEntry;

export const sessionArchive = {
	method: "session.archive",
	auth: "local",
	params: Type.Object({ sessionId }),
	result: Type.Object({ ok: Type.Boolean() }),
	impl: "SessionManager.archive()",
} satisfies MethodEntry;

export const sessionRename = {
	method: "session.rename",
	auth: "local",
	params: Type.Object({
		sessionId,
		title: Type.String(),
	}),
	result: Type.Object({ ok: Type.Boolean() }),
	impl: "SessionManager.rename()",
} satisfies MethodEntry;

export const sessionLabel = {
	method: "session.label",
	auth: "local",
	params: Type.Object({
		sessionId,
		/** undefined removes the label (tree-selector Shift+L semantics). */
		label: Type.Optional(Type.String()),
	}),
	result: Type.Object({ ok: Type.Boolean() }),
	impl: "session tree label (TreeSelectorComponent)",
} satisfies MethodEntry;

export const sessionTree = {
	method: "session.tree",
	auth: "session",
	params: Type.Object({}),
	result: Type.Any({ description: "SessionTreeNode[] — flat-indent render data (OMP /tree)" }),
	impl: "SessionManager.getTree()",
} satisfies MethodEntry;

/**
 * Close a live session: dispose the running AgentSession (memory + timers).
 * The journal and materialized view are retained — the session becomes
 * history, still listed and resumable as snapshot-only.
 */
export const sessionClose = {
	method: "session.close",
	auth: "session",
	params: Type.Object({ sessionId }),
	result: Type.Object({ ok: Type.Boolean() }),
	impl: "DaemonSessionHost.close() (runtime)",
} satisfies MethodEntry;

/**
 * Cross-session message search over the materialized view (daemon). Returns
 * matching messages grouped by session, newest first.
 */
export const sessionSearch = {
	method: "session.search",
	auth: "session",
	params: Type.Object({
		query: Type.String({ minLength: 1 }),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
	}),
	result: Type.Object({
		matches: Type.Array(
			Type.Object({
				sessionId,
				seq: Type.Integer({ minimum: 0 }),
				role: Type.String(),
				model: Type.Optional(Type.String()),
				content: Type.String(),
				timestamp: Type.Integer(),
			}),
		),
		/** Hit counts grouped by session (newest first). */
		sessions: Type.Array(
			Type.Object({
				sessionId,
				messageCount: Type.Integer({ minimum: 0 }),
			}),
		),
	}),
	impl: "ViewStore.search() (daemon runtime)",
} satisfies MethodEntry;

export const sessionMethods: MethodEntry[] = [
	sessionCreate,
	sessionClose,
	sessionSearch,
	sessionList,
	sessionSubscribe,
	sessionCancel,
	sessionResume,
	sessionSend,
	sessionFork,
	sessionBranch,
	sessionAbort,
	sessionArchive,
	sessionRename,
	sessionLabel,
	sessionTree,
];
