/**
 * Host side of a collab live session.
 *
 * Taps the host session's event stream and SessionManager append chokepoint,
 * broadcasting entries/events/state to guests through the relay. Guests prompt
 * and abort through us; the host machine runs the agent and tools. The host's
 * subagent ecosystem is mirrored too: task EventBus traffic (observer HUD),
 * agent-registry snapshots (Agent Hub table), hub chat/kill/revive commands,
 * and incremental subagent-transcript reads.
 */

import { timingSafeEqual } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ImageContent, TextContent } from "@musepi/pi-ai";
import { logger } from "@musepi/pi-utils";
import type {
	BusChannel,
	CollabUiRequest,
	CollabUiRequestDraft,
	CollabUiResponseValue,
	SessionEntry as WireSessionEntry,
} from "@musepi/pi-wire";
import { type BoardRecord, readBoards, validateBoards, writeBoards } from "../daemon/boards.js";
import {
	computeNextRun,
	loadCronRuns,
	loadCronTasks,
	mergeCronTask,
	saveCronTasks,
	validateCronTask,
} from "../daemon/crons.js";
import {
	createWorkspaceDir,
	deleteWorkspaceEntry,
	renameWorkspaceEntry,
	resolveInCwd,
	writeWorkspaceFile,
} from "../daemon/fs-ops.js";
import { t } from "../i18n/index.js";
import type { InteractiveModeContext } from "../modes/types";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry } from "../registry/agent-registry";
import type { AgentSessionEvent } from "../session/agent-session";
import { stripImagesFromMessage, USER_INTERRUPT_LABEL } from "../session/messages";
import type { SessionEntry as StoredSessionEntry } from "../session/session-entries";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "../task/types";
import { WIDGET_TYPES } from "../tools/widget.js";
import { generateRoomKey, generateWriteToken, importRoomKey } from "./crypto";
import { collabDisplayName } from "./display-name";
import {
	type AgentSnapshot,
	COLLAB_PROMPT_MESSAGE_TYPE,
	COLLAB_PROTO,
	type CollabFrame,
	type CollabParticipant,
	type CollabPromptDetails,
	type CollabSessionState,
	type CronTask,
	formatCollabLink,
	formatCollabWebLink,
	generateRoomId,
	parseCollabLink,
	type WorkspaceEntry,
	type WorkspaceSessionInfo,
} from "./protocol";
import { CollabSocket } from "./relay-client";
import { shrinkForReplication } from "./replication-shrink";
import { isWireAgentEvent, isWireSessionEntry } from "./wire-guard";

/** Events that change the footer state guests render. */
const STATE_TRIGGER_EVENTS: Record<string, true> = {
	agent_start: true,
	agent_end: true,
	message_end: true,
	tool_execution_end: true,
	thinking_level_changed: true,
	model_changed: true,
	auto_compaction_end: true,
};

const STATE_DEBOUNCE_MS = 100;
const AGENTS_DEBOUNCE_MS = 100;
const STREAMING_STATE_INTERVAL_MS = 2000;
const WELCOME_IMAGE_STRIP_THRESHOLD = 24 * 1024 * 1024;
const COLLAB_BUS_CHANNELS = [
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
] as const satisfies readonly BusChannel[];

const CONNECT_TIMEOUT_MS = 15_000;
/** Max bytes served per fetch-transcript reply (guest re-requests from `newSize`). */
export const TRANSCRIPT_READ_CAP = 4 * 1024 * 1024;
const TRANSCRIPT_ENTRY_TOO_LARGE_ERROR = `transcript entry exceeds transcript fetch cap (${TRANSCRIPT_READ_CAP} bytes)`;
/**
 * Soft byte cap per `snapshot-chunk` frame. The first MB of a snapshot takes
 * ~3s through the default relay, so a 512 KB chunk lands well under the
 * guest's 30 s per-chunk progress timeout; oversized single entries still
 * ship in a chunk of their own.
 */
const SNAPSHOT_CHUNK_BYTES = 512 * 1024;
/**
 * Outcome of {@link CollabHost.requestGuestUi}. `answered` carries the guest's
 * response (an `undefined` value is a genuine guest cancel); `unavailable`
 * means the collab channel went away (teardown, relay drop) or the request was
 * aborted before any guest answered — callers MUST NOT treat it as a cancel.
 */
export type CollabGuestUiResult = { kind: "answered"; value: CollabUiResponseValue } | { kind: "unavailable" };

/** Extension → MIME for fs.read (fallback application/octet-stream). */
const FILE_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	avif: "image/avif",
	pdf: "application/pdf",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	mp4: "video/mp4",
	webm: "video/webm",
};

function mimeForPath(filePath: string): string {
	const dot = filePath.lastIndexOf(".");
	if (dot === -1) return "application/octet-stream";
	const ext = filePath.slice(dot + 1).toLowerCase();
	return FILE_MIME[ext] ?? "application/octet-stream";
}

/**
 * Multi-session workspace support the host may opt into (`/collab
 * workspace`, desktop share mode). The provider owns the session directory
 * and can re-point the host's live session taps at another session.
 */
export interface CollabWorkspaceContext {
	/** Compact cards for every known session (live + history). */
	listWorkspaceSessions(): Promise<WorkspaceSessionInfo[]>;
	/** Directory-change notifications (working flips, counts, sessions added). */
	subscribeWorkspace(cb: () => void): () => void;
	/**
	 * Point the host's session taps at another live session. Returns false
	 * when the session can't go live (no transcript, unsupported host).
	 */
	switchWorkspaceSession(sessionId: string): Promise<boolean>;
	/** Create a fresh session in the workspace. Resolves the new session id. */
	createWorkspaceSession?(): Promise<string>;
	/** Delete a session by id (journal + index). */
	deleteWorkspaceSession?(sessionId: string): Promise<void>;
	/** Rename a session (journal label, user-set). */
	renameWorkspaceSession?(sessionId: string, title: string): Promise<void>;
	/** Stop the running agent turn in a session. */
	abortWorkspaceSession?(sessionId: string): Promise<void>;
}

export type CollabHostMode = "session" | "workspace";

export class CollabHost {
	#ctx: InteractiveModeContext;
	#mode: CollabHostMode;
	#socket: CollabSocket | null = null;
	#link = "";
	#webLink = "";
	#viewLink = "";
	#webViewLink = "";
	#writeToken: Uint8Array | null = null;
	#sessionId = "";
	#unsubscribe?: () => void;
	#workspaceUnsubscribe?: () => void;
	#peers = new Map<number, { name: string; canWrite: boolean }>();
	#uiReqSeq = 0;
	#pendingUi = new Map<number, { request: CollabUiRequest; settle(result: CollabGuestUiResult): void }>();
	#lastStateJson = "";
	#stateDebounce: Timer | null = null;
	#streamingInterval: Timer | null = null;
	#agentsDebounce: Timer | null = null;
	#busUnsubscribers: (() => void)[] = [];
	#registryUnsubscribe?: () => void;
	#stopped = false;

	constructor(ctx: InteractiveModeContext, mode: CollabHostMode = "session") {
		this.#ctx = ctx;
		this.#mode = mode;
	}

	get link(): string {
		return this.#link;
	}

	/** Browser deep link for the configured collab web UI. */
	get webLink(): string {
		return this.#webLink;
	}

	/** Read-only variant of {@link link}: bare room key, no write token. */
	get viewLink(): string {
		return this.#viewLink;
	}

	/** Read-only variant of {@link webLink}. */
	get webViewLink(): string {
		return this.#webViewLink;
	}

	get participants(): CollabParticipant[] {
		const list: CollabParticipant[] = [{ name: collabDisplayName(this.#ctx), role: "host" }];
		for (const peer of this.#peers.values()) {
			list.push({ name: peer.name, role: "guest", readOnly: peer.canWrite ? undefined : true });
		}
		return list;
	}

	requestGuestUi(request: CollabUiRequestDraft, signal?: AbortSignal): Promise<CollabGuestUiResult> | null {
		if (!this.#socket || !this.#hasWritablePeers()) return null;
		const reqId = ++this.#uiReqSeq;
		const fullRequest: CollabUiRequest = { ...request, reqId };
		const { promise, resolve } = Promise.withResolvers<CollabGuestUiResult>();
		let settled = false;
		const settle = (result: CollabGuestUiResult): void => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			this.#pendingUi.delete(reqId);
			this.#sendWritablePeers({ t: "ui-request-end", reqId });
			resolve(result);
		};
		const onAbort = (): void => settle({ kind: "unavailable" });
		if (signal?.aborted) return Promise.resolve({ kind: "unavailable" });
		signal?.addEventListener("abort", onAbort, { once: true });
		this.#pendingUi.set(reqId, { request: fullRequest, settle });
		this.#sendWritablePeers({ t: "ui-request", request: fullRequest });
		return promise;
	}

	#hasWritablePeers(): boolean {
		for (const peer of this.#peers.values()) {
			if (peer.canWrite) return true;
		}
		return false;
	}

	#sendWritablePeers(frame: CollabFrame): void {
		const socket = this.#socket;
		if (!socket) return;
		for (const [peerId, peer] of this.#peers) {
			if (peer.canWrite) socket.send(frame, peerId);
		}
	}

	async start(relayUrl: string, webUrl = "", webJoinUrl = ""): Promise<void> {
		const rawKey = generateRoomKey();
		const writeToken = generateWriteToken();
		const roomId = generateRoomId();
		this.#writeToken = writeToken;
		// The browser deep link needs a wss join URL that is same-origin with
		// the https web base (plaintext ws on an https page is mixed content).
		const joinForWeb = webJoinUrl || relayUrl;
		this.#link = formatCollabLink(relayUrl, roomId, rawKey, writeToken);
		this.#webLink = formatCollabWebLink(joinForWeb, roomId, rawKey, writeToken, webUrl);
		this.#viewLink = formatCollabLink(relayUrl, roomId, rawKey);
		this.#webViewLink = formatCollabWebLink(joinForWeb, roomId, rawKey, undefined, webUrl);
		const parsed = parseCollabLink(this.#link);
		if ("error" in parsed) throw new Error(parsed.error);
		const key = await importRoomKey(rawKey);

		const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "host", key });
		this.#socket = socket;
		this.#sessionId = this.#ctx.sessionManager.getSessionId();

		const firstOpen = Promise.withResolvers<void>();
		let opened = false;
		socket.onOpen = () => {
			if (!opened) {
				opened = true;
				firstOpen.resolve();
			}
		};
		socket.onFrame = (frame, fromPeer) => this.#handleFrame(frame, fromPeer);
		socket.onControl = msg => {
			if (msg.t === "peer-left") this.#handlePeerLeft(msg.peer);
			else if (msg.t === "peer-joined") this.#handlePeerJoined(msg.peer, !!msg.plaintext);
		};
		socket.onClose = (reason, willReconnect) => {
			if (this.#stopped) return;
			if (!opened) {
				firstOpen.reject(new Error(reason));
				return;
			}
			if (willReconnect) {
				this.#ctx.showStatus(t("Collab relay connection lost ({0}), reconnecting…", reason), { dim: true });
			} else {
				void this.#teardown();
				this.#ctx.session.emitNotice("warning", `Collab ended: ${reason}`, "collab");
			}
		};
		socket.connect();

		const timeout = setTimeout(
			() => firstOpen.reject(new Error("timed out connecting to relay")),
			CONNECT_TIMEOUT_MS,
		);
		try {
			await firstOpen.promise;
		} catch (err) {
			this.#stopped = true;
			socket.close();
			this.#socket = null;
			throw err;
		} finally {
			clearTimeout(timeout);
		}

		this.#unsubscribe = this.#ctx.session.subscribe(event => {
			if (isWireAgentEvent(event)) this.#broadcast({ t: "event", event: shrinkForReplication(event) });
			this.#onEventForState(event);
		});
		const bus = this.#ctx.eventBus;
		if (bus) {
			for (const channel of COLLAB_BUS_CHANNELS) {
				this.#busUnsubscribers.push(bus.on(channel, data => this.#broadcast({ t: "bus", channel, data })));
			}
		}
		this.#registryUnsubscribe = AgentRegistry.global().onChange(() => this.#scheduleAgentsBroadcast());
		this.#ctx.sessionManager.onEntryAppended = entry => {
			if (isWireSessionEntry(entry)) this.#broadcast({ t: "entry", entry: shrinkForReplication(entry) });
			// Model/thinking/title changes land as entries while idle; refresh
			// guest state promptly (debounce + JSON diff dedupe).
			this.#scheduleStateBroadcast();
		};
		if (this.#mode === "workspace") {
			const provider = this.#ctx.workspace;
			if (provider) {
				this.#workspaceUnsubscribe = provider.subscribeWorkspace(() => void this.#broadcastWorkspace());
			}
		}
		this.#updateStatusSegment();
	}

	/** Broadcast a goodbye, detach all taps, and close the socket. */
	async stop(reason: string): Promise<void> {
		if (this.#stopped) return;
		this.#socket?.send({ t: "bye", reason });
		await this.#teardown();
	}

	async #teardown(): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#ctx.sessionManager.onEntryAppended = undefined;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#workspaceUnsubscribe?.();
		this.#workspaceUnsubscribe = undefined;
		for (const unsubscribe of this.#busUnsubscribers) unsubscribe();
		this.#busUnsubscribers = [];
		this.#registryUnsubscribe?.();
		this.#registryUnsubscribe = undefined;
		clearTimeout(this.#stateDebounce ?? undefined);
		this.#stateDebounce = null;
		clearTimeout(this.#agentsDebounce ?? undefined);
		this.#agentsDebounce = null;
		clearInterval(this.#streamingInterval ?? undefined);
		this.#streamingInterval = null;
		for (const pending of this.#pendingUi.values()) pending.settle({ kind: "unavailable" });
		this.#pendingUi.clear();
		this.#peers.clear();
		this.#socket?.close();
		this.#socket = null;
		this.#ctx.collabHost = undefined;
		this.#ctx.statusLine.setCollabStatus(null);
		this.#ctx.ui.requestRender();
	}

	#broadcast(frame: CollabFrame): void {
		if (this.#stopped || !this.#socket) return;
		if (this.#ctx.sessionManager.getSessionId() !== this.#sessionId) {
			void this.stop("session switched");
			this.#ctx.session.emitNotice("warning", "Collab ended: session switched", "collab");
			return;
		}
		// Directed per-peer fan-out: sealed and plaintext guests need different
		// encodings, and the relay can only broadcast one byte stream.
		for (const peerId of this.#peers.keys()) this.#socket.send(frame, peerId);
	}

	#handleFrame(frame: CollabFrame, fromPeer: number): void {
		switch (frame.t) {
			case "hello":
				this.#handleHello(frame.name, frame.proto, frame.writeToken, fromPeer);
				break;
			case "prompt":
				this.#handlePrompt(frame.text, frame.images, fromPeer);
				break;
			case "abort":
				this.#handleAbort(fromPeer);
				break;
			case "agent-cmd":
				this.#handleAgentCmd(frame.cmd, frame.agentId, frame.text, fromPeer);
				break;
			case "ui-response":
				this.#handleUiResponse(frame.reqId, frame.value, fromPeer);
				break;
			case "fetch-transcript":
				void this.#handleFetchTranscript(frame.reqId, frame.agentId, frame.fromByte, fromPeer);
				break;
			case "rpc-request":
				void this.#handleRpcRequest(frame, fromPeer);
				break;
			case "workspace-select":
				void this.#handleWorkspaceSelect(frame.sessionId, fromPeer);
				break;
			default:
				logger.debug("collab host ignoring unexpected frame", { type: frame.t, fromPeer });
		}
	}

	/** Record a guest's plaintext mode before its first frame arrives (the relay
	 *  sends peer-joined ahead of any guest traffic). Guests are only admitted
	 *  to {@link #peers} once they say hello. */
	#handlePeerJoined(peerId: number, plaintext: boolean): void {
		this.#socket?.setPeerMode(peerId, plaintext);
	}

	/** Timing-safe write-token check; peers without a valid token are read-only. */
	#verifyWriteToken(token: string | undefined): boolean {
		const expected = this.#writeToken;
		if (!expected || !token) return false;
		const bytes = Buffer.from(token, "base64url");
		return bytes.byteLength === expected.byteLength && timingSafeEqual(bytes, expected);
	}

	/** Reject a mutating frame from a read-only peer with a targeted error. */
	#rejectReadOnly(action: string, fromPeer: number): void {
		this.#socket?.send({ t: "error", message: `${action} is disabled on a read-only link` }, fromPeer);
	}

	#handleHello(name: string, proto: number, writeToken: string | undefined, fromPeer: number): void {
		if (proto !== COLLAB_PROTO) {
			this.#socket?.send(
				{ t: "error", message: `protocol mismatch: host speaks v${COLLAB_PROTO}, guest sent v${proto}` },
				fromPeer,
			);
			return;
		}
		const cleanName = name.trim().slice(0, 64) || `guest-${fromPeer}`;
		const canWrite = this.#verifyWriteToken(writeToken);
		this.#peers.set(fromPeer, { name: cleanName, canWrite });

		// Workspace mode: the guest lands on the session directory instead of
		// a live transcript; it picks a session with `workspace-select`.
		if (this.#mode === "workspace") {
			void this.#broadcastWorkspace();
			this.#ctx.session.emitNotice(
				"info",
				`${cleanName} joined the workspace${canWrite ? "" : " (read-only)"}`,
				"collab",
			);
			this.#updateStatusSegment();
			return;
		}

		this.#sendWelcome(fromPeer, canWrite);
		this.#ctx.session.emitNotice(
			"info",
			`${cleanName} joined the collab session${canWrite ? "" : " (read-only)"}`,
			"collab",
		);
		this.#updateStatusSegment();
		this.#scheduleStateBroadcast();
	}

	/**
	 * Send a guest the current focus session's welcome + snapshot chunks.
	 * Snapshot and send synchronously: no awaits between snapshot, welcome,
	 * and chunk sends, so subsequent broadcast frames (entry/event/state/bus)
	 * queue behind the snapshot on the same socket and the guest can't
	 * observe a gap between the snapshot fragment and live traffic.
	 */
	#sendWelcome(fromPeer: number, canWrite: boolean): void {
		const snapshot = this.#ctx.sessionManager.snapshotForReplication();
		if (JSON.stringify(snapshot).length > WELCOME_IMAGE_STRIP_THRESHOLD) {
			let stripped = 0;
			for (const entry of snapshot.entries) {
				if (entry.type === "message") stripped += stripImagesFromMessage(entry.message);
			}
			logger.info("collab welcome exceeded size threshold; stripped images", { stripped });
		}
		const entries = snapshot.entries.filter(isWireSessionEntry);
		const socket = this.#socket;
		if (!socket) return;
		socket.send(
			{
				t: "welcome",
				proto: COLLAB_PROTO,
				header: snapshot.header,
				state: this.#buildState(),
				agents: this.#snapshotAgents(),
				entryCount: entries.length,
				readOnly: canWrite ? undefined : true,
			},
			fromPeer,
		);
		this.#sendSnapshotChunks(entries, fromPeer);
		if (canWrite) {
			for (const pending of this.#pendingUi.values()) {
				socket.send({ t: "ui-request", request: pending.request }, fromPeer);
			}
		}
	}

	/**
	 * Workspace directory: refresh from the provider and broadcast. Called on
	 * hello and on provider change notifications.
	 */
	async #broadcastWorkspace(): Promise<void> {
		if (this.#stopped || !this.#socket) return;
		const provider = this.#ctx.workspace;
		if (!provider) return;
		try {
			const sessions = await provider.listWorkspaceSessions();
			if (!this.#stopped) this.#broadcast({ t: "workspace", sessions });
		} catch (err) {
			logger.warn("collab workspace list failed", { error: String(err) });
		}
	}

	/**
	 * Guest picks a session to stream live (or null to return to the
	 * directory). The focus is global — every guest watches the same session.
	 */
	async #handleWorkspaceSelect(sessionId: string | null, fromPeer: number): Promise<void> {
		const provider = this.#ctx.workspace;
		if (!provider) return;
		if (sessionId === null) {
			// Return to the directory: detach the live taps.
			if (this.#unsubscribe) {
				this.#unsubscribe();
				this.#unsubscribe = undefined;
			}
			this.#ctx.sessionManager.onEntryAppended = undefined;
			this.#ctx.session.emitNotice("info", "Collab focus returned to the workspace directory", "collab");
			this.#updateStatusSegment();
			return;
		}
		let ok = false;
		let failReason: string | undefined;
		try {
			ok = await this.#switchFocus(sessionId);
		} catch (err) {
			// Providers may throw a user-facing reason (e.g. an empty session
			// has no transcript to stream) — surface it to the guest.
			failReason = err instanceof Error ? err.message : String(err);
		}
		if (!ok) {
			this.#socket?.send({ t: "error", message: failReason ?? `Cannot stream session ${sessionId} live` }, fromPeer);
			return;
		}
		this.#ctx.session.emitNotice("info", `Collab focus switched to session ${sessionId}`, "collab");
		// Re-welcome every guest onto the focused session's transcript.
		for (const [peerId, peer] of this.#peers) {
			this.#sendWelcome(peerId, peer.canWrite);
		}
		this.#updateStatusSegment();
	}

	/** Re-point the session taps at another live session (provider-owned). */
	async #switchFocus(sessionId: string): Promise<boolean> {
		const provider = this.#ctx.workspace;
		if (!provider) return false;
		const ok = await provider.switchWorkspaceSession(sessionId);
		if (!ok) return false;
		if (this.#unsubscribe) {
			this.#unsubscribe();
			this.#unsubscribe = undefined;
		}
		this.#ctx.sessionManager.onEntryAppended = undefined;
		this.#sessionId = this.#ctx.sessionManager.getSessionId();
		this.#unsubscribe = this.#ctx.session.subscribe(event => {
			if (isWireAgentEvent(event)) this.#broadcast({ t: "event", event: shrinkForReplication(event) });
			this.#onEventForState(event);
		});
		this.#ctx.sessionManager.onEntryAppended = entry => {
			if (isWireSessionEntry(entry)) this.#broadcast({ t: "entry", entry: shrinkForReplication(entry) });
			this.#scheduleStateBroadcast();
		};
		this.#scheduleStateBroadcast();
		this.#scheduleAgentsBroadcast();
		return true;
	}

	/**
	 * Slice {@link entries} into byte-bounded `snapshot-chunk` frames targeted
	 * at {@link fromPeer}. Each entry is first run through
	 * {@link shrinkForReplication} so a single oversized tool-result entry
	 * cannot ship as an oversized chunk that trips the relay's per-frame
	 * `maxPayloadLength` (issue #3739). Every batch carries at least one
	 * entry, and the last batch is tagged `final: true` so the guest can
	 * finalize the replica. An empty snapshot still emits one `final` chunk
	 * so the guest never blocks on a missing terminator.
	 */
	#sendSnapshotChunks(entries: (StoredSessionEntry & WireSessionEntry)[], fromPeer: number): void {
		const socket = this.#socket;
		if (!socket) return;
		if (entries.length === 0) {
			socket.send({ t: "snapshot-chunk", entries: [], final: true }, fromPeer);
			return;
		}
		let i = 0;
		while (i < entries.length) {
			const batch: (StoredSessionEntry & WireSessionEntry)[] = [];
			let batchBytes = 0;
			while (i < entries.length) {
				const entry = entries[i];
				if (!entry) break;
				const shrunk = shrinkForReplication(entry);
				const entryBytes = JSON.stringify(shrunk).length;
				if (batch.length > 0 && batchBytes + entryBytes > SNAPSHOT_CHUNK_BYTES) break;
				batch.push(shrunk);
				batchBytes += entryBytes;
				i++;
			}
			socket.send({ t: "snapshot-chunk", entries: batch, final: i >= entries.length }, fromPeer);
		}
	}

	#handleUiResponse(reqId: number, value: CollabUiResponseValue, fromPeer: number): void {
		const peer = this.#peers.get(fromPeer);
		if (!peer?.canWrite) {
			this.#rejectReadOnly("responding to ask", fromPeer);
			return;
		}
		this.#pendingUi.get(reqId)?.settle({ kind: "answered", value });
	}

	#handlePrompt(text: string, images: ImageContent[] | undefined, fromPeer: number): void {
		const peer = this.#peers.get(fromPeer);
		if (!peer?.canWrite) {
			this.#rejectReadOnly("prompting", fromPeer);
			return;
		}
		const name = peer.name;
		const content: string | (TextContent | ImageContent)[] =
			images && images.length > 0 ? [{ type: "text", text }, ...images] : text;
		const details: CollabPromptDetails = { from: name };
		if (this.#ctx.session.isStreaming) {
			this.#ctx.updatePendingMessagesDisplay();
			this.#ctx.ui.requestRender();
			this.#scheduleStateBroadcast();
		}
		this.#ctx.session
			.promptCustomMessage(
				{
					customType: COLLAB_PROMPT_MESSAGE_TYPE,
					content,
					display: true,
					details,
					attribution: "user",
				},
				{ streamingBehavior: "steer", queueChipText: text },
			)
			.catch(err => {
				logger.warn("collab guest prompt failed", { error: String(err) });
				this.#socket?.send({ t: "error", message: `prompt failed: ${String(err)}` }, fromPeer);
			});
	}

	#handleAbort(fromPeer: number): void {
		const peer = this.#peers.get(fromPeer);
		if (!peer?.canWrite) {
			this.#rejectReadOnly("interrupting", fromPeer);
			return;
		}
		const name = peer.name;
		void this.#ctx.session
			.abort({ reason: USER_INTERRUPT_LABEL })
			.then(() => this.#ctx.session.emitNotice("info", `${name} interrupted`, "collab"))
			.catch(err => logger.warn("collab guest abort failed", { error: String(err) }));
	}

	#handlePeerLeft(peer: number): void {
		const name = this.#peers.get(peer)?.name;
		this.#peers.delete(peer);
		if (name) this.#ctx.session.emitNotice("info", `${name} left the collab session`, "collab");
		this.#updateStatusSegment();
		this.#scheduleStateBroadcast();
	}

	#buildState(): CollabSessionState {
		const session = this.#ctx.session;
		// Context numbers come from the status line's memoized breakdown so guests
		// render exactly the same anchored, provider-real count the host's own
		// status line shows.
		const breakdown = this.#ctx.statusLine.getCachedContextBreakdown();
		const tokens = breakdown.usedTokens ?? 0;
		return {
			isStreaming: session.isStreaming,
			isAborting: session.isAborting,
			queuedMessageCount: session.queuedMessageCount,
			sessionName: session.sessionName,
			cwd: this.#ctx.sessionManager.getCwd(),
			model: session.model,
			thinkingLevel: session.thinkingLevel,
			contextUsage: {
				tokens,
				contextWindow: breakdown.contextWindow,
				percent: breakdown.contextWindow > 0 ? (tokens / breakdown.contextWindow) * 100 : 0,
			},
			participants: this.participants,
		};
	}

	#onEventForState(event: AgentSessionEvent): void {
		if (!STATE_TRIGGER_EVENTS[event.type]) return;
		this.#scheduleStateBroadcast();
		if (event.type === "agent_start" && !this.#streamingInterval) {
			this.#streamingInterval = setInterval(() => this.#scheduleStateBroadcast(), STREAMING_STATE_INTERVAL_MS);
		} else if (event.type === "agent_end" && this.#streamingInterval) {
			clearInterval(this.#streamingInterval);
			this.#streamingInterval = null;
		}
	}

	#snapshotAgents(): AgentSnapshot[] {
		return (
			AgentRegistry.global()
				.list()
				// Advisor transcripts are local observability only; never mirror them to
				// guests (the wire AgentSnapshot kind has no `advisor`, and guests must not
				// be able to chat/kill/revive them).
				.filter((ref): ref is AgentRef & { kind: "main" | "sub" } => ref.kind !== "advisor")
				.map(ref => ({
					id: ref.id,
					displayName: ref.displayName,
					kind: ref.kind,
					parentId: ref.parentId,
					status: ref.status,
					hasSessionFile: !!ref.sessionFile,
					createdAt: ref.createdAt,
					lastActivity: ref.lastActivity,
				}))
		);
	}

	#scheduleAgentsBroadcast(): void {
		if (this.#stopped || this.#agentsDebounce) return;
		this.#agentsDebounce = setTimeout(() => {
			this.#agentsDebounce = null;
			this.#broadcast({ t: "agents", agents: this.#snapshotAgents() });
		}, AGENTS_DEBOUNCE_MS);
	}

	#handleAgentCmd(cmd: "chat" | "kill" | "revive", agentId: string, text: string | undefined, fromPeer: number): void {
		if (!this.#peers.get(fromPeer)?.canWrite) {
			this.#rejectReadOnly("agent control", fromPeer);
			return;
		}
		// Advisor refs are excluded from snapshots, but reject control by id defensively:
		// a stale/malicious client must never chat/kill/revive a read-only advisor transcript.
		if (AgentRegistry.global().get(agentId)?.kind === "advisor") {
			this.#socket?.send({ t: "error", message: `agent ${agentId}: advisor transcripts are read-only` }, fromPeer);
			return;
		}
		const fail = (err: unknown) => {
			logger.warn("collab agent-cmd failed", { cmd, agentId, error: String(err) });
			this.#socket?.send({ t: "error", message: `agent ${agentId}: ${String(err)}` }, fromPeer);
		};
		switch (cmd) {
			case "chat": {
				const trimmed = text?.trim();
				if (!trimmed) {
					this.#socket?.send({ t: "error", message: `agent ${agentId}: empty chat message` }, fromPeer);
					return;
				}
				// Mirrors the hub's #submitChatMessage: revive if parked, steer if mid-turn.
				AgentLifecycleManager.global()
					.ensureLive(agentId)
					.then(session => session.prompt(trimmed, { streamingBehavior: "steer" }))
					.catch(fail);
				break;
			}
			case "kill": {
				const kill = async () => {
					const ref = AgentRegistry.global().get(agentId);
					if (!ref) return;
					if (ref.status === "running" && ref.session) {
						await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
					}
					await AgentLifecycleManager.global().release(agentId, ref, { tombstone: true });
				};
				kill().catch(fail);
				break;
			}
			case "revive":
				AgentLifecycleManager.global().ensureLive(agentId).catch(fail);
				break;
		}
	}

	/** Incremental transcript read mirroring the hub's readFileIncremental contract. */
	async #handleFetchTranscript(reqId: number, agentId: string, fromByte: number, fromPeer: number): Promise<void> {
		const reply = (text: string, newSize: number, error?: string) =>
			this.#socket?.send({ t: "transcript", reqId, text, newSize, error }, fromPeer);
		const file = AgentRegistry.global().get(agentId)?.sessionFile;
		if (!file) {
			reply("", fromByte, "no transcript available");
			return;
		}
		try {
			const stat = await fs.stat(file);
			if (stat.size <= fromByte) {
				reply("", stat.size);
				return;
			}
			const want = Math.min(stat.size - fromByte, TRANSCRIPT_READ_CAP);
			const handle = await fs.open(file, "r");
			let bytesRead: number;
			const buf = Buffer.allocUnsafe(want);
			try {
				({ bytesRead } = await handle.read(buf, 0, want, fromByte));
			} finally {
				await handle.close();
			}
			let slice = buf.subarray(0, bytesRead);
			const reachedEof = fromByte + bytesRead >= stat.size;
			if (!reachedEof) {
				// Trim to the last complete JSONL line so no line or UTF-8 char is split.
				const lastNewline = slice.lastIndexOf(0x0a);
				if (lastNewline < 0) {
					reply("", fromByte, TRANSCRIPT_ENTRY_TOO_LARGE_ERROR);
					return;
				}
				slice = slice.subarray(0, lastNewline + 1);
			}
			reply(slice.toString("utf-8"), reachedEof ? stat.size : fromByte + slice.byteLength);
		} catch (err) {
			logger.debug("collab transcript read failed", { agentId, error: String(err) });
			reply("", fromByte, String(err));
		}
	}

	/** RPC methods that mutate host state; read-only peers get them rejected. */
	static readonly #RPC_MUTATING: Record<string, true> = {
		"board.save": true,
		"cron.upsert": true,
		"cron.delete": true,
		"cron.toggle": true,
		"fs.write": true,
		"fs.mkdir": true,
		"fs.rename": true,
		"fs.delete": true,
		"session.create": true,
		"session.delete": true,
		"session.rename": true,
		"session.abort": true,
	};

	/**
	 * Guest RPC dispatch: board / cron / workspace / fs capabilities served
	 * from the host session's own stores and cwd. Mutating methods are gated
	 * on the peer's write token; every request gets a directed `rpc-result`
	 * carrying the same `reqId` (mirrors the fetch-transcript reply path).
	 */
	async #handleRpcRequest(frame: Extract<CollabFrame, { t: "rpc-request" }>, fromPeer: number): Promise<void> {
		const reply = (ok: boolean, data?: unknown, error?: string) =>
			this.#socket?.send({ t: "rpc-result", reqId: frame.reqId, ok, data, error }, fromPeer);
		const peer = this.#peers.get(fromPeer);
		if (!peer) return; // never said hello
		if (!peer.canWrite && CollabHost.#RPC_MUTATING[frame.method]) {
			reply(false, undefined, `${frame.method} is disabled on a read-only link`);
			return;
		}
		try {
			const data = await this.#rpcDispatch(frame.method, frame.params);
			reply(true, data);
		} catch (err) {
			logger.warn("collab rpc failed", { method: frame.method, error: String(err) });
			reply(false, undefined, err instanceof Error ? err.message : String(err));
		}
	}

	async #rpcDispatch(method: string, params: unknown): Promise<unknown> {
		const p = (params ?? {}) as Record<string, unknown>;
		switch (method) {
			case "board.list":
				return { boards: readBoards() };
			case "board.save": {
				const { boards } = p as { boards?: unknown };
				const check = validateBoards(boards, WIDGET_TYPES);
				if (!check.ok) throw new Error(`board.save: ${check.error}`);
				const list = (boards as BoardRecord[] | undefined) ?? [];
				// Builtin examples are protected: a full-list overwrite from any
				// guest must not drop them (mirrors the daemon's board.save).
				const currentBuiltin = readBoards().filter(b => b.builtin === true && !list.some(x => x.id === b.id));
				writeBoards(currentBuiltin.length > 0 ? [...list, ...currentBuiltin] : list);
				return { ok: true };
			}
			case "cron.list":
				return { tasks: loadCronTasks(), runs: loadCronRuns().slice(-20) };
			case "cron.runs": {
				// Read-only run history (mirrors the daemon's cron.runs):
				// newest-first, bounded by the on-disk 100-run window.
				const { id, limit } = p as { id?: string; limit?: number };
				const cap = Math.min(Math.max(limit ?? 50, 1), 100);
				const runs = (id ? loadCronRuns().filter(r => r.taskId === id) : loadCronRuns()).slice(-cap).reverse();
				return { runs };
			}
			case "cron.upsert": {
				const { task } = p as { task?: unknown };
				const check = validateCronTask(task);
				if (!check.ok) throw new Error(`cron.upsert: ${check.error}`);
				const t = task as CronTask;
				const now = Date.now();
				const tasks = loadCronTasks();
				const existing = t.id ? tasks.find(x => x.id === t.id) : undefined;
				const merged = mergeCronTask(existing, t, now, this.#ctx.sessionManager.getCwd());
				const next = existing ? tasks.map(x => (x.id === existing.id ? merged : x)) : [...tasks, merged];
				saveCronTasks(next);
				return { tasks: next, task: merged };
			}
			case "cron.delete": {
				const { id } = p as { id?: string };
				if (!id) throw new Error("cron.delete: id required");
				const tasks = loadCronTasks().filter(t => t.id !== id);
				saveCronTasks(tasks);
				return { tasks };
			}
			case "cron.toggle": {
				const { id, enabled } = p as { id?: string; enabled?: boolean };
				const tasks = loadCronTasks();
				const task = tasks.find(t => t.id === id);
				if (!task) throw new Error(`cron.toggle: unknown task "${id}"`);
				task.enabled = enabled !== false;
				task.state.nextRunAt = task.enabled ? (computeNextRun(task, Date.now()) ?? undefined) : undefined;
				saveCronTasks(tasks);
				return { tasks };
			}
			case "workspace.tree": {
				const { cwd, maxDepth, perDirLimit } = p as { cwd?: string; maxDepth?: number; perDirLimit?: number };
				return await this.#workspaceTree(cwd, { maxDepth, perDirLimit });
			}
			case "fs.read": {
				const { path: rel, maxBytes } = p as { path?: string; maxBytes?: number };
				if (typeof rel !== "string") throw new Error("fs.read: path required");
				const abs = resolveInCwd(this.#ctx.sessionManager.getCwd(), rel);
				if (!abs) throw new Error("fs.read: path escapes workspace");
				const stat = await fs.stat(abs);
				if (!stat.isFile()) throw new Error("fs.read: not a file");
				const cap = Math.max(0, Math.min(maxBytes ?? 8 * 1024 * 1024, 32 * 1024 * 1024));
				if (stat.size > cap) throw new Error(`fs.read: file too large (${stat.size} bytes)`);
				const buf = await fs.readFile(abs);
				return { base64: buf.toString("base64"), size: buf.byteLength, mime: mimeForPath(abs) };
			}
			case "fs.write": {
				const { path: rel, content } = p as { path?: string; content?: string };
				if (typeof rel !== "string" || typeof content !== "string") {
					throw new Error("fs.write: path + content required");
				}
				const res = writeWorkspaceFile(this.#ctx.sessionManager.getCwd(), rel, content);
				if (!res.ok) throw new Error(res.error);
				return { ok: true };
			}
			case "fs.mkdir": {
				const { path: rel } = p as { path?: string };
				if (typeof rel !== "string") throw new Error("fs.mkdir: path required");
				const res = createWorkspaceDir(this.#ctx.sessionManager.getCwd(), rel);
				if (!res.ok) throw new Error(res.error);
				return { ok: true };
			}
			case "fs.rename": {
				const { from, to } = p as { from?: string; to?: string };
				if (typeof from !== "string" || typeof to !== "string") {
					throw new Error("fs.rename: from + to required");
				}
				const res = renameWorkspaceEntry(this.#ctx.sessionManager.getCwd(), from, to);
				if (!res.ok) throw new Error(res.error);
				return { ok: true };
			}
			case "fs.delete": {
				const { path: rel } = p as { path?: string };
				if (typeof rel !== "string") throw new Error("fs.delete: path required");
				const res = deleteWorkspaceEntry(this.#ctx.sessionManager.getCwd(), rel);
				if (!res.ok) throw new Error(res.error);
				return { ok: true };
			}
			case "session.create": {
				if (!this.#ctx.workspace?.createWorkspaceSession) {
					throw new Error("session.create: workspace mode required");
				}
				const sessionId = await this.#ctx.workspace.createWorkspaceSession();
				return { sessionId };
			}
			case "session.delete": {
				if (!this.#ctx.workspace?.deleteWorkspaceSession) {
					throw new Error("session.delete: workspace mode required");
				}
				const { sessionId } = p as { sessionId?: string };
				if (!sessionId) throw new Error("session.delete: sessionId required");
				await this.#ctx.workspace.deleteWorkspaceSession(sessionId);
				return { ok: true };
			}
			case "session.rename": {
				if (!this.#ctx.workspace?.renameWorkspaceSession) {
					throw new Error("session.rename: workspace mode required");
				}
				const { sessionId, title } = p as { sessionId?: string; title?: string };
				if (!sessionId) throw new Error("session.rename: sessionId required");
				if (!title?.trim()) throw new Error("session.rename: title required");
				await this.#ctx.workspace.renameWorkspaceSession(sessionId, title.trim());
				return { ok: true };
			}
			case "session.abort": {
				if (!this.#ctx.workspace?.abortWorkspaceSession) {
					throw new Error("session.abort: workspace mode required");
				}
				const { sessionId } = p as { sessionId?: string };
				if (!sessionId) throw new Error("session.abort: sessionId required");
				await this.#ctx.workspace.abortWorkspaceSession(sessionId);
				return { ok: true };
			}
			default:
				throw new Error(`unknown rpc method "${method}"`);
		}
	}

	/**
	 * Structured workspace tree for the guest file pane. Same shape as the
	 * daemon's workspaceTree: paths relative to the root, `/`-separated,
	 * per-directory caps keep the newest + oldest entries when over limit.
	 */
	async #workspaceTree(
		cwd: string | undefined,
		options: { maxDepth?: number; perDirLimit?: number } = {},
	): Promise<{ rootPath: string; truncated: boolean; entries: WorkspaceEntry[] }> {
		const rootPath = path.resolve(cwd && cwd.length > 0 ? cwd : this.#ctx.sessionManager.getCwd());
		const maxDepth = Math.max(1, options.maxDepth ?? 2);
		const perDirLimit = options.perDirLimit ?? 50;
		const entries: WorkspaceEntry[] = [];
		let truncated = false;
		const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
			if (depth > maxDepth) return;
			let dirents: Dirent[];
			try {
				dirents = await fs.readdir(dir, { withFileTypes: true });
			} catch {
				return; // unreadable / vanished — skip
			}
			let bucket = dirents;
			if (perDirLimit > 0 && dirents.length > perDirLimit) {
				const withMtime = await Promise.all(
					dirents.map(async d => {
						try {
							return { dirent: d, mtime: (await fs.stat(path.join(dir, d.name))).mtimeMs };
						} catch {
							return { dirent: d, mtime: 0 };
						}
					}),
				);
				withMtime.sort((a, b) => b.mtime - a.mtime);
				bucket =
					perDirLimit <= 1
						? withMtime.slice(0, perDirLimit).map(w => w.dirent)
						: [...withMtime.slice(0, perDirLimit - 1), withMtime.at(-1)!].map(w => w.dirent);
				truncated = true;
			}
			bucket.sort((a, b) => a.name.localeCompare(b.name));
			for (const d of bucket) {
				const childRel = rel ? `${rel}/${d.name}` : d.name;
				let stat: Stats;
				try {
					stat = await fs.stat(path.join(dir, d.name));
				} catch {
					continue; // broken symlink / vanished
				}
				const isDir = stat.isDirectory();
				entries.push({
					name: d.name,
					path: childRel,
					isDir,
					size: isDir ? 0 : stat.size,
					mtime: Math.round(stat.mtimeMs),
					depth,
				});
				if (isDir) await walk(path.join(dir, d.name), childRel, depth + 1);
			}
		};
		await walk(rootPath, "", 1);
		entries.sort((a, b) => a.path.localeCompare(b.path));
		return { rootPath, truncated, entries };
	}

	#scheduleStateBroadcast(): void {
		if (this.#stopped || this.#stateDebounce) return;
		this.#stateDebounce = setTimeout(() => {
			this.#stateDebounce = null;
			const state = this.#buildState();
			const json = JSON.stringify(state);
			if (json === this.#lastStateJson) return;
			this.#lastStateJson = json;
			this.#broadcast({ t: "state", state });
		}, STATE_DEBOUNCE_MS);
	}

	#updateStatusSegment(): void {
		this.#ctx.statusLine.setCollabStatus({ role: "host", participantCount: this.#peers.size + 1 });
		this.#ctx.statusLine.invalidate();
		this.#ctx.ui.requestRender();
	}
}
