/**
 * AgentsService — the agent-control RPC seam (roster, live progress,
 * transcript, lifecycle actions) as an L2 daemon service.
 *
 * Seam:
 * - Input: `agents.*`, `session.agents` and `subagents.live` routes; the
 *   session host (`get` + `knownSessions`); the process-global AgentRegistry
 *   and AgentLifecycleManager for refs that are still live.
 * - Output: roster rows, incremental transcript bytes, lifecycle acks.
 * - Lifecycle: stateless. The session-file memo is a short TTL map, not durable
 *   state, so mounting and stopping it leave nothing behind.
 */

import * as fs from "node:fs";
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import type { DaemonSessionHost } from "../session-host";
import { isSubagentTranscriptOf, resolveSubagentTranscript, transcriptAgentId } from "../subagent-transcripts";
import type { DaemonService } from "./types";

/** The transcript poll asks every ~1.2s and a session's file does not move. */
const SESSION_FILE_TTL_MS = 10_000;
const SESSION_FILE_CACHE_LIMIT = 256;

export class AgentsService implements DaemonService {
	readonly key = "agents";
	readonly routes = {
		"agents.list": "list",
		"agents.kill": "kill",
		"agents.detach": "detach",
		"agents.revive": "revive",
		"agents.chat": "chat",
		"agents.transcript": "transcript",
		"session.agents": "roster",
		"subagents.live": "live",
	} as const;

	#sessionFiles = new Map<string, { at: number; file: string | null }>();

	constructor(private readonly host: Pick<DaemonSessionHost, "get" | "knownSessions">) {}

	/** Session file for any session id: the live attachment first, then the
	 *  TTL-cached disk scan. Child transcripts are addressed relative to their
	 *  parent's file, so every subagent read starts here. */
	async #sessionFileFor(sessionId: string): Promise<string | null> {
		const live = this.host.get(sessionId)?.agentSession.sessionFile;
		if (live) return live;
		const cached = this.#sessionFiles.get(sessionId);
		if (cached && Date.now() - cached.at < SESSION_FILE_TTL_MS) return cached.file;
		const rows = await this.host.knownSessions();
		const file = rows.find(row => row.sessionId === sessionId)?.sessionFile ?? null;
		if (this.#sessionFiles.size > SESSION_FILE_CACHE_LIMIT) this.#sessionFiles.clear();
		this.#sessionFiles.set(sessionId, { at: Date.now(), file });
		return file;
	}

	/** What is running under a session right now, straight from the progress
	 *  map the subscription path already keeps. */
	live(params: { sessionId?: unknown }): { agents: unknown[] } | { error: string } {
		const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
		if (!sessionId) return { error: "sessionId required" };
		const live = this.host.get(sessionId);
		if (!live) return { agents: [] };
		return { agents: [...live.subagentProgress.values()] };
	}

	/** Agent Control Center data (TUI /agents parity): the live registry
	 *  roster, trimmed to display-safe fields. */
	async list(): Promise<{ agents: Record<string, unknown>[] }> {
		const { AgentRegistry } = await import("../../registry/agent-registry");
		return {
			agents: AgentRegistry.global()
				.list()
				.map(ref => ({
					id: ref.id,
					displayName: ref.displayName,
					kind: ref.kind,
					parentId: ref.parentId ?? null,
					status: ref.status,
					activity: ref.activity ?? null,
				})),
		};
	}

	/** One session's subagent roster, derived from the disk rows that live in
	 *  its product directory — not from the registry. A finished one-shot
	 *  subagent is unregistered, so a registry-only roster empties exactly when
	 *  the user looks; children opened as conversations also arrive as
	 *  `Main-*` refs and must not be listed. The registry only refines status
	 *  and activity for children that are still live. */
	async roster(params: { sessionId?: unknown }): Promise<{ agents: unknown[] }> {
		const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
		if (!sessionId) throw new Error("session.agents: missing sessionId");
		const sessionFile = await this.#sessionFileFor(sessionId);
		if (!sessionFile?.endsWith(".jsonl")) return { agents: [] };
		const rows = (await this.host.knownSessions()).filter(
			row =>
				row.subagent === true &&
				row.advisor !== true &&
				typeof row.sessionFile === "string" &&
				(row.parentId === sessionId || isSubagentTranscriptOf(sessionFile, row.sessionFile)),
		);
		if (rows.length === 0) return { agents: [] };
		const { AgentRegistry } = await import("../../registry/agent-registry");
		const registry = AgentRegistry.global();
		const agents = rows.map(row => {
			const file = row.sessionFile as string;
			const id = transcriptAgentId(file);
			const ref = registry.get(id);
			// 三个 id 各有用途:agent id 寻址实时会话,子会话 id 打开会话,
			// agent 定义名(`session_init.agent`)回答“是哪个子代理”。
			const agentName = ref?.history?.agent ?? row.agentName;
			return {
				id,
				sessionId: row.sessionId,
				displayName: agentName ?? ref?.displayName ?? row.title ?? id,
				agentName: agentName ?? null,
				kind: "sub" as const,
				/** 注册表有 ref 时用实时状态;没有(一次性子代理已结束、daemon
				 *  重启)按 idle 呈现——磁盘行不可 revive,不能画成 parked 让
				 *  用户点一个必然失败的按钮。 */
				status: ref?.status ?? ("idle" as const),
				/** 名册第二行:实时 activity,否则子会话标题(即分配任务)。 */
				activity: ref?.activity ?? row.title ?? null,
				lastActivity: ref?.lastActivity ?? row.updatedAt,
				hasSessionFile: true,
			};
		});
		return { agents };
	}

	/** Abort the live session (if any) and release the ref as a tombstone so it
	 *  reads "aborted" (TUI Agent Hub's x key / collab agent-cmd kill parity). */
	async kill(params: { agentId?: unknown }): Promise<{ ok: boolean; error?: string }> {
		const { AgentRegistry } = await import("../../registry/agent-registry");
		const { AgentLifecycleManager } = await import("../../registry/agent-lifecycle");
		const id = typeof params.agentId === "string" ? params.agentId : "";
		if (!id) throw new Error("agents.kill: missing agentId");
		const ref = AgentRegistry.global().get(id);
		if (!ref) return { ok: false, error: `agent ${id} not found` };
		if (ref.status === "running" && ref.session) {
			await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
		}
		await AgentLifecycleManager.global().release(id, ref, { tombstone: true });
		return { ok: true };
	}

	/** Move a foreground subagent run to the background without restarting it:
	 *  the task tool adopts the running promise into a `task` job. */
	async detach(params: { agentId?: unknown }): Promise<unknown> {
		const { requestAgentDetach } = await import("../../task/detach-registry");
		const id = typeof params.agentId === "string" ? params.agentId : "";
		if (!id) throw new Error("agents.detach: missing agentId");
		return await requestAgentDetach(id);
	}

	/** Bring a parked subagent back to a live session (idempotent when already
	 *  running; TUI Agent Hub's r key parity). */
	async revive(params: { agentId?: unknown }): Promise<{ ok: true; sessionId: string }> {
		const { AgentLifecycleManager } = await import("../../registry/agent-lifecycle");
		const id = typeof params.agentId === "string" ? params.agentId : "";
		if (!id) throw new Error("agents.revive: missing agentId");
		const session = await AgentLifecycleManager.global().ensureLive(id);
		return { ok: true, sessionId: session.sessionId };
	}

	/** Revive if parked, steer if mid-turn (same semantics as the hub's
	 *  submitChatMessage). */
	async chat(params: { agentId?: unknown; text?: unknown }): Promise<{ ok: true; sessionId: string }> {
		const { AgentLifecycleManager } = await import("../../registry/agent-lifecycle");
		const id = typeof params.agentId === "string" ? params.agentId : "";
		const text = typeof params.text === "string" ? params.text.trim() : "";
		if (!id) throw new Error("agents.chat: missing agentId");
		if (!text) throw new Error("agents.chat: empty message");
		const session = await AgentLifecycleManager.global().ensureLive(id);
		await session.prompt(text, { streamingBehavior: "steer" });
		return { ok: true, sessionId: session.sessionId };
	}

	/** Incremental read of a subagent's persisted session file from a byte
	 *  cursor. Returns `{ text, newSize, error? }`; the GUI trajectory panel
	 *  polls with the returned cursor (a terminal `error` stops polling).
	 *
	 *  Resolution order is registry → parent product directory. The registry
	 *  only holds a ref while the child is live; a finished one-shot subagent
	 *  was unregistered, and its transcript still sits at
	 *  `<parentBase>/<agentId>.jsonl`. `parentSessionId` is the panel's owning
	 *  session, so the caller does not need to know the file path. */
	async transcript(params: {
		agentId?: unknown;
		parentSessionId?: unknown;
		fromByte?: unknown;
	}): Promise<{ text: string; newSize: number; error?: string }> {
		const { AgentRegistry } = await import("../../registry/agent-registry");
		const agentId = typeof params.agentId === "string" ? params.agentId : "";
		const parentSessionId = typeof params.parentSessionId === "string" ? params.parentSessionId : "";
		const fromByte = typeof params.fromByte === "number" && Number.isFinite(params.fromByte) ? params.fromByte : 0;
		if (!agentId) throw new Error("agents.transcript: missing agentId");
		let file = AgentRegistry.global().get(agentId)?.sessionFile ?? null;
		if (!file && parentSessionId) {
			const parentFile = await this.#sessionFileFor(parentSessionId);
			file = await resolveSubagentTranscript(parentFile, agentId);
		}
		if (!file) return { text: "", newSize: fromByte, error: "no transcript available" };
		try {
			const stat = await fs.promises.stat(file);
			if (stat.size <= fromByte) return { text: "", newSize: stat.size };
			const want = Math.min(stat.size - fromByte, 4 * 1024 * 1024);
			const handle = await fs.promises.open(file, "r");
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
				// Trim to the last complete JSONL line so no line or UTF-8 char is
				// split mid-read.
				const lastNewline = slice.lastIndexOf(0x0a);
				if (lastNewline < 0) {
					return {
						text: "",
						newSize: fromByte,
						error: `transcript entry exceeds transcript fetch cap (${4 * 1024 * 1024} bytes)`,
					};
				}
				slice = slice.subarray(0, lastNewline + 1);
			}
			return { text: slice.toString("utf-8"), newSize: reachedEof ? stat.size : fromByte + slice.byteLength };
		} catch (err) {
			return { text: "", newSize: fromByte, error: String(err) };
		}
	}
}
