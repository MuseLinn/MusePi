/**
 * Collab live-session wire protocol.
 *
 * Hub topology: the host is authoritative, guests never peer. All session
 * payloads (`CollabFrame`) travel AES-256-GCM sealed; the relay only sees the
 * plaintext envelope (`[4B uint32 BE peerId][sealed payload]`) plus TEXT JSON
 * control messages that carry no session data.
 */

import type { ImageContent, Model } from "@musepi/pi-ai";
import type {
	BusChannel,
	CollabUiRequest,
	GuestFrame,
	Participant,
	SessionState,
	AgentSnapshot as WireAgentSnapshot,
} from "@musepi/pi-wire";
import { DEFAULT_RELAY_URL, ENVELOPE_HEADER_LENGTH, ROOM_ID_BYTES } from "@musepi/pi-wire";
import type { ContextUsage } from "../extensibility/extensions/types";
import type { AgentSessionEvent } from "../session/agent-session";
import type { SessionEntry, SessionHeader } from "../session/session-entries";

export type {
	BoardData,
	BoardWidget,
	CollabPromptDetails,
	CollabUiRequest,
	CollabUiRequestDraft,
	CollabUiResponseValue,
	CollabUiSelectItem,
	CronRun,
	CronSchedule,
	CronStatus,
	CronTask,
	ParsedCollabLink,
	RelayControlMessage,
	RelayControlToGuest,
	RelayControlToHost,
	WorkspaceEntry,
} from "@musepi/pi-wire";
export { COLLAB_PROMPT_MESSAGE_TYPE, COLLAB_PROTO } from "@musepi/pi-wire";
export { DEFAULT_RELAY_URL, ENVELOPE_HEADER_LENGTH, ROOM_ID_BYTES };

export type CollabParticipant = Participant;
export type AgentSnapshot = WireAgentSnapshot;

/** Debounced footer snapshot broadcast by the host. */
export type CollabSessionState = SessionState & {
	/**
	 * Host model (full catalog object). Guests apply it to their replica
	 * agent state so model display and context-window math are native.
	 */
	model?: Model;
	/** Host status-line context numbers (guest system prompt/tools differ, so local estimates drift). */
	contextUsage?: ContextUsage;
};

/**
 * Compact session card for the multi-session workspace view (desktop / web
 * render). Deliberately excludes transcripts — the guest focuses a session
 * to stream its detail, keeping the directory cheap to sync.
 */
export interface WorkspaceSessionInfo {
	id: string;
	/** First user message, truncated; null when the session never sent. */
	title: string | null;
	cwd: string | null;
	messageCount: number;
	/** A live agent is currently streaming/running in this session. */
	working: boolean;
	paused: boolean;
	/** True when the host can stream this session live (active agent session). */
	live: boolean;
	/** Read-only guests may not focus+prompt sessions they don't own. */
	readOnly?: boolean;
	updatedAt: number;
};

/**
 * Encrypted payload frames (inside AES-GCM, JSON). The wire package pins the
 * JSON skeleton (`WireFrame`); host-side frames carry the rich session types
 * that serialize into those shapes.
 */
export type CollabFrame =
	// guest -> host (hello/abort/agent-cmd/fetch-transcript/rpc-request/ui-response are taken verbatim from the wire grammar)
	| Exclude<GuestFrame, { t: "prompt" }>
	| { t: "prompt"; text: string; images?: ImageContent[] }
	// host -> guest
	| {
			t: "welcome";
			proto: number;
			header: SessionHeader;
			state: CollabSessionState;
			agents: AgentSnapshot[];
			/**
			 * Total number of `SessionEntry` items the host will deliver in the
			 * `snapshot-chunk` frames that follow. The guest stays in the
			 * snapshot-loading phase until it has accumulated that many entries
			 * (or a chunk arrives with `final: true`).
			 */
			entryCount: number;
			/** True when this peer joined through a read-only (view) link. */
			readOnly?: boolean;
	  }
	/**
	 * Targeted snapshot fragment delivered after `welcome`. Splits a large
	 * transcript across many small frames so the guest's per-chunk progress
	 * timeout resets each time the relay delivers another batch; without
	 * chunking, a multi-MB session has to fit one giant frame inside the
	 * 30 s first-welcome budget. The last chunk carries `final: true` so the
	 * guest can finalize the replica session.
	 */
	| { t: "snapshot-chunk"; entries: SessionEntry[]; final: boolean }
	| { t: "entry"; entry: SessionEntry }
	| { t: "event"; event: AgentSessionEvent }
	| { t: "state"; state: CollabSessionState }
	/** Mirrored EventBus traffic (task subagent lifecycle/progress channels only). */
	| { t: "bus"; channel: BusChannel; data: unknown }
	/** Full agent-registry snapshot (debounced on registry change). */
	| { t: "agents"; agents: AgentSnapshot[] }
	| { t: "ui-request"; request: CollabUiRequest }
	| { t: "ui-request-end"; reqId: number }
	/** Targeted reply to fetch-transcript; `error` marks a terminal read failure that guests must surface without hot retrying. */
	| { t: "transcript"; reqId: number; text: string; newSize: number; error?: string }
	/** Targeted reply to rpc-request; `ok:false` carries the failure reason. */
	| { t: "rpc-result"; reqId: number; ok: boolean; data?: unknown; error?: string }
	/** Multi-session workspace: full directory (host → guest, after hello). */
	| { t: "workspace"; sessions: WorkspaceSessionInfo[] }
	/** One card changed (working flipped, message count grew, …). */
	| { t: "workspace-session"; session: WorkspaceSessionInfo }
	/** Guest picks a session to stream live; `sessionId: null` returns to the directory. */
	| { t: "workspace-select"; sessionId: string | null }
	| { t: "bye"; reason: string }
	| { t: "error"; message: string };

// ═══════════════════════════════════════════════════════════════════════════
// Wire envelope: [4B uint32 BE peerId][sealed payload]
// Host→relay: peerId 0 broadcasts to all guests; peerId N targets guest N.
// Guest→relay: always 0; the relay rewrites it to the sender's id.
// ═══════════════════════════════════════════════════════════════════════════

// Transport primitives moved to @musepi/collab-proto (pure wire layer, shared
// with collab-web). Re-exported here so existing import sites keep working.
export {
	formatCollabLink,
	formatCollabWebLink,
	generateRoomId,
	generateRoomKey,
	generateWriteToken,
	importRoomKey,
	open,
	packEnvelope,
	parseCollabLink,
	rewriteEnvelopePeer,
	seal,
	unpackEnvelope,
} from "@musepi/collab-proto";
