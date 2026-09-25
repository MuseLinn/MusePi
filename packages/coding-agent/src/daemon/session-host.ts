/**
 * 会话宿主面（P1 第十三刀从 server.ts 纯搬移，docs/review/0.5.0-m2-daemon-host-layering.md §10）。
 *
 * DaemonSessionHost 及其会话基底（LiveSession/DaemonConnection/SessionScopedEventBus、
 * journal/idle 快照/复活/事件序机制、turn-index 与 substrate 工具函数）。
 * 纯搬移不改行为：server.ts 以 import + re-export 保持既有公共契约。
 */
/**
 * MusePi daemon — `musepi serve`.
 *
 * Independent process exposing the @musepi/sdk JSON-RPC method table over a
 * unix socket (newline-delimited JSON frames — the same framing the launch
 * broker uses). First-run scope (Phase 3 minimal surface): system.* +
 * session.create/list/subscribe/cancel/resume against a real AgentSession,
 * so the daemon boundary, RPC transport, method table and the session event
 * stream are all exercised end to end.
 *
 * Transport note: this server is local-only (unix socket), so auth is
 * effectively local for every method. The public/session/local matrix in
 * @musepi/sdk becomes a real gate when a remote transport (relay/tunnel) is
 * added — see the daemon design decisions.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEvent } from "@musepi/pi-agent-core";
import { AgentPauseGate } from "@musepi/pi-agent-core";
import { DesktopSession } from "@musepi/pi-natives";
import { getAgentDir, getSessionsDir, logger, prompt } from "@musepi/pi-utils";
import type { SessionEntry, SessionHeader, SessionState, WireMessage } from "@musepi/pi-wire";
import type { SessionStreamEvent } from "@musepi/sdk";
import { MaterializedView, messageKey, type Static, type sessionSnapshot } from "@musepi/sdk";
import type { WorkspaceSessionInfo } from "../collab/protocol";
import { isWireAgentEvent, toWireAgentEvent } from "../collab/wire-guard";
import { findConfigFile } from "../config";
import type { ModelRegistry } from "../config/model-registry";
import type { PromptTemplate } from "../config/prompt-templates";
import type { Settings } from "../config/settings";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type { Skill } from "../extensibility/skills";
import type { FileSlashCommand } from "../extensibility/slash-commands";
import { FileIndexService } from "../file-index";
import type { MCPManager } from "../mcp";
import { MCP_CONNECTION_STATUS_EVENT_CHANNEL, type McpConnectionStatusEvent } from "../mcp/startup-events";
import { computeContextBreakdown } from "../modes/utils/context-usage";
import idleRecapPrompt from "../prompts/system/recap-user.md" with { type: "text" };
import type { SessionInfo, SessionStatus } from "../session/session-listing";
import type { SnapcompactSavingsEstimate } from "../session/snapcompact-inline";
import { resolvePromptInput } from "../system-prompt";
import type { ConfiguredThinkingLevel } from "../thinking";
import type { CollabToolHandle } from "../tools/collab";
import { previewLine, TRUNCATE_LENGTHS } from "../tools/render-utils";
import type { ScheduledTaskHandle } from "../tools/schedule-task";
import { nextActionableTask, type TodoPhase } from "../tools/todo";
import { createExtensionManagerTools } from "./extension-lifecycle-tools";
import { createExtensionRuntimeTools, RuntimeToolRegistry } from "./extension-runtime-tools";
import { pauseSidecarPath, readPauseSidecar, writePauseSidecar } from "./pause-sidecar";

/** Stable per-project notes filename (cwd hash). */
async function hashProjectPath(cwd: string): Promise<string> {
	return createHash("sha1").update(cwd).digest("hex").slice(0, 16);
}

/**
 * TUI parity for daemon sessions: merge project/global SYSTEM.md and
 * APPEND_SYSTEM.md into the session prompt inputs (the CLI's
 * buildSessionOptions does the same via applyResolvedSystemPromptInputs).
 * Project-level files win over global ones, matching discoverSystemPromptFile.
 */
export async function sessionPromptInputs(
	cwd: string,
): Promise<{ customSystemPrompt?: string; appendSystemPrompt?: string }> {
	const out: { customSystemPrompt?: string; appendSystemPrompt?: string } = {};
	const projectSystem = findConfigFile("SYSTEM.md", { user: false, cwd });
	const globalSystem = projectSystem ? undefined : findConfigFile("SYSTEM.md", { user: true, cwd });
	const systemPath = projectSystem ?? globalSystem;
	if (systemPath) {
		const resolved = await resolvePromptInput(systemPath, "system prompt");
		if (resolved) out.customSystemPrompt = resolved;
	}
	const projectAppend = findConfigFile("APPEND_SYSTEM.md", { user: false, cwd });
	const globalAppend = projectAppend ? undefined : findConfigFile("APPEND_SYSTEM.md", { user: true, cwd });
	const appendPath = projectAppend ?? globalAppend;
	if (appendPath) {
		const resolved = await resolvePromptInput(appendPath, "append system prompt");
		if (resolved) out.appendSystemPrompt = resolved;
	}
	return out;
}

/** sessionPromptInputs + a one-line desktop-interface marker.
 *
 *  The daemon serves the GUI/browser, so a GUI-session agent should know it
 *  is not driving a terminal — some settings it might otherwise try to change
 *  (theme.*, statusLine.*, terminal.*, tui.*, …) are TUI-only and would be
 *  no-ops here.
 *
 *  Issue #40: this note used to spell out all ~40 `ui.tuiOnly` setting names
 *  (~250 tokens every request). The model has no reason to know desktop-GUI
 *  software's terminal-only key names, and a 40-entry negative list buys
 *  essentially nothing — the agent rarely volunteers `tui.codexResetFireworks`
 *  in the first place. The GUI surfaces the same information where it belongs:
 *  `SchemaSettings.tsx` badges TUI-only rows from the `ui.tuiOnly` flag on the
 *  RPC schema, so a human editing settings still sees which ones are no-ops.
 *  Keep the marker, drop the enumeration. */

/** Lazy native desktop session singleton: `computer.capabilities` RPC reads
 *  macOS Screen Recording / Accessibility / Input permissions without
 *  spinning a new worker thread per call. The first call initializes the
 *  backend (worker thread stays resident for the daemon lifetime). */
let desktopCapabilitiesSession: DesktopSession | undefined;
async function getDesktopCapabilities() {
	if (!desktopCapabilitiesSession) {
		desktopCapabilitiesSession = new DesktopSession();
		await desktopCapabilitiesSession.listDisplays().catch(() => {});
	}
	return desktopCapabilitiesSession.capabilities;
}

async function desktopSessionPromptInputs(
	cwd: string,
): Promise<{ customSystemPrompt?: string; appendSystemPrompt?: string }> {
	const base = await sessionPromptInputs(cwd);
	const note =
		"当前为桌面界面（GUI）会话。部分设置仅对终端界面（TUI）生效，在本次会话中修改不会影响当前界面；" +
		"设置面板中这些项已标注。";
	return {
		...base,
		appendSystemPrompt: base.appendSystemPrompt ? `${base.appendSystemPrompt}\n\n${note}` : note,
	};
}

/**
 * gh CLI path: PATH first, then common install locations. Daemons launched
 * from the GUI (Electron) or launchd often lack /opt/homebrew/bin in PATH,
 * so `Bun.which("gh")` alone reports "not installed" for brew users.
 */
let ghBin: string | null | undefined;
function ghPath(): string | null {
	if (ghBin !== undefined) return ghBin;
	if (Bun.which("gh") !== null) {
		ghBin = "gh";
		return ghBin;
	}
	if (process.platform === "darwin") {
		for (const candidate of ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"]) {
			if (fs.existsSync(candidate)) {
				ghBin = candidate;
				return ghBin;
			}
		}
	} else if (process.platform === "win32") {
		const programFiles = process.env.ProgramFiles;
		const candidate = programFiles ? path.join(programFiles, "GitHub CLI", "gh.exe") : "";
		if (candidate !== "" && fs.existsSync(candidate)) {
			ghBin = candidate;
			return ghBin;
		}
	}
	ghBin = null;
	return null;
}

/**
 * Daemon-owned GitHub token (openchamber pattern): the device-flow token is
 * stored here instead of `gh auth login`, whose token validation hits
 * api.github.com — unreachable on flaky networks, which then fails the whole
 * auth even though the device flow succeeded. gh RPCs receive it via the
 * GH_TOKEN env (higher precedence than the keyring).
 */
interface StoredGhToken {
	token: string;
	login?: string;
	email?: string;
	updatedAt: string;
}
function ghTokenPath(): string {
	return path.join(getAgentDir(), "github-token.json");
}
function readGhToken(): StoredGhToken | null {
	try {
		const raw = fs.readFileSync(ghTokenPath(), "utf8");
		const parsed = JSON.parse(raw) as StoredGhToken;
		return typeof parsed.token === "string" && parsed.token.length > 0 ? parsed : null;
	} catch {
		return null;
	}
}
function writeGhToken(token: string, identity?: { login?: string; email?: string }): void {
	try {
		const prev = readGhToken();
		fs.writeFileSync(
			ghTokenPath(),
			JSON.stringify(
				{
					token,
					login: identity?.login ?? prev?.login,
					email: identity?.email ?? prev?.email,
					updatedAt: new Date().toISOString(),
				},
				null,
				2,
			),
			{ mode: 0o600 },
		);
	} catch {
		// agent dir unavailable — token lost after daemon restart
	}
}
function clearGhToken(): void {
	try {
		fs.unlinkSync(ghTokenPath());
	} catch {
		// nothing stored
	}
}

/**
 * Slash-command grouping for the GUI completion tags (openchamber-style
 * category badges). Keys are stable English ids; the GUI translates them.
 */
const SLASH_CATEGORY: Record<string, string> = {
	// Session & context
	session: "session",
	new: "session",
	fresh: "session",
	clear: "session",
	drop: "session",
	compact: "session",
	resume: "session",
	retry: "session",
	rename: "session",
	jobs: "session",
	context: "session",
	copy: "session",
	move: "session",
	memory: "session",
	handoff: "session",
	shake: "session",
	share: "session",
	collab: "session",
	join: "session",
	leave: "session",
	live: "session",
	pause: "session",
	todo: "session",
	// Goals & plans
	goal: "goal",
	"guided-goal": "goal",
	plan: "goal",
	"plan-review": "goal",
	vibe: "goal",
	prewalk: "goal",
	loop: "goal",
	queue: "goal",
	force: "goal",
	// Model & runtime
	model: "model",
	switch: "model",
	fast: "model",
	computer: "model",
	vision: "model",
	advisor: "model",
	// System
	settings: "system",
	setup: "system",
	security: "system",
	hotkeys: "system",
	changelog: "system",
	exit: "system",
	quit: "system",
	usage: "system",
	stats: "system",
	tools: "system",
	extensions: "system",
	agents: "system",
	plugins: "system",
	"reload-plugins": "system",
	marketplace: "system",
	dump: "system",
	debug: "system",
	export: "system",
	// Account & network
	login: "account",
	logout: "account",
	browser: "network",
	ssh: "network",
	mcp: "network",
	// Git & workspace
	branch: "git",
	fork: "git",
	tree: "git",
	dirs: "workspace",
	"add-dir": "workspace",
	"remove-dir": "workspace",
};

function slashCommandCategory(name: string): string {
	return SLASH_CATEGORY[name] ?? "system";
}

/** Snapshot text extraction for revert-restore (string or content blocks). */
function extractSnapshotText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map(block =>
				block && typeof block === "object" && "text" in block ? String((block as { text: string }).text) : "",
			)
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

/**
 * Project an SDK transcript (jsonl of final AgentEvents, first line a
 * `session` header) into the snapshot shape the GUI consumes. The daemon
 * journal replays streaming events; persisted transcripts carry final
 * `message` rows instead, so this mirrors the materialized view's message
 * projection rather than replaying through it.
 */
async function snapshotFromJsonl(file: string, sessionId: string): Promise<Static<typeof sessionSnapshot>> {
	const text = await fs.promises.readFile(file, "utf8");
	const entries: SessionEntry[] = [];
	let header: SessionHeader | undefined;
	let cursor = 0;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let rec: Record<string, unknown>;
		try {
			rec = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (rec.type === "session") {
			header = rec as unknown as SessionHeader;
			continue;
		}
		if (rec.type === "message" && rec.message && typeof rec.message === "object") {
			const id = typeof rec.id === "string" ? rec.id : `msg-${cursor}`;
			const parentId = typeof rec.parentId === "string" ? rec.parentId : null;
			const ts =
				typeof rec.timestamp === "string"
					? rec.timestamp
					: new Date((rec.message as { timestamp?: unknown }).timestamp as number).toISOString();
			entries.push({ type: "message", id, parentId, timestamp: ts, message: rec.message as WireMessage });
			cursor += 1;
		}
	}
	const cwd = header && typeof header.cwd === "string" ? header.cwd : "";
	const state: SessionState = {
		isStreaming: false,
		queuedMessageCount: 0,
		cwd,
		participants: [],
	};
	return {
		header: header ?? { type: "session", id: sessionId, timestamp: "", cwd },
		entries,
		state,
		agents: [],
		cursor,
	};
}

import type {
	ExtensionNotificationMessage,
	ExtensionSetting,
	ExtensionUIContext,
} from "../extensibility/extensions/types";
import type { AgentSession } from "../session/agent-session";
import {
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "../task/types";
import { EventBus } from "../utils/event-bus";
import { type ApprovalBridge, createApprovalBridge, type PendingApproval, type PendingAsk } from "./approval-bridge";
import { type BatchedEvent, EventBatcher } from "./event-batcher";
import { AppendJournal, catchupPlan } from "./journal";
import { type MaterializedRow, ViewStore, viewStorePath } from "./view-store";

export interface DaemonOptions {
	socketPath?: string;
	/** Optional WebSocket port (browser-reachable JSON-RPC transport). */
	wsPort?: number;
	/** Optional loopback HTTP port serving the renderer bundle (client-core
	 *  dist) — the dsh-desktop-compat "runtime serves the web renderer" half.
	 *  The Electron compat shell loadURLs this origin; the WS stays on wsPort. */
	webPort?: number;
	cwd?: string;
	/**
	 * Remote-access token. When set, the WS transport binds all interfaces
	 * and REQUIRES this token on every connection (Authorization: Bearer
	 * header, or `?token=` on the WebSocket URL for browsers that cannot
	 * set headers). Absent => loopback-only, no auth (current behavior).
	 */
	remoteToken?: string;
}

/**
 * Daemon runtime dir: socket + journal + materialized view store. Defaults
 * to a shared temp dir, but MUST be isolatable (MUSEPI_DAEMON_DIR) so test
 * daemons never collide with the user's: two daemons sharing the journal
 * dir race the materialized.db write lock and the journal compaction .tmp
 * rename — both crash the process.
 */
export const SOCKET_DIR = process.env.MUSEPI_DAEMON_DIR || path.join(os.tmpdir(), "musepi-daemon");

/** Minimal typed view over the live AgentSession's mode state. */
export interface ModeSessionLike {
	getGoalModeState?(): { enabled?: boolean; goal?: { objective?: string; status?: string } } | undefined;
	getPlanModeState?(): { enabled?: boolean } | undefined;
	getTodoPhases?(): TodoPhase[];
	isCompacting?: boolean;
}

/** Goal/plan mode + aggregated todo progress for the GUI badges. */
export function modesOf(session: unknown): {
	goalMode: { enabled: boolean; objective?: string; status?: string } | null;
	planMode: boolean;
	isCompacting: boolean;
	todo: {
		name: string;
		done: number;
		total: number;
		tasks: { content: string; status: string; blocker?: string }[];
	}[];
} {
	const s = session as ModeSessionLike;
	const goal = s.getGoalModeState?.();
	const phases = s.getTodoPhases?.() ?? [];
	return {
		goalMode: goal?.goal?.objective
			? { enabled: goal.enabled === true, objective: goal.goal.objective, status: goal.goal.status }
			: null,
		planMode: s.getPlanModeState?.()?.enabled === true,
		isCompacting: s.isCompacting === true,
		todo: phases
			.filter(p => p.tasks.length > 0)
			.map(p => ({
				name: p.name,
				done: p.tasks.filter(t => t.status === "completed").length,
				total: p.tasks.length,
				tasks: p.tasks.map(t => ({
					content: t.content,
					status: t.status,
					...(t.blocker ? { blocker: t.blocker } : {}),
				})),
			})),
	};
}
export const DEFAULT_SOCKET = path.join(SOCKET_DIR, "daemon.sock");
export const JOURNAL_DIR = path.join(SOCKET_DIR, "journal");

/** Journal file for a session id (the daemon's only journal layout). */
export function journalFilePath(sessionId: string): string {
	return path.join(JOURNAL_DIR, `${sessionId}.journal.jsonl`);
}

/**
 * Snapcompact wire-savings estimates are memoized per live session — the
 * estimate scans the full message history (TUI /context parity), and the
 * GUI usage ring polls `session.contextUsage` every 3s, so recomputing on
 * every tick would burn CPU on large sessions. Keyed by the stats
 * revision (bumps on message/turn changes) + the messages/systemPrompt
 * array identity + the snapcompact settings; the estimate is gated on the
 * experimental settings, so the default configuration skips it entirely.
 */
const snapcompactEstimateCache = new WeakMap<
	AgentSession,
	{
		messagesRef: readonly unknown[];
		systemPromptRef: readonly string[];
		key: string;
		estimate: SnapcompactSavingsEstimate | null;
	}
>();

export function estimateSnapcompactSavings(session: AgentSession): SnapcompactSavingsEstimate | null {
	const renderSystemPrompt = String(session.settings.get("snapcompact.systemPrompt"));
	const renderToolResults = String(session.settings.get("snapcompact.toolResults"));
	if (renderSystemPrompt === "none" && renderToolResults === "false") return null;
	const shape = String(session.settings.get("snapcompact.shape"));
	const messages = session.messages;
	const systemPrompt = session.systemPrompt;
	const key = `${session.contextUsageRevision}|${renderSystemPrompt}|${renderToolResults}|${shape}`;
	const cached = snapcompactEstimateCache.get(session);
	if (cached && cached.messagesRef === messages && cached.systemPromptRef === systemPrompt && cached.key === key) {
		return cached.estimate;
	}
	try {
		const breakdown = computeContextBreakdown(session, { snapcompactSavings: true });
		const estimate = breakdown.snapcompact ?? null;
		snapcompactEstimateCache.set(session, { messagesRef: messages, systemPromptRef: systemPrompt, key, estimate });
		return estimate;
	} catch (err) {
		logger.debug("snapcompact savings estimate failed", { err: String(err) });
		return null;
	}
}

/** Live sessions with no activity (send or event) for this long are auto-closed. */
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/** Mobile pair endpoint port — resolves pair codes only (LAN). */
export const PAIR_PORT = 8301;
/**
 * Live-session LRU cap: the GUI switch keeps every visited session live
 * (idle-close only after IDLE_TIMEOUT_MS), so a long session-switching
 * session would accumulate full agent runtimes (journal + materialized
 * view + agent loop) with no bound. When the live map exceeds the cap the
 * scanner closes the oldest IDLE sessions — never a working/compacting
 * one — and they stay listed + resumable as snapshot-only history
 * (activate() re-attaches on open).
 */
export const MAX_LIVE_SESSIONS = 8;

/**
 * Whether a live session is doing work the user never asked to stop.
 * Idle disposal must never reap one of these (issue #16): the LRU cap already
 * skipped streaming/compacting sessions, but the 30-minute idle timeout and the
 * per-session idleTimer did not — so a Goal-mode session left running in the
 * background was disposed mid-tool (`session_exit reason=dispose`,
 * pendingToolCalls=1) and came back as "previous process exited … will not
 * continue automatically". Switching GUI sessions must not cancel background
 * work; only genuinely idle runtimes are reclaimable.
 */
export function isLiveSessionBusy(live: {
	agentSession?: { isStreaming?: boolean; isCompacting?: boolean } | null;
	activeToolCalls?: { size: number };
}): boolean {
	if (live.agentSession?.isStreaming === true) return true;
	if (live.agentSession?.isCompacting === true) return true;
	if ((live.activeToolCalls?.size ?? 0) > 0) return true;
	return false;
}

/** Minimal live-session shape the idle-dispose policy reads. */
export interface IdleCandidate {
	agentSession?: { isStreaming?: boolean; isCompacting?: boolean } | null;
	activeToolCalls?: { size: number };
	lastActivity: number;
}

/**
 * Which live sessions the idle scanner should close, in close order.
 * Pure (clock passed in) so the policy is testable without waiting 30
 * minutes: a busy session is never a candidate for either the timeout or
 * the LRU cap — only genuinely idle runtimes are reclaimable.
 */
export function idleDisposePlan(
	sessions: Iterable<readonly [string, IdleCandidate]>,
	now: number,
	idleTimeoutMs: number = IDLE_TIMEOUT_MS,
	maxLive: number = MAX_LIVE_SESSIONS,
): string[] {
	const entries = [...sessions];
	// 1. Idle timeout — skipped entirely for working sessions (issue #16).
	const timedOut: string[] = [];
	const survivors: (readonly [string, IdleCandidate])[] = [];
	for (const entry of entries) {
		if (!isLiveSessionBusy(entry[1]) && now - entry[1].lastActivity > idleTimeoutMs) timedOut.push(entry[0]);
		else survivors.push(entry);
	}
	// 2. LRU cap over what is left: oldest idle first, never a working one.
	if (survivors.length > maxLive) {
		const excess = survivors.length - maxLive;
		const oldest = survivors
			.filter(([, live]) => !isLiveSessionBusy(live))
			.sort((a, b) => a[1].lastActivity - b[1].lastActivity)
			.slice(0, excess)
			.map(([id]) => id);
		timedOut.push(...oldest);
	}
	return timedOut;
}

/**
 * Tail-window the initial snapshot: the GUI opens a
 * session showing the LATEST messages and pages older history up as the
 * user scrolls (session.history) — the full transcript is never shipped
 * (or held) up front. `tail` rides on the returned snapshot: hasMore =
 * older history exists, beforeId = cursor for session.history (the
 * oldest entry in the tail).
 */
export const TAIL_ENTRIES = 200;
export interface TailInfo {
	hasMore: boolean;
	beforeId: string | null;
}
export function tailSnapshot<T extends { entries?: readonly unknown[] }>(snap: T): T & { tail: TailInfo } {
	const entries = snap.entries ?? [];
	if (entries.length <= TAIL_ENTRIES) {
		return { ...snap, tail: { hasMore: false, beforeId: null } };
	}
	const firstKept = entries[entries.length - TAIL_ENTRIES] as { id?: unknown } | undefined;
	return {
		...snap,
		entries: entries.slice(-TAIL_ENTRIES),
		tail: { hasMore: true, beforeId: typeof firstKept?.id === "string" ? firstKept.id : null },
	};
}
/** Full-turn index item — the wire shape of client-core's TurnIndexItem
 *  (M1.11 turn-index.ts). session.turns ships these so the GUI's TurnRail
 *  covers turns the tail window never loaded: the client builds its index
 *  from the LOADED entries only, so on long sessions the rail silently
 *  dropped everything older than the paged-in window. One ~120B record per
 *  turn regardless of how much history is materialized. */
export interface DaemonTurnItem {
	/** Absolute entry index of the turn's start entry. */
	startIdx: number;
	entryId: string;
	timestamp: string;
	summary: string;
	kind: "user" | "advisor";
}
export const TURN_SUMMARY_MAX = 90;
/** MUST stay in sync with client-core round-collapse.ts isTurnStart: a user
 *  prompt OR a displayed advisor note starts a turn. Duplicated here rather
 *  than imported because the daemon must not depend on the client package. */
function daemonIsTurnStart(e: unknown): boolean {
	if (!e || typeof e !== "object") return false;
	const t = e as { type?: unknown; message?: { role?: unknown }; customType?: unknown; display?: unknown };
	if (t.type === "message") return t.message?.role === "user";
	if (t.type === "custom_message") return t.customType === "advisor" && t.display === true;
	return false;
}
/** Summary text of a turn-start entry: message entries carry the text under
 *  `message.content`, custom_message entries under `content` — string or
 *  text-content blocks, mirroring client-core msgText/customText. */
function daemonEntryText(e: unknown): string {
	const rec = e as { message?: { content?: unknown }; content?: unknown } | null;
	const c = rec?.message?.content ?? rec?.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		return c
			.filter(b => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text")
			.map(b => (b as { text?: unknown }).text ?? "")
			.filter(s => typeof s === "string")
			.join(" ");
	}
	return "";
}
export function buildDaemonTurnIndex(entries: readonly unknown[]): DaemonTurnItem[] {
	const out: DaemonTurnItem[] = [];
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i];
		if (!daemonIsTurnStart(e)) continue;
		const rec = e as { id?: unknown; timestamp?: unknown; type?: unknown };
		const entryId = typeof rec.id === "string" ? rec.id : String(rec.id ?? "");
		const timestamp = typeof rec.timestamp === "string" ? rec.timestamp : String(rec.timestamp ?? "");
		out.push({
			startIdx: i,
			entryId,
			timestamp,
			summary: daemonEntryText(e).replace(/\s+/g, " ").trim().slice(0, TURN_SUMMARY_MAX),
			kind: rec.type === "message" ? "user" : "advisor",
		});
	}
	return out;
}
const IDLE_SCAN_INTERVAL_MS = 60 * 1000;
/** Single JSON-RPC request cap. Raised 4→16 MiB (2026-09-18, #23 follow-up):
 *  `stt.transcribe` ships 16 kHz mono float JSON (~127 KB/s after the client
 *  quantises to 5 decimals), so 4 MiB capped dictation at ~30 s and mobile
 *  recording had no headroom. 16 MiB gives ~2 min at the same rate and matches
 *  collab/relay-server.ts's DEFAULT_MAX_FRAME_BYTES, so the two transports no
 *  longer disagree about what "too large" means. */
export const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
/** Journal catch-up pages: flush + yield every N records so a huge replay
 *  (long idle gap) interleaves with other traffic instead of flooding. */
const CATCHUP_PAGE_SIZE = 500;
/** Wire payload for an `ask-request` push (ask card, TUI ask parity):
 *  multi-question dialogs carry the questions array; single select/input
 *  keep the flat title/options shape. Shared by the live broadcast and the
 *  subscribe-time replay so both surfaces stay in sync. */
function askRequestPayload(record: PendingAsk):
	| {
			requestId: string;
			title: string;
			options: string[] | null;
			multi: boolean;
			mode: "select" | "input";
	  }
	| { requestId: string; title: string; mode: "dialog"; questions: PendingAsk["questions"] } {
	return record.mode === "dialog"
		? { requestId: record.requestId, title: record.title, mode: "dialog", questions: record.questions }
		: {
				requestId: record.requestId,
				title: record.title,
				options: record.options,
				multi: record.multi,
				mode: record.mode,
			};
}
/** Idle-recap delay bounds (TUI event-controller parity). */
const IDLE_RECAP_MIN_SECONDS = 1;
const IDLE_RECAP_MAX_SECONDS = 3600;

// ── JSON-RPC 2.0 ────────────────────────────────────────────────────────────

export interface RpcRequest {
	jsonrpc: "2.0";
	id: number | string;
	method: string;
	params?: unknown;
}

/** A tool call currently executing in a live session, retained so a GUI
 *  (re)subscribe can hydrate the composer's running-tool visuals — the
 *  live `tool_execution_*` envelopes are stream-only and never replay. */
interface ActiveToolCall {
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
	partialResult?: unknown;
	/** Wall-clock ms — mirrors the GUI ActiveTool.startedAt contract. */
	startedAt: number;
}

/** Runtime-narrowed read of a task-subagent payload's ownership tag.
 *  `undefined` = untagged (legacy/unknown emitter). */
function taggedSessionIdOf(data: unknown): string | undefined {
	if (data !== null && typeof data === "object" && "sessionId" in data) {
		return typeof data.sessionId === "string" ? data.sessionId : undefined;
	}
	return undefined;
}

/** Per-session view of the shared daemon EventBus: task-subagent channel
 *  payloads emitted by THIS session get stamped with its id, so the
 *  per-session stream fan-out can route frames to the owning session's
 *  subscribers only (the bus itself is process-global — without the tag,
 *  session A's swarm visuals leak into session B's stream). */
export class SessionScopedEventBus extends EventBus {
	#parent: EventBus;
	#sessionId: string;
	constructor(parent: EventBus, sessionId: string) {
		super();
		this.#parent = parent;
		this.#sessionId = sessionId;
	}
	/** Bind the owning session id. For `session.create` the id is minted
	 *  inside createAgentSession (so it's unknown at construction time) —
	 *  the daemon calls this right after adopting the live session. */
	setSessionId(sessionId: string): void {
		this.#sessionId = sessionId;
	}
	override emit(channel: string, data: unknown): void {
		if (
			(channel === TASK_SUBAGENT_PROGRESS_CHANNEL || channel === TASK_SUBAGENT_LIFECYCLE_CHANNEL) &&
			taggedSessionIdOf(data) === undefined
		) {
			this.#parent.emit(channel, { ...(data as Record<string, unknown>), sessionId: this.#sessionId });
			return;
		}
		this.#parent.emit(channel, data);
	}
	override on(channel: string, handler: (data: unknown) => void): () => void {
		// Listeners live on the parent so this view also receives traffic
		// from other emitters; nothing registers locally.
		return this.#parent.on(channel, handler);
	}
	override clear(): void {
		// Clearing must never nuke the shared bus's listeners.
	}
}

// ── Session host ────────────────────────────────────────────────────────────

/** Flatten an assistant message's content parts to plain text (channel reply
 *  pushes send text only — toolResult/thinking parts are skipped). */
export function assistantReplyText(message: unknown): string {
	const content = (message as { content?: unknown } | null | undefined)?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(part => (part as { type?: string })?.type === "text")
		.map(part => String((part as { text?: string }).text ?? ""))
		.join("")
		.trim();
}

export interface LiveSession {
	sessionId: string;
	agentSession: AgentSession;
	/** Session workspace root — also the key for this session's cwd-scoped
	 *  MCP manager (project MCP config discovery). */
	cwd: string;
	/** Settings contributed by loaded extensions (registerSetting), keyed by
	 *  setting key — merged into settings.schema for the GUI/TUI panels.
	 *  Value carries the owning extension path so the GUI can group
	 *  declarative schema cards per extension without a React component. */
	extensionSettings: Map<string, { setting: ExtensionSetting; extensionPath: string }>;
	/** When false, the session-tree title never falls back to the first
	 *  user message (Settings → 会话 → 自动生成会话标题 off). */
	autoTitle: boolean;
	/** 会话预设(mode)id:adopt 时取 SDK 会话 header,缺失回落守护进程快照头;
	 *  创建路径由 createSession 显式补写(SDK 的 create 不写 header)。
	 *  消费方:session.modes → GUI 的 design 风格 chip 与上下文面板模式名。 */
	modeId?: string;
	/** Envelope seq for NON-journaled stream kinds only (approval-request,
	 *  ask-request, agent-progress, agent-lifecycle, title, recap,
	 *  pause-state) — a per-session display counter, NOT the journal
	 *  watermark space. kind:"event" envelopes carry the journal record seq
	 *  (see #adoptAgentSession); clients gate only on that space. */
	seq: number;
	journal: AppendJournal | null;
	view: MaterializedView;
	subscribers: Map<string, (event: SessionStreamEvent) => void>;
	/** Currently-executing tool calls (subscribe-time hydration of the GUI
	 *  composer's running-tool visuals — see ActiveToolCall). */
	activeToolCalls: Map<string, ActiveToolCall>;
	/** Latest progress payload per running subagent owned by THIS session
	 *  (subscribe-time hydration of the swarm visuals — the agent frames
	 *  are stream-only, so a re-subscribing client would otherwise start
	 *  blank until the next frame arrives). */
	subagentProgress: Map<string, SubagentProgressPayload>;
	/** Last activity (send or event) — drives the idle auto-dispose. */
	lastActivity: number;
	/** Idle timer; cleared on close/dispose. */
	idleTimer: ReturnType<typeof setTimeout> | null;
	/** Idle-recap timer (TUI parity); cleared on close/dispose. */
	recapTimer: Timer | null;
	/** In-flight ephemeral recap turn; aborted on any activity. */
	recapAbort: AbortController | null;
	/** Un-sent composer draft (GUI reports via session.setDraft) — the
	 *  daemon-side analogue of the TUI's editor-draft recap guard. */
	editorDraft: boolean;
	/** GUI tool-approval gate (approval-select UI context + pending table). */
	approvals: ApprovalBridge;
	/** Per-session freeze gate (TUI `/pause` parity): engaging it parks every
	 *  agent loop of THIS session (main, subagents, advisor) at its next safe
	 *  boundary — other sessions keep running. */
	pauseGate: AgentPauseGate;
	/** Publish an approval request to all subscribers as an envelope. */
	publishApproval(record: PendingApproval): void;
	/** Broadcast a wire event (journal + materialized view + subscribers)
	 *  without touching agent state — for RPC paths whose side effects are
	 *  already recorded in the session (see session.bashCommand). */
	publishWireEvent(
		event: Parameters<typeof AgentSession.prototype.subscribe>[0] extends (e: infer E) => void ? E : never,
	): void;
	dispose: () => void;
}

/** A connected RPC client; `send` writes a newline-framed JSON message. */
export interface DaemonConnection {
	readonly id: string;
	send(message: unknown): void;
	/** Bytes buffered on the transport's write side (backpressure probe). */
	writableLength?: () => number;
}

/**
 * Read-only session-create discoveries shared across daemon sessions so
 * every session.create after the first skips the re-scan. Only file scans
 * and singleton constructions live here — per-session state (SessionManager,
 * extension LOADING, MCP discovery, watchdog/advisor/repo-context reads) is
 * deliberately NOT cached (extensionRunner and MCP servers are per-session /
 * per-host by design with effects).
 */
export interface CachedSessionDiscovery {
	/** Resolved cwd the discovery ran against. */
	cwd: string;
	/** Resolved agentDir. */
	agentDir: string;
	settings: Settings;
	modelRegistry: ModelRegistry;
	contextFiles: Array<{ path: string; content: string; depth?: number }>;
	promptTemplates: PromptTemplate[];
	slashCommands: FileSlashCommand[];
	skills: Skill[];
	/** Extension SOURCE PATHS only — loading still happens per session so
	 *  each Extension binds to its own session's ExtensionAPI. */
	extensionPaths: string[];
}

/**
 * Directory-mtime fingerprint of the roots the cached discoveries scan
 * (agentDir + cwd + their well-known capability/config subdirs and flat
 * files). Directory mtimes bump when entries are added/removed, so new
 * skills/prompts/commands/extensions/AGENTS.md appear without a daemon
 * restart; file mtimes catch content edits of the flat config files.
 * Existence-tolerant: a missing root hashes as "0".
 */
async function discoveryMtimeKey(cwd: string, agentDir: string): Promise<string> {
	const roots = [
		agentDir,
		path.join(agentDir, "config.yml"),
		path.join(agentDir, "config.yaml"),
		path.join(agentDir, "models.yml"),
		path.join(agentDir, "skills"),
		path.join(agentDir, "prompts"),
		path.join(agentDir, "commands"),
		path.join(agentDir, "extensions"),
		path.join(agentDir, "context"),
		path.join(agentDir, "AGENTS.md"),
		path.join(agentDir, "WATCHDOG.md"),
		path.join(agentDir, "WATCHDOG.yml"),
		path.join(agentDir, "WATCHDOG.yaml"),
		path.join(agentDir, "SYSTEM.md"),
		path.join(agentDir, "APPEND_SYSTEM.md"),
		cwd,
		path.join(cwd, ".omp"),
		path.join(cwd, ".claude"),
		path.join(cwd, ".musepi"),
		path.join(cwd, "AGENTS.md"),
		path.join(cwd, ".omp", "AGENTS.md"),
		path.join(cwd, ".claude", "AGENTS.md"),
		path.join(cwd, ".musepi", "AGENTS.md"),
		path.join(cwd, ".omp", "prompts"),
		path.join(cwd, ".claude", "prompts"),
		path.join(cwd, ".musepi", "prompts"),
		path.join(cwd, ".omp", "commands"),
		path.join(cwd, ".claude", "commands"),
		path.join(cwd, ".musepi", "commands"),
		path.join(cwd, ".omp", "extensions"),
		path.join(cwd, ".claude", "extensions"),
		path.join(cwd, ".musepi", "extensions"),
		path.join(cwd, ".omp", "skills"),
		path.join(cwd, ".claude", "skills"),
		path.join(cwd, ".musepi", "skills"),
		path.join(cwd, ".omp", "context"),
		path.join(cwd, ".claude", "context"),
		path.join(cwd, ".musepi", "context"),
		path.join(cwd, "WATCHDOG.md"),
		path.join(cwd, "WATCHDOG.yml"),
		path.join(cwd, "WATCHDOG.yaml"),
		path.join(cwd, ".musepi", "WATCHDOG.md"),
		path.join(cwd, ".musepi", "WATCHDOG.yml"),
		path.join(cwd, ".musepi", "WATCHDOG.yaml"),
	];
	const stats = await Promise.all(
		roots.map(async root => {
			try {
				const st = await fs.promises.stat(root);
				return `${root}:${st.mtimeMs}`;
			} catch {
				// absent root — part of the key so creating it invalidates
				return `${root}:0`;
			}
		}),
	);
	return stats.join("|");
}

/**
 * Settings-driven inputs the cached discoveries depend on (skills toggles,
 * extension enable/disable). Part of the cache validity check so settings.*
 * RPC changes (Settings → 技能/extensions) invalidate without a filesystem
 * bump.
 */
export function discoverySettingsFingerprint(settings: Settings): string {
	return JSON.stringify([
		settings.get("extensions") ?? [],
		settings.get("disabledExtensions") ?? [],
		settings.getGroup("skills"),
	]);
}

/**
 * Minimal daemon session host. Phase 3: createAgentSession is called lazily on
 * session.create; history sessions (idle-closed or pre-restart) are
 * reactivated on demand by session.subscribe / session.send so the GUI can
 * continue old conversations; events fan out to subscribers as
 * SessionStreamEvent envelopes (kind+seq, payload by reference — see
 * @musepi/sdk events).
 */
export class DaemonSessionHost {
	readonly #sessions = new Map<string, LiveSession>();
	/** Callback invoked when an extension pushes a notification channel message.
	 *  Wired by DaemonServer constructor to broadcast to GUI clients. */
	#onExtensionNotification: ((channel: string, message: ExtensionNotificationMessage) => void) | undefined;
	/** In-flight history-session reactivations (dedupe concurrent subscribe/send). */
	readonly #activating = new Map<string, Promise<LiveSession>>();
	/** Serializes top-level session bootstraps. Two concurrent createAgentSession
	 *  calls both default to agentId "Main" on the process-global AgentRegistry,
	 *  and the loser's pre-registration CAS fails with 'Agent "Main" was replaced
	 *  during session initialization' (sdk.ts pre-registers the id before
	 *  construction). The GUI fires sessions.create / sessions.reopen and
	 *  provider/model RPCs concurrently on fresh roots, so this must hold. */
	#bootstrapChain: Promise<unknown> = Promise.resolve();
	/** In-flight ensureRegistry bootstrap (dedupes concurrent provider/model
	 *  RPCs); cleared on settle so a failed bootstrap can be retried. */
	#registryBootstrap: Promise<ModelRegistry | null> | null = null;
	/** Unique-per-invocation suffix for throwaway bootstrap agent ids. */
	#bootstrapCounter = 0;
	async #withSessionBootstrapLock<T>(fn: () => Promise<T>): Promise<T> {
		const prev = this.#bootstrapChain;
		let release!: () => void;
		const current = new Promise<void>(resolve => (release = resolve));
		this.#bootstrapChain = prev.then(
			() => current,
			() => current,
		);
		await prev.catch(() => {});
		try {
			return await fn();
		} finally {
			release();
		}
	}
	/** First live session's model registry — shared for provider/model RPCs
	 *  (login/logout/custom-model) that must work without a live session
	 *  (history sessions are resumed, not live). */
	#registry: ModelRegistry | null = null;
	/** Global settings instance (first live session's, reused for the
	 *  session-less settings.* RPCs — one config, one writer). */
	#settings: Settings | null = null;
	/** Read-only session-create discoveries (settings, model registry, context
	 *  files, prompt templates, slash commands, skills, extension paths),
	 *  cached per (cwd, agentDir) so every session.create after the first
	 *  skips the re-scan. Invalidated by mtime changes of the scanned roots
	 *  plus a settings-input fingerprint (skills/extensions toggles). */
	readonly #discoveryCache = new Map<
		string,
		{ mtimeKey: string; fingerprint: string; value: CachedSessionDiscovery }
	>();
	/** Process-level MCP managers, one per session cwd — project MCP config
	 *  (.mcp.json / mcp.json discovery) is cwd-scoped, so sessions rooted at
	 *  different directories must not share a manager (a manager discovered
	 *  against the first cwd would silently drop the others' servers). Each
	 *  manager runs exactly one discovery + one set of server subprocesses.
	 *  Owned by the host: created lazily on the first session.create /
	 *  session.resume for a cwd, disconnected on host.dispose — never
	 *  per-session (sessions pass it via options.mcpManager, so the sdk's
	 *  owned-manager disconnect is skipped). */
	readonly #mcpManagers = new Map<string, MCPManager>();
	/** Extension-contributed settings (registerSetting), cached at the host
	 *  level so the settings panel shows them even without a live session
	 *  (the owning extension registers at session creation; the cache
	 *  survives session close). */
	readonly #extensionSettings = new Map<string, { setting: ExtensionSetting; extensionPath: string }>();
	readonly #options: DaemonOptions;
	readonly #store: ViewStore;
	/** Daemon collab share provider (set by DaemonServer on construction) —
	 *  lets session.create/activate inject the `collab` tool handle into
	 *  agent sessions. Absent in host-only tests. */
	#collabToolProvider: (() => CollabToolHandle) | null = null;
	setCollabToolProvider(provider: () => CollabToolHandle): void {
		this.#collabToolProvider = provider;
	}
	/** Scheduled-task bridge for the `schedule_task` tool (issue #11). The
	 *  cron store lives on DaemonServer, so the host gets a provider rather
	 *  than reaching into another instance's state.
	 *
	 *  The provider receives the requesting session's workspace (issue #30):
	 *  a long-lived daemon's `process.cwd()` is its launch directory (the
	 *  install path / home), so defaulting tasks to it silently detached
	 *  them from the project the user was actually working in. */
	#scheduledTaskProvider: ((sessionCwd: string) => ScheduledTaskHandle) | null = null;
	setScheduledTaskProvider(provider: (sessionCwd: string) => ScheduledTaskHandle): void {
		this.#scheduledTaskProvider = provider;
	}
	setOnExtensionNotification(handler: (channel: string, message: ExtensionNotificationMessage) => void): void {
		this.#onExtensionNotification = handler;
	}
	/** Workspace file-content index (settings → 索引库 → 代码库); lazily
	 *  created on first index.* RPC so a daemon that never opens the tab
	 *  pays nothing. */
	#fileIndex: FileIndexService | null = null;
	#idleScanner: ReturnType<typeof setInterval> | null = null;
	/** Shared per-daemon event bus — every AgentSession is created with it so
	 *  subagent progress/lifecycle channels (task tool) are observable here
	 *  and can ride the GUI stream. */
	readonly #eventBus = new EventBus();
	/** TTL cache of the SDK session-dir scan (history rows the view-store
	 *  never journaled). Refreshed on demand; 10s covers GUI list refreshes
	 *  without re-scanning the whole session dir per request. */
	#historyCache: { at: number; rows: SessionInfo[] } | null = null;
	/** Per-connection event coalescers (transport backpressure + batch
	 *  frames). Created lazily on first envelope, drained and dropped on
	 *  disconnect. */
	readonly #batchers = new Map<string, EventBatcher>();
	/** Agent turn finished (agent_end) — DaemonServer wires channel reply
	 *  pushes + task-completion channel pushes here. The event carries the
	 *  final transcript (last assistant message = the reply a channel peer
	 *  is waiting for). */
	onAgentEnd: ((live: LiveSession, event: Extract<AgentEvent, { type: "agent_end" }>) => void) | null = null;
	constructor(options: DaemonOptions = {}) {
		this.#options = options;
		this.#store = new ViewStore(viewStorePath(JOURNAL_DIR));
		this.#idleScanner = setInterval(() => this.#scanIdle(), IDLE_SCAN_INTERVAL_MS);
		this.#idleScanner.unref?.();
	}

	/**
	 * Read-only session-create discoveries for (cwd, agentDir), recomputed
	 * when the scanned roots' mtimes or the settings-driven inputs change.
	 * The FIRST session per key computes everything; subsequent creates reuse
	 * the cached values and pass them via createAgentSession options (the
	 * sdk short-circuits each discovery when the option is present).
	 */
	async #discoveryFor(cwd: string, agentDir: string): Promise<CachedSessionDiscovery> {
		const key = `${cwd}\u0000${agentDir}`;
		const [mtimeKey, cached] = [await discoveryMtimeKey(cwd, agentDir), this.#discoveryCache.get(key)];
		if (cached && cached.mtimeKey === mtimeKey) {
			if (discoverySettingsFingerprint(cached.value.settings) === cached.fingerprint) {
				return cached.value;
			}
		}
		const value = await this.#runDiscovery(cwd, agentDir);
		this.#discoveryCache.set(key, {
			mtimeKey,
			fingerprint: discoverySettingsFingerprint(value.settings),
			value,
		});
		return value;
	}

	/**
	 * Compute every read-only session-create discovery from scratch (first
	 * session per (cwd, agentDir), or a cache miss). Mirrors
	 * createAgentSessionScoped's construction so the cached values are
	 * identical to what a fresh session would have discovered — same
	 * parallelization and the authStorage pinned to the model registry.
	 * Lazy imports keep the daemon startup cheap (startDaemon prewarms the
	 * sdk module graph in the background, so this resolves instantly).
	 */
	async #runDiscovery(cwd: string, agentDir: string): Promise<CachedSessionDiscovery> {
		const { Settings } = await import("../config/settings");
		const settings = await logger.time("settings", Settings.init, { cwd, agentDir });
		const {
			discoverAuthStorage,
			discoverContextFiles,
			discoverPromptTemplates,
			discoverSessionExtensionPaths,
			discoverSkills,
			discoverSlashCommands,
		} = await import("../sdk");
		const { ModelRegistry } = await import("../config/model-registry");
		// Pin authStorage to modelRegistry.authStorage exactly like the sdk.
		const authStorage = await logger.time("discoverModels", discoverAuthStorage, agentDir);
		const modelRegistry = new ModelRegistry(authStorage);
		// The sdk kicks a background refresh when IT owns the registry; with a
		// shared registry the host owns that duty (idempotent per instance).
		modelRegistry.refreshInBackground();
		const skillsSettings = settings.getGroup("skills");
		const disabledExtensionIds = settings.get("disabledExtensions") ?? [];
		const [contextFiles, promptTemplates, slashCommands, discoveredSkills, extensionPaths] = await Promise.all([
			logger.time("discoverContextFiles", discoverContextFiles, cwd, agentDir),
			logger.time("discoverPromptTemplates", discoverPromptTemplates, cwd, agentDir),
			logger.time("discoverSlashCommands", discoverSlashCommands, cwd),
			logger.time("discoverSkills", () =>
				discoverSkills(cwd, agentDir, {
					...skillsSettings,
					disabledExtensions: disabledExtensionIds,
				}),
			),
			logger.time("discoverSessionExtensionPaths", () =>
				discoverSessionExtensionPaths(
					{ disableExtensionDiscovery: false, additionalExtensionPaths: [] },
					cwd,
					settings,
				),
			),
		]);
		return {
			cwd,
			agentDir,
			settings,
			modelRegistry,
			contextFiles,
			promptTemplates,
			slashCommands,
			skills: discoveredSkills.skills,
			extensionPaths,
		};
	}

	/**
	 * Build a process-level MCP manager for one session cwd (one discovery +
	 * one set of server subprocesses instead of one per session). Mirrors the
	 * sdk's deferred-UI construction (createAgentSessionScoped): MCPToolCache
	 * over the shared settings storage, auth storage pinning, notifications,
	 * and the single-slot tools-changed callback — the sdk skips its own
	 * setOnToolsChanged wiring when options.mcpManager is provided, so the
	 * host owns that slot and refreshes every live session.
	 */
	async #createSharedMCPManager(cwd: string, discovery: CachedSessionDiscovery): Promise<MCPManager> {
		// Lazy value import: the daemon keeps heavy module graphs out of
		// startup (MCP transports/subprocess plumbing pulled on first need).
		const { MCPManager, MCPToolCache } = await import("../mcp");
		const settings = discovery.settings;
		const cacheStorage = settings.getStorage();
		const manager = new MCPManager(cwd, cacheStorage ? new MCPToolCache(cacheStorage) : null);
		manager.setAuthStorage(discovery.modelRegistry.authStorage);
		if (settings.get("mcp.notifications")) {
			manager.setNotificationsEnabled(true);
		}
		manager.setOnToolsChanged(tools => this.#refreshMcpToolsOnSessions(tools));
		return manager;
	}

	/**
	 * Resolve (and lazily build) the MCP manager for a session cwd. The
	 * manager is created exactly once per cwd and its discovery+connect is
	 * started immediately so session.create never waits on MCP servers; tools
	 * arrive on live sessions through the tools-changed callback as servers
	 * connect. (Sessions are created serially by the GUI, so a concurrent
	 * duplicate build is not a real path.)
	 */
	async #ensureMcpManager(cwd: string, discovery: CachedSessionDiscovery): Promise<MCPManager> {
		const existing = this.#mcpManagers.get(cwd);
		if (existing) return existing;
		const manager = await this.#createSharedMCPManager(cwd, discovery);
		this.#mcpManagers.set(cwd, manager);
		this.#startSharedMCPDiscovery(manager, discovery);
		return manager;
	}

	/**
	 * Kick off MCP discovery + connect exactly once per manager, fire-and-
	 * forget, so session.create never waits on MCP servers. Tools arrive on
	 * live sessions through the manager's tools-changed callback as servers
	 * connect (mirrors the sdk's startDeferredMCPDiscovery async body,
	 * including the EXA_API_KEY env application and error logging).
	 */
	#startSharedMCPDiscovery(manager: MCPManager, discovery: CachedSessionDiscovery): void {
		const settings = discovery.settings;
		const startupQuiet = settings.get("startup.quiet");
		const onStatus = (event: McpConnectionStatusEvent): void => {
			if (startupQuiet) return;
			if (event.type === "connecting" && event.serverNames.length === 0) return;
			this.#eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, event);
		};
		void (async () => {
			try {
				const mcpResult = await logger.time("discoverAndLoadMCPTools", () =>
					manager.discoverAndConnect({
						onStatus,
						enableProjectConfig: settings.get("mcp.enableProjectConfig") ?? true,
						// Always filter Exa - we have native integration
						filterExa: true,
						// Filter browser MCP servers when builtin browser tool is active
						filterBrowser: settings.get("browser.enabled") ?? false,
					}),
				);
				// Exa keys ride the process env (applyMCPEnvironment parity).
				if (mcpResult.exaApiKeys.length > 0 && !Bun.env.EXA_API_KEY) {
					Bun.env.EXA_API_KEY = mcpResult.exaApiKeys[0];
				}
				for (const [serverName, error] of mcpResult.errors) {
					logger.error("MCP tool load failed", { path: `mcp:${serverName}`, error });
				}
				// Final push (sdk parity): servers that connected while no
				// live session existed would otherwise sit unrefreshed until
				// the next tools-changed event.
				await this.#refreshMcpToolsOnSessions(manager.getTools());
			} catch (error) {
				logger.error("MCP tool load failed", {
					path: ".mcp.json",
					error: error instanceof Error ? error.message : String(error),
				});
			}
		})();
	}

	/** Refresh the given MCP tool set on every live session (shared by the
	 *  manager's tools-changed callback and the post-discovery final push). */
	async #refreshMcpToolsOnSessions(tools: CustomTool[]): Promise<void> {
		for (const live of this.#sessions.values()) {
			if (live.agentSession.isDisposed) continue;
			try {
				await live.agentSession.refreshMCPTools(tools);
			} catch (error) {
				logger.warn("MCP tool refresh failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	/** Push the cwd-scoped MCP manager's already-connected tools into a
	 *  freshly adopted session (create during discovery, or resume after it). */
	#pushMcpToolsToSession(live: LiveSession): void {
		const manager = this.#mcpManagers.get(live.cwd);
		if (!manager || live.agentSession.isDisposed) return;
		const tools = manager.getTools();
		if (tools.length === 0) return;
		void live.agentSession.refreshMCPTools(tools).catch(error => {
			logger.warn("MCP tool refresh failed on session adopt", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}

	/** Disconnect every cwd-scoped MCP manager (daemon shutdown). Idempotent:
	 *  the maps are cleared before the async disconnects so a second dispose
	 *  is a no-op. */
	async #disposeSharedMCPManagers(): Promise<void> {
		const managers = [...this.#mcpManagers.values()];
		this.#mcpManagers.clear();
		await Promise.all(
			managers.map(async manager => {
				try {
					await manager.disconnectAll();
				} catch (error) {
					logger.error("MCP manager disconnect failed on daemon shutdown", {
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}),
		);
	}

	/** P0 自举:agent 扩展管理工具(extension_* 工具集)——实现见
	 *  extension-lifecycle-tools.ts(server.ts 不再承载)。
	 *  注入 createSession/activate 的 customTools,使 agent 能在会话内
	 *  自举扩展:写文件 → extension_load → 出错 → extension_status 自查 →
	 *  extension_reload 自修。 */
	#extensionManagerTools(): CustomTool[] {
		return createExtensionManagerTools(ctx => {
			const id = ctx.sessionManager.getSessionId();
			if (!id) return null;
			return this.get(id)?.agentSession ?? null;
		});
	}

	/** P2 动态自举:会话级动态插件工具链(ext_define/ext_run/ext_stop/
	 *  ext_undefine/ext_inspect)——实现见 extension-runtime-tools.ts。
	 *  每会话独立 registry,沙箱(vm)承载 host 半体。 */
	#dynamicRegistries = new Map<string, RuntimeToolRegistry>();

	#dynamicExtensionTools(): CustomTool[] {
		return createExtensionRuntimeTools(
			ctx => {
				const id = ctx.sessionManager.getSessionId();
				if (!id) return null;
				return this.get(id)?.agentSession ?? null;
			},
			ctx => {
				const id = ctx.sessionManager.getSessionId();
				let registry = this.#dynamicRegistries.get(id);
				if (!registry) {
					registry = new RuntimeToolRegistry();
					this.#dynamicRegistries.set(id, registry);
				}
				return registry;
			},
		);
	}

	async createSession(params: {
		cwd?: string;
		title?: string;
		forkOf?: string;
		autoTitle?: boolean;
		modelPattern?: string;
		thinkingLevel?: ConfiguredThinkingLevel;
		/** 会话预设(mode)id:v1 创建时应用(白名单/提示词/settings;docs/archive/modes-plan.md)。 */
		modeId?: string;
	}): Promise<{ sessionId: string }> {
		const cwd = path.resolve(params.cwd ?? this.#options.cwd ?? process.cwd());
		const parentId = params.forkOf && this.#sessions.has(params.forkOf) ? params.forkOf : null;
		// Lazy import keeps daemon startup cheap; createAgentSession owns the
		// full agent runtime bootstrap (settings, extensions, storage).
		const { createAgentSession } = await import("../sdk");
		const pauseGate = new AgentPauseGate();
		// Reuse the per-(cwd, agentDir) discovery cache so every session after
		// the first skips the read-only scans (settings, model registry,
		// context files, prompt templates, slash commands, skills, extension
		// paths). The cwd-scoped MCP manager is built lazily here too so each
		// daemon session gets one discovery + one set of server subprocesses
		// for its project's MCP config.
		const discovery = await this.#discoveryFor(cwd, getAgentDir());
		const mcpManager = await this.#ensureMcpManager(cwd, discovery);
		// Owned subagent frames must be tagged with this session's id so the
		// per-session stream fan-out routes them here only. session.create
		// mints the id inside createAgentSession, so bind it after adoption.
		const sessionBus = new SessionScopedEventBus(this.#eventBus, "");
		const result = await this.#withSessionBootstrapLock(async () =>
			createAgentSession({
				cwd,
				hasUI: true,
				interfaceLabel: "desktop (GUI)",
				eventBus: sessionBus,
				pauseGate,
				settings: discovery.settings,
				modelRegistry: discovery.modelRegistry,
				contextFiles: discovery.contextFiles,
				promptTemplates: discovery.promptTemplates,
				slashCommands: discovery.slashCommands,
				skills: discovery.skills,
				preloadedExtensionPaths: discovery.extensionPaths,
				mcpManager,
				// P0 自举:agent 扩展管理工具(extension_* 工具集)。
				customTools: [...this.#extensionManagerTools(), ...this.#dynamicExtensionTools()],
				collabTool: this.#collabToolProvider?.(),
				scheduledTasks: this.#scheduledTaskProvider?.(cwd) ?? undefined,
				...(await desktopSessionPromptInputs(cwd)),
				...(params.modelPattern ? { modelPattern: params.modelPattern } : {}),
				...(params.thinkingLevel ? { thinkingLevel: params.thinkingLevel } : {}),
				...(params.modeId ? { modeId: params.modeId } : {}),
			}),
		);
		const live = await this.#adoptAgentSession(result.session, cwd, result.setToolUIContext, parentId, pauseGate);
		sessionBus.setSessionId(live.sessionId);
		// Extension-contributed settings (registerSetting): merge every loaded
		// extension's settings into the host-level cache AND the live session
		// so settings.schema surfaces them (the swarm style extension's
		// display.taskCardStyle) even after the session closes.
		for (const ext of result.extensionsResult?.extensions ?? []) {
			for (const [key, setting] of ext.settings) {
				live.extensionSettings.set(key, { setting, extensionPath: ext.path });
				this.#extensionSettings.set(key, { setting, extensionPath: ext.path });
			}
		}
		live.autoTitle = params.autoTitle !== false;
		// 落创建时的预设:SDK 的 create 只把 modeId 用于 resolve(提示词/
		// settings/扩展白名单),不写会话头,而 live.modeId 是 adopt 时从 SDK
		// 头读的 —— 于是从空态 chip 选"设计模式"进的会话 modeId 恒为
		// undefined,session.modes 返回 null,Composer 的 design 风格 chip
		// 永远不显示。这里补 live + 快照头两级,兼顾当次会话与重激活。
		if (params.modeId) {
			live.modeId = params.modeId;
			// schedulePersist 只在首个事件后才落盘,这里先 upsert 一次,
			// 否则 persistHeaderPatch 的 load() 拿到空、写入静默失败。
			this.#store.upsert(live.sessionId, live.view.snapshot(), parentId);
			this.persistHeaderPatch(live.sessionId, { modeId: params.modeId });
		}
		return { sessionId: live.sessionId };
	}

	/**
	 * Reactivate a history session (idle-closed or pre-restart): bind a fresh
	 * AgentSession to the persisted SDK transcript, then re-attach the daemon
	 * journal/materialized view so the session streams and accepts sends
	 * again. Throws `Unknown session` when no transcript exists.
	 */
	async activate(sessionId: string): Promise<LiveSession> {
		const inFlight = this.#activating.get(sessionId);
		if (inFlight) return inFlight;
		const pending = this.#doActivate(sessionId).finally(() => this.#activating.delete(sessionId));
		this.#activating.set(sessionId, pending);
		return pending;
	}

	async #doActivate(sessionId: string): Promise<LiveSession> {
		const cwd = this.#options.cwd ?? process.cwd();
		// Same resolution the CLI `--continue <id>` uses: the local session
		// dir first, then a global scan — covers daemons restarted from a
		// different cwd. Lazy import: session-listing pulls the full session
		// scan machinery, which the daemon doesn't need at boot.
		const { resolveResumableSession } = await import("../session/session-listing");
		const match = await resolveResumableSession(sessionId, cwd);
		if (!match) throw new Error(`Unknown session: ${sessionId}`);
		// Lazy import: SessionManager is the interactive runtime's manager —
		// only resume paths need it (same rationale as createSession's SDK).
		const { SessionManager } = await import("../session/session-manager");
		const manager = await SessionManager.open(match.session.path, undefined, undefined, {
			suppressBreadcrumb: true,
		});
		const { createAgentSession } = await import("../sdk");
		// Rehydrate a persisted pause: a session archived (idle-close/restart)
		// while paused comes back frozen, so a long sleep never silently
		// releases the user's pause.
		const pauseGate = new AgentPauseGate(await readPauseSidecar(sessionId, JOURNAL_DIR));
		const resumeCwd = match.session.cwd || cwd;
		// Same per-(cwd, agentDir) discovery cache as createSession; the
		// cwd-scoped MCP manager may already exist (or is built here on first
		// need) so resumed sessions reuse the same server subprocesses.
		const discovery = await this.#discoveryFor(resumeCwd, getAgentDir());
		const mcpManager = await this.#ensureMcpManager(resumeCwd, discovery);
		const result = await this.#withSessionBootstrapLock(async () =>
			createAgentSession({
				cwd: resumeCwd,
				sessionManager: manager,
				hasUI: true,
				interfaceLabel: "desktop (GUI)",
				eventBus: new SessionScopedEventBus(this.#eventBus, sessionId),
				pauseGate,
				settings: discovery.settings,
				modelRegistry: discovery.modelRegistry,
				contextFiles: discovery.contextFiles,
				promptTemplates: discovery.promptTemplates,
				slashCommands: discovery.slashCommands,
				skills: discovery.skills,
				preloadedExtensionPaths: discovery.extensionPaths,
				mcpManager,
				// P0 自举:agent 扩展管理工具(extension_* 工具集)。
				customTools: [...this.#extensionManagerTools(), ...this.#dynamicExtensionTools()],
				collabTool: this.#collabToolProvider?.(),
				scheduledTasks: this.#scheduledTaskProvider?.(resumeCwd) ?? undefined,
				...(await desktopSessionPromptInputs(resumeCwd)),
			}),
		);
		// The resumed manager adopts the transcript's header id; a mismatch
		// means the file wasn't the requested session after all.
		if (result.session.sessionId !== sessionId) {
			await result.session.dispose?.();
			throw new Error(`Unknown session: ${sessionId}`);
		}
		return this.#adoptAgentSession(result.session, resumeCwd, result.setToolUIContext, null, pauseGate);
	}

	/**
	 * Wire a booted AgentSession into the live map: GUI approval gate, shared
	 * registry/settings, daemon journal + materialized view, event fan-out to
	 * subscribers and the idle auto-close timer. Shared by createSession
	 * (fresh) and activate (resumed history).
	 */
	async #adoptAgentSession(
		agentSession: AgentSession,
		cwd: string,
		setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void,
		parentId: string | null = null,
		pauseGate: AgentPauseGate,
	): Promise<LiveSession> {
		// GUI approval gate: enable UI so the wrapper's approval select is
		// reachable, then inject the bridge context that pauses tool calls
		// until a GUI client answers via tool.approve / tool.deny.
		const approvals = createApprovalBridge(
			record => {
				for (const send of live.subscribers.values()) {
					try {
						send({
							kind: "approval-request",
							seq: ++live.seq,
							// `prompt` = the full formatApprovalPrompt body
							// (Allow tool / Reason / command+args details) so
							// GUI cards show what is actually being approved —
							// tool name alone is not enough to decide.
							payload: { requestId: record.requestId, tool: record.tool, args: null, prompt: record.prompt },
						});
					} catch {
						// subscriber socket died; removed on close
					}
				}
			},
			record => {
				// ask tool questions / custom input (TUI ask parity): push the
				// question card to every GUI subscriber; they answer via
				// session.askAnswer.
				for (const send of live.subscribers.values()) {
					try {
						send({ kind: "ask-request", seq: ++live.seq, payload: askRequestPayload(record) });
					} catch {
						// subscriber socket died; removed on close
					}
				}
			},
		);
		setToolUIContext(approvals.uiContext, true);
		// Keep the first session's registry for provider/model management RPCs
		// that legitimately run outside any live session.
		this.#registry ??= agentSession.modelRegistry;
		this.#settings ??= agentSession.settings as unknown as Settings;
		const sessionId = agentSession.sessionId ?? `session-${Date.now()}`;
		const journal = new AppendJournal(JOURNAL_DIR, sessionId);
		await journal.open();
		// Materialized view: prefer the persisted snapshot (restart path),
		// degrade to a journal replay when the cache is absent or stale
		// (journal is authoritative).
		const persisted = this.#store.load(sessionId);
		let view = persisted ? MaterializedView.fromSnapshot(sessionId, cwd, persisted) : null;
		// The SDK transcript is authoritative for resumed sessions: the
		// AgentSession replayed it into memory, and the daemon journal/view-
		// store can hold a stale fork (session continued elsewhere, daemon
		// restarted between runs). Prefer the in-memory entries so the GUI
		// shows exactly what the agent sees.
		const sdkEntries = (agentSession.sessionManager as { getEntries?: () => SessionEntry[] } | null)?.getEntries?.();
		if (sdkEntries && sdkEntries.length > 0) {
			// SDK 条目 id/parentId 是 hex 树空间;MaterializedView 的条目身份
			// 是 messageKey("role:timestamp",live wire seam 同款)。不转换就
			// 混入两种 id 空间:branchChildren/面包屑/leafPath 全按 hex 找
			// messageKey,三层树 UI 在历史会话上全部失效。这里统一 rekey
			// (id → messageKey,parentId → 父条目的 messageKey)。
			const byHex = new Map(sdkEntries.map(e => [e.id, e]));
			// Messages link to their nearest MESSAGE ancestor: the SDK leaf at
			// append time may be a non-message entry (model_change / custom /
			// thinking_level_change), so a message's hex parentId can point at
			// one — walking up keeps the /tree projection connected (scattered
			// single-node trees otherwise) in both the canvas and the
			// trajectory tree.
			const nearestMessageOf = (startId: string | null | undefined): WireMessage | null => {
				let cur = startId ? byHex.get(startId) : null;
				const seen = new Set<string>();
				while (cur && !seen.has(cur.id)) {
					seen.add(cur.id);
					const m = (cur as { message?: WireMessage }).message;
					if (cur.type === "message" && m) return m;
					cur = cur.parentId ? byHex.get(cur.parentId) : null;
				}
				return null;
			};
			const viewEntries = sdkEntries.map(e => {
				const msg = (e as { message?: WireMessage }).message;
				if (e.type !== "message" || !msg) return e;
				const key = messageKey(msg);
				const parentMsg = nearestMessageOf(e.parentId);
				return {
					...e,
					id: key,
					parentId: parentMsg ? messageKey(parentMsg) : null,
				};
			});
			view =
				MaterializedView.fromSnapshot(sessionId, cwd, {
					entries: viewEntries,
					state: { isStreaming: false, queuedMessageCount: 0, cwd, participants: [] },
					// Single seq authority: the view cursor must live in the
					// journal numbering (it becomes the client's watermark and
					// the compaction checkpoint seq), not in the SDK entry
					// count — the transcript can hold entries the journal
					// never recorded and vice versa.
					cursor: journal.tailSeq,
					agents: [],
				}) ?? view;
		}
		if (!view) {
			// Journal replay path — honors a compaction checkpoint, then applies
			// increments above it (applies at/below the checkpoint seq are no-ops
			// for message/agent state, so a written-checkpoint-but-untrimmed
			// journal replays safely too).
			const { checkpoint, events } = await journal.replaySource();
			if (checkpoint || events.length > 0) {
				view = checkpoint
					? (MaterializedView.fromSnapshot(sessionId, cwd, checkpoint.snapshot) ??
						MaterializedView.replay(sessionId, cwd, events))
					: MaterializedView.replay(sessionId, cwd, events);
			} else {
				// SDK transcript fallback: a resumed CLI-created session was never
				// journaled by this daemon, so the materialized view would be
				// empty. Project the jsonl into the snapshot shape instead.
				const { resolveResumableSession } = await import("../session/session-listing");
				const match = await resolveResumableSession(sessionId, this.#options.cwd ?? "");
				if (match) {
					const projected = await snapshotFromJsonl(match.session.path, sessionId);
					view = MaterializedView.fromSnapshot(sessionId, match.session.cwd || cwd, projected);
				}
			}
		}
		// Fresh sessions (create path) have no journal/snapshot/transcript yet —
		// an empty view is legitimate. activate() already resolved the session
		// file before adopting, so reaching here without content means a brand
		// new session, not a missing one.
		view ??= MaterializedView.replay(sessionId, cwd, []);
		const viewFinal = view;
		let persistTimer: ReturnType<typeof setTimeout> | undefined;
		let eventsSinceCompactionCheck = 0;
		const schedulePersist = (): void => {
			if (persistTimer) return;
			// Throttle: high-frequency streaming events coalesce into one write.
			persistTimer = setTimeout(() => {
				persistTimer = undefined;
				try {
					this.#store.upsert(sessionId, viewFinal.snapshot(), parentId);
				} catch (error) {
					// Persistence is best-effort fire-and-forget: the journal +
					// SDK file remain authoritative. A transient write failure
					// (lock contention, disk pressure) must NOT crash the daemon.
					logger.error(`view-store persist failed: ${String(error)}`);
				}
			}, 100);
		};
		const live: LiveSession = {
			sessionId,
			cwd,
			agentSession,
			extensionSettings: new Map(),
			autoTitle: true,
			// 预设 id:SDK 头优先(热切换 setMode 的落盘值),缺失时回落到
			// 守护进程快照头 —— SDK 的 create 只 resolve 提示词/settings,
			// 从不把 modeId 写进 JSONL 头,所以仅读 SDK 头会让空态 chip 选的
			// design 会话在重启/重激活后丢掉预设(GUI 的 design 风格 chip 不显示)。
			modeId: agentSession.sessionManager?.getHeader()?.modeId ?? persisted?.header?.modeId ?? undefined,
			// Non-journaled envelope kinds count from 0 (see LiveSession.seq) —
			// the journal owns the kind:"event" seq space outright.
			seq: 0,
			journal,
			view: viewFinal,
			subscribers: new Map(),
			activeToolCalls: new Map(),
			subagentProgress: new Map(),
			lastActivity: Date.now(),
			idleTimer: null,
			recapTimer: null,
			recapAbort: null,
			editorDraft: false,
			approvals,
			pauseGate,
			publishApproval: record => {
				for (const send of live.subscribers.values()) {
					try {
						send({
							kind: "approval-request",
							seq: ++live.seq,
							// `prompt` = the full formatApprovalPrompt body
							// (Allow tool / Reason / command+args details) so
							// GUI cards show what is actually being approved —
							// tool name alone is not enough to decide.
							payload: { requestId: record.requestId, tool: record.tool, args: null, prompt: record.prompt },
						});
					} catch {
						// subscriber socket died; removed on close
					}
				}
			},
			// Broadcast a wire event (journal + materialized view + subscribers)
			// without touching agent state. Used by RPC paths whose side effects
			// are already recorded in the session (e.g. session.bashCommand: the
			// BashRunner appended the bashExecution message itself; the GUI
			// transcript still needs the message_start/end events to fold it in).
			publishWireEvent: (
				event: Parameters<typeof AgentSession.prototype.subscribe>[0] extends (e: infer E) => void ? E : never,
			) => {
				trackActiveToolCall(event);
				const wireEvent = toWireAgentEvent(event);
				if (!wireEvent) return;
				// Journal = single seq authority: the broadcast seq IS the
				// journal record seq, so a client watermark always compares in
				// one numbering space (catchup replays the same records).
				const seq = live.journal ? live.journal.append(wireEvent) : ++live.seq;
				live.view.apply(wireEvent);
				schedulePersist();
				for (const send of live.subscribers.values()) {
					try {
						send({ kind: "event", seq, payload: wireEvent });
					} catch {
						// subscriber socket died; removed on close
					}
				}
			},
			dispose: () => {
				this.#cancelIdleRecap(live);
				unsubscribeName();
				unsubscribeProgress();
				unsubscribeLifecycle();
				unsubscribePauseGate();
				if (persistTimer) {
					clearTimeout(persistTimer);
					persistTimer = undefined;
				}
				try {
					this.#store.upsert(sessionId, viewFinal.snapshot(), parentId);
				} catch (error) {
					// See schedulePersist: best-effort persistence must not
					// crash the daemon during session teardown either.
					console.error(`[daemon] view-store persist failed on dispose: ${String(error)}`);
				}
				void journal.close();
				// Fire-and-forget, but never into a void: a mid-turn dispose
				// must not kill the daemon via an unhandled rejection from
				// the agent teardown.
				void agentSession.dispose().catch(error => {
					console.error(`[daemon] agent session dispose failed: ${String(error)}`);
				});
			},
		};
		// Subscribe-time hydration ledger: retain currently-executing tool
		// calls so a GUI re-subscribe can restore the composer's running-tool
		// visuals (the tool_execution_* envelopes are stream-only — a fresh
		// client store would otherwise start blank until the next tool fires).
		const trackActiveToolCall = (event: {
			type?: string;
			toolCallId?: unknown;
			toolName?: unknown;
			args?: unknown;
			intent?: unknown;
			partialResult?: unknown;
		}): void => {
			switch (event.type) {
				case "tool_execution_start":
					if (typeof event.toolCallId === "string") {
						live.activeToolCalls.set(event.toolCallId, {
							toolCallId: event.toolCallId,
							toolName: typeof event.toolName === "string" ? event.toolName : "unknown",
							args: event.args,
							intent: typeof event.intent === "string" ? event.intent : undefined,
							startedAt: Date.now(),
						});
					}
					break;
				case "tool_execution_update": {
					if (typeof event.toolCallId !== "string") break;
					const tracked = live.activeToolCalls.get(event.toolCallId);
					if (tracked) tracked.partialResult = event.partialResult;
					break;
				}
				case "tool_execution_end":
					if (typeof event.toolCallId === "string") live.activeToolCalls.delete(event.toolCallId);
					break;
			}
		};
		live.idleTimer = setTimeout(() => this.#onIdleTimeout(sessionId), IDLE_TIMEOUT_MS);
		live.idleTimer.unref?.();
		// Subagent progress/lifecycle (task tool) rides the GUI stream. The
		// EventBus channels are per-daemon shared: session-scoped emitters
		// tag payloads with the owning session id (SessionScopedEventBus), so
		// each LiveSession forwards ONLY its own frames — without the filter,
		// session A's swarm visuals leak into session B's stream (the
		// subscriber wrapper stamps every envelope with the SUBSCRIBED
		// session id, so the client-side guard cannot catch these). Untagged
		// payloads keep the legacy broadcast behavior. Latest progress frames
		// are retained per agent for subscribe-time hydration.
		const ownsSubagentPayload = (payload: unknown): boolean => {
			const tagged = taggedSessionIdOf(payload);
			return tagged === undefined || tagged === sessionId;
		};
		const onSubagentProgress = (raw: unknown): void => {
			if (!ownsSubagentPayload(raw)) return;
			const payload = raw as SubagentProgressPayload;
			const progressId = payload.progress?.id;
			if (typeof progressId === "string") live.subagentProgress.set(progressId, payload);
			const seq = ++live.seq;
			for (const send of live.subscribers.values()) {
				try {
					send({ kind: "agent-progress", seq, payload });
				} catch {
					// subscriber socket died; removed on close
				}
			}
		};
		const onSubagentLifecycle = (raw: unknown): void => {
			if (!ownsSubagentPayload(raw)) return;
			const payload = raw as SubagentLifecyclePayload;
			// Terminal lifecycle: drop the retained progress so a later
			// re-subscribe hydrates only still-running agents.
			if (payload.status !== "started") live.subagentProgress.delete(payload.id);
			const seq = ++live.seq;
			for (const send of live.subscribers.values()) {
				try {
					send({ kind: "agent-lifecycle", seq, payload });
				} catch {
					// subscriber socket died; removed on close
				}
			}
		};
		const unsubscribeProgress = this.#eventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, onSubagentProgress);
		const unsubscribeLifecycle = this.#eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, onSubagentLifecycle);
		// Auto-generated titles land async after the first user message (TUI
		// parity, see maybeStartTitleGeneration in session.send). The GUI has
		// no other way to learn the tree label changed, so broadcast a
		// lightweight `title` envelope to this session's subscribers.
		const onSessionNameChanged = (): void => {
			const title = agentSession.sessionManager.getSessionName() ?? null;
			const seq = ++live.seq;
			for (const send of live.subscribers.values()) {
				try {
					send({ kind: "title", seq, payload: { title } });
				} catch {
					// subscriber socket died; removed on close
				}
			}
		};
		const unsubscribeName = agentSession.sessionManager.onSessionNameChanged(onSessionNameChanged);
		agentSession.subscribe(event => {
			// Only wire-compatible events cross the daemon boundary — the
			// journal, the live stream and the SDK contract share one format.
			if (!isWireAgentEvent(event)) return;
			trackActiveToolCall(event);
			// Real agent work refreshes the idle-dispose clock (issue #16): a
			// 20-minute bash run or an autonomous Goal round is activity even
			// though the user never sent another message.
			if (
				event.type === "agent_start" ||
				event.type === "turn_start" ||
				event.type === "agent_end" ||
				event.type === "tool_execution_start" ||
				event.type === "tool_execution_end"
			) {
				this.#noteActivity(sessionId);
			}
			// New activity cancels the idle recap (TUI parity: a fresh turn,
			// user message or compaction supersedes it). Passive frames —
			// streaming updates, tool progress, notices, retries — do NOT,
			// or a post-agent_end notice would kill the recap we just armed.
			if (
				event.type === "agent_start" ||
				event.type === "turn_start" ||
				event.type === "message_start" ||
				event.type === "tool_execution_start" ||
				event.type === "auto_compaction_start"
			) {
				this.#cancelIdleRecap(live);
			}
			// A finished turn re-arms it for the next idle window.
			if (event.type === "agent_end") {
				this.#scheduleIdleRecap(live);
				this.onAgentEnd?.(live, event);
			}
			// Live 消息树 seam(/tree 语义,2026-08-21):wire 事件在消息发射时尚未入树
			// (agent.appendMessage 先发事件、sessionManager.appendMessage 后插入),此
			// 刻 sessionManager.leafId() 即该消息的父节点——打标后 wire 事件携带
			// parentId 直达 GUI(MaterializedView 保留 message.parentId),GUI 侧
			// lib/message-tree.ts 即可重建会话内条目树。旧/持久化消息自带 parentId
			// 时原样保留(??= 只补缺省)。
			if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
				const m = event.message as { role?: string; parentId?: string | null } | null;
				if (
					m !== null &&
					typeof m === "object" &&
					(m.role === "user" || m.role === "assistant" || m.role === "toolResult") &&
					m.parentId === undefined
				) {
					// The leaf id is the SDK entry id (generateId hex), but the
					// materialized view keys its entries by messageKey
					// ("role:timestamp") — convert so the GUI tree can actually
					// link parent ↔ child across the two id spaces.
					const mgr = agentSession.sessionManager as unknown as {
						getLeafEntry(): { type?: string; message?: WireMessage; parentId?: string | null } | undefined;
						getEntries?(): Array<{
							id: string;
							type?: string;
							message?: WireMessage;
							parentId?: string | null;
						}>;
					} | null;
					const parentEntry = mgr?.getLeafEntry();
					let parentMsg: WireMessage | null = null;
					if (parentEntry) {
						if (parentEntry.type === "message" && parentEntry.message) {
							parentMsg = parentEntry.message;
						} else {
							// The leaf is a non-message entry (model_change /
							// custom / thinking_level_change): the new message's
							// parentId must point at the nearest MESSAGE ancestor
							// so the /tree projection stays connected (scattered
							// single-node trees otherwise). Rare path — build the
							// hex map only here.
							const entries = mgr?.getEntries?.() ?? [];
							const byHex = new Map(entries.map(e => [e.id, e]));
							let cur = parentEntry.parentId ? byHex.get(parentEntry.parentId) : undefined;
							const seen = new Set<string>();
							while (cur && !seen.has(cur.id)) {
								seen.add(cur.id);
								if (cur.type === "message" && cur.message) {
									parentMsg = cur.message;
									break;
								}
								cur = cur.parentId ? byHex.get(cur.parentId) : undefined;
							}
						}
					}
					m.parentId = parentMsg ? messageKey(parentMsg) : null;
				}
			}
			const wireEvent = toWireAgentEvent(event);
			if (!wireEvent) return;
			// Journal = single seq authority: broadcast seq == journal record
			// seq (see publishWireEvent).
			const seq = live.journal ? live.journal.append(wireEvent) : ++live.seq;
			live.view.apply(wireEvent);
			schedulePersist();
			// Compact when the journal crosses a bound: fold the materialized
			// snapshot into a checkpoint and trim. Checked amortized (every
			// 200th event) so the read is cheap.
			eventsSinceCompactionCheck += 1;
			if (eventsSinceCompactionCheck >= 200 && live.journal) {
				eventsSinceCompactionCheck = 0;
				void live.journal
					.shouldCompact()
					.then(needed => {
						if (needed && live.journal) return live.journal.compact(live.journal.tailSeq, live.view.snapshot());
					})
					.catch(err => {
						// A failed compaction (e.g. transient Windows EPERM on
						// journal replace) must never bubble into the process
						// unhandledRejection postmortem — that kills the daemon
						// and drops every live session. Log and move on; the
						// next 200-event check retries.
						logger.error("journal compaction failed", {
							sessionId: live.sessionId,
							error: err instanceof Error ? err.message : String(err),
						});
					});
			}
			for (const send of live.subscribers.values()) {
				try {
					send({ kind: "event", seq, payload: wireEvent });
				} catch {
					// subscriber socket died; removed on close
				}
			}
		});
		const unsubscribePauseGate = pauseGate.onChange(paused => {
			const seq = ++live.seq;
			const payload = { paused, pausedAt: pauseGate.pausedAt ?? null };
			// Persist the transition so reactivation (idle-archive or daemon
			// restart) can rehydrate the gate; absence = not paused.
			writePauseSidecar(live.sessionId, paused, pauseGate.pausedAt ?? null, JOURNAL_DIR);
			for (const send of live.subscribers.values()) {
				try {
					send({ kind: "pause-state", seq, payload });
				} catch {
					// subscriber socket died; removed on close
				}
			}
		});
		this.#sessions.set(sessionId, live);
		// This session's cwd-scoped MCP manager: tools connected before the
		// session existed (or while discovery was in flight) must land on it
		// now — the tools-changed callback only fires on FUTURE changes.
		this.#pushMcpToolsToSession(live);
		// Extension notification channels (P3): forward pushed messages to
		// the daemon server's broadcast. The subscriber is dropped when the
		// session closes (live is GC'd with the set); reload detaches the
		// channel atomically on the extension side.
		agentSession.extensionRunner?.onNotification((channel, message) => {
			this.#onExtensionNotification?.(channel, message);
		});
		return live;
	}

	sessions(): IterableIterator<string> {
		return this.#sessions.keys();
	}

	/** All live sessions (extension-settings collection, …). */
	allSessions(): IterableIterator<LiveSession> {
		return this.#sessions.values();
	}

	/** Extension-contributed settings (registerSetting), host-level cache —
	 *  populated on session creation, survives session close. */
	extensionSettings(): ReadonlyMap<string, { setting: ExtensionSetting; extensionPath: string }> {
		return this.#extensionSettings;
	}

	get(sessionId: string): LiveSession | undefined {
		return this.#sessions.get(sessionId);
	}

	/** Re-key a live host entry after an in-place session identity change
	 *  (btwBranch's createBranchedSession swaps the session id) so RPCs
	 *  under the NEW id resolve to the same live session. */
	rekeySession(oldId: string, newId: string): void {
		if (oldId === newId || !this.#sessions.has(oldId)) return;
		const live = this.#sessions.get(oldId);
		if (!live) return;
		this.#sessions.delete(oldId);
		this.#sessions.set(newId, live);
	}

	/** True when the daemon journal holds this session (journal-only or live). */
	hasJournal(sessionId: string): boolean {
		return this.#store.load(sessionId) !== undefined;
	}

	/** Compact workspace cards: live sessions first, then journal + SDK history. */
	async listWorkspaceSessions(): Promise<WorkspaceSessionInfo[]> {
		const rows = await this.knownSessions();
		const out: WorkspaceSessionInfo[] = [];
		for (const row of rows) {
			const live = this.#sessions.get(row.sessionId);
			const agentSession = live?.agentSession as
				| { isStreaming?: boolean; sessionName?: string; cwd?: string }
				| undefined;
			out.push({
				id: row.sessionId,
				title:
					(
						row.title ??
						(this.get(row.sessionId)?.autoTitle !== false
							? this.#store.firstUserMessage(row.sessionId)
							: undefined) ??
						undefined
					)?.slice(0, 80) ?? null,
				cwd: row.cwd || agentSession?.cwd || null,
				messageCount: row.messageCount,
				working: live?.pauseGate.paused === true ? false : (agentSession?.isStreaming ?? false),
				paused: live?.pauseGate.paused === true,
				live: live !== undefined,
				updatedAt: row.updatedAt,
			});
		}
		return out;
	}

	/**
	 * Directory-change notifications. Fires on the global event bus when any
	 * agent starts/ends (working flips) and on live-session open/close.
	 */
	subscribeWorkspaceChanges(cb: () => void): () => void {
		const onEvent = (event: unknown): void => {
			if (
				(event as { type?: string })?.type === "agent_start" ||
				(event as { type?: string })?.type === "agent_end"
			) {
				cb();
			}
		};
		return this.#eventBus.on("event", onEvent);
	}

	/** Shared model registry (from the first live session). */
	registry(): ModelRegistry | undefined {
		return this.#registry ?? undefined;
	}

	/**
	 * Persist a header patch for a HISTORY (non-live) session — live ones
	 * carry their choices in the AgentSession, so these writes only land on
	 * the materialized snapshot. Used by setModel / setThinkingLevel so a
	 * resumed session picks up the user's choice next time it runs.
	 */
	persistHeaderPatch(
		sessionId: string,
		patch: { model?: string; thinkingLevel?: string; modeId?: string | null },
	): boolean {
		const persisted = this.#store.load(sessionId);
		if (!persisted) return false;
		persisted.header = { ...persisted.header, ...patch };
		this.#store.upsert(sessionId, persisted);
		return true;
	}

	/**
	 * Ensure the shared registry exists, lazily booting a minimal session
	 * (kept only long enough to extract the registry) when no live session
	 * has been created yet — history-only GUI starts never create one.
	 */
	async ensureRegistry(): Promise<ModelRegistry | null> {
		if (this.#registry) return this.#registry;
		// Deduplicate concurrent bootstraps (the GUI fires several
		// provider/model RPCs at once on fresh roots): every caller awaits the
		// same in-flight promise, and the shared session-bootstrap lock
		// serializes this against a racing sessions.create.
		this.#registryBootstrap ??= this.#withSessionBootstrapLock(async () => {
			// Lazy import keeps daemon startup cheap (same rationale as
			// createSession): the registry bootstrap is only needed when
			// provider/model RPCs arrive without any live session ever having
			// been created.
			const { createAgentSession } = await import("../sdk");
			// Bootstrap as a SUBORDINATE agent on a throwaway UNIQUE id — never
			// top-level "Main": a main-kind bootstrap pre-registers the
			// process-global agent id (racing a concurrent sessions.create fails
			// that session with 'Agent "Main" was replaced during session
			// initialization'), and its dispose tears down
			// AgentLifecycleManager.global() under every live session. The id
			// must be unique PER INVOCATION too: two concurrent bootstraps on the
			// same fixed id fail each other the same way.
			const result = await createAgentSession({
				cwd: this.#options.cwd ?? process.cwd(),
				hasUI: false,
				parentTaskPrefix: `registry-bootstrap-${++this.#bootstrapCounter}`,
				eventBus: this.#eventBus,
			});
			this.#registry = result.session.modelRegistry;
			this.#settings ??= result.session.settings as unknown as Settings;
			await result.session.dispose?.();
			return this.#registry;
		}).finally(() => {
			this.#registryBootstrap = null;
		});
		return this.#registryBootstrap;
	}

	/** Global settings for the settings.* RPCs (null before any session). */
	settings(): Settings | null {
		return this.#settings;
	}

	/** Daemon working directory (notes/other project-scoped RPCs). */
	cwd(): string {
		return this.#options.cwd ?? process.cwd();
	}

	/**
			return view.cursor;
		// ever served through the live-session snapshot override, never
		// from the store.
		const snap = snapshot;
		if (snap && typeof snap === "object" && "state" in snap && snap.state && typeof snap.state === "object") {
			const state = snap.state as { isStreaming?: unknown; queuedMessageCount?: unknown };
			state.isStreaming = false;
			state.queuedMessageCount = 0;
		}
		this.#store.upsert(sessionId, snapshot as never);
	}

	/** Refresh a live session's idle clock (called on session.send). */
	touch(sessionId: string): void {
		const live = this.#sessions.get(sessionId);
		if (!live) return;
		live.lastActivity = Date.now();
		this.#cancelIdleRecap(live);
		this.#rearmIdleTimer(sessionId, live);
	}

	/**
	 * Activity ping from the agent loop (issue #16). Keeps the idle-dispose
	 * clock honest — a long tool call or an autonomous Goal round is real
	 * activity — WITHOUT cancelling a pending idle recap, which `touch` does.
	 */
	#noteActivity(sessionId: string): void {
		const live = this.#sessions.get(sessionId);
		if (!live) return;
		live.lastActivity = Date.now();
		this.#rearmIdleTimer(sessionId, live);
	}

	#rearmIdleTimer(sessionId: string, live: LiveSession): void {
		if (!live.idleTimer) return;
		clearTimeout(live.idleTimer);
		live.idleTimer = setTimeout(() => this.#onIdleTimeout(sessionId), IDLE_TIMEOUT_MS);
		live.idleTimer.unref?.();
	}

	/**
	 * Idle-timer expiry (issue #16): a session still running tools / streaming
	 * is NOT idle — re-arm instead of disposing. Without this the per-session
	 * timer killed background work on a fixed 30-minute schedule regardless of
	 * what the session was doing.
	 */
	#onIdleTimeout(sessionId: string): void {
		const live = this.#sessions.get(sessionId);
		if (!live) return;
		if (isLiveSessionBusy(live)) {
			live.lastActivity = Date.now();
			live.idleTimer = setTimeout(() => this.#onIdleTimeout(sessionId), IDLE_TIMEOUT_MS);
			live.idleTimer.unref?.();
			return;
		}
		this.close(sessionId);
	}

	/** Report the GUI composer's un-sent draft (recap editor-draft guard).
	 *  A present draft cancels any scheduled/in-flight recap; clearing it
	 *  does NOT re-arm — the next agent_end schedules again (TUI parity). */
	setEditorDraft(sessionId: string, draft: boolean): void {
		const live = this.#sessions.get(sessionId);
		if (!live) return;
		live.editorDraft = draft;
		if (draft) this.#cancelIdleRecap(live);
	}

	/**
	 * Close a live session: dispose the AgentSession, drop subscribers, remove
	 * from the live map. Journal + materialized view are retained — the session
	 * stays listed and resumable as snapshot-only history. Idempotent.
	 */
	close(sessionId: string): void {
		const live = this.#sessions.get(sessionId);
		if (!live) return;
		if (live.idleTimer) {
			clearTimeout(live.idleTimer);
			live.idleTimer = null;
		}
		this.#sessions.delete(sessionId);
		this.#dynamicRegistries.delete(sessionId);
		live.dispose();
	}

	#scanIdle(): void {
		const now = Date.now();
		// Policy lives in `idleDisposePlan` (pure, clock injected) — a working
		// session is never reaped here (issue #16).
		for (const id of idleDisposePlan(this.#sessions, now)) this.close(id);
	}

	/** Cancel the idle-recap timer and any in-flight recap turn. */
	#cancelIdleRecap(live: LiveSession): void {
		if (live.recapTimer) {
			clearTimeout(live.recapTimer);
			live.recapTimer = null;
		}
		if (live.recapAbort) {
			live.recapAbort.abort();
			live.recapAbort = null;
		}
	}

	/**
	 * Arm the idle recap after a finished turn (TUI event-controller parity):
	 * wait `recap.idleSeconds` of quiet, then run an ephemeral LLM summary.
	 */
	#scheduleIdleRecap(live: LiveSession): void {
		this.#cancelIdleRecap(live);
		if (live.agentSession.isCompacting) return;
		if (live.editorDraft) return;
		const recap = this.#settings?.getGroup("recap");
		if (!recap?.enabled) return;
		const seconds = Math.max(IDLE_RECAP_MIN_SECONDS, Math.min(IDLE_RECAP_MAX_SECONDS, recap.idleSeconds));
		live.recapTimer = setTimeout(() => {
			live.recapTimer = null;
			void this.#runIdleRecap(live);
		}, seconds * 1000);
		live.recapTimer.unref?.();
	}

	/**
	 * Generate the idle recap with an ephemeral side-channel turn (same
	 * pipeline as the TUI's recap-user.md prompt) and push it to subscribers
	 * as a `recap` envelope. Abortable: any wire activity cancels it, and
	 * idle conditions are re-checked before firing and after the reply lands
	 * so a stale recap never paints over fresh work.
	 */
	async #runIdleRecap(live: LiveSession): Promise<void> {
		if (!this.#idleRecapConditionsHold(live)) return;
		if (!live.agentSession.model) return;
		if (live.view.snapshot().entries.length === 0) return;

		// TUI parity anchors: the live goal objective (falling back to the
		// session title) and the first actionable todo task. AgentSession
		// exposes the same controller state modesOf() reads for the GUI badges.
		const modeSession = live.agentSession as unknown as ModeSessionLike;
		const goal =
			modeSession.getGoalModeState?.()?.goal?.objective?.trim() ||
			live.agentSession.sessionManager.getSessionName()?.trim() ||
			"";
		const task = nextActionableTask(modeSession.getTodoPhases?.() ?? [])?.content ?? "";
		// Follow the interface language (settings.locale): zh-CN recaps are
		// written in Chinese, en-US in English.
		const locale = this.#settings?.get("settings.locale") as string | undefined;
		const language = locale === "zh-CN" ? "Chinese (简体中文)" : undefined;
		const promptText = prompt.render(idleRecapPrompt, { goal, task, language });

		const abort = new AbortController();
		live.recapAbort = abort;
		try {
			const { replyText } = await live.agentSession.runEphemeralTurn({ promptText, signal: abort.signal });
			if (live.recapAbort !== abort || abort.signal.aborted || !this.#idleRecapConditionsHold(live)) return;
			const text = previewLine(replyText, TRUNCATE_LENGTHS.RECAP);
			if (!text) return;
			const seq = ++live.seq;
			const payload = { text, at: Date.now() };
			for (const send of live.subscribers.values()) {
				try {
					send({ kind: "recap", seq, payload });
				} catch {
					// subscriber socket died; removed on close
				}
			}
		} catch {
			// Recap is best-effort (same as the TUI's debug-level failure path).
		} finally {
			if (live.recapAbort === abort) live.recapAbort = null;
		}
	}

	/** Idle gate shared by the recap timer fire and its post-reply re-check. */
	#idleRecapConditionsHold(live: LiveSession): boolean {
		if (!this.#sessions.has(live.sessionId)) return false;
		if (live.agentSession.isStreaming) return false;
		if (live.agentSession.isCompacting) return false;
		if (live.editorDraft) return false;
		return true;
	}

	async snapshot(sessionId: string): Promise<Static<typeof sessionSnapshot>> {
		const live = this.#sessions.get(sessionId);
		if (live) {
			const snap = live.view.snapshot() as Static<typeof sessionSnapshot> & {
				state: {
					goalMode?: unknown;
					planMode?: unknown;
					todo?: unknown;
					isStreaming?: boolean;
					isCompacting?: boolean;
					modeId?: string;
					paused?: boolean;
					pausedAt?: number | null;
				};
			};
			// Live mode state rides along on the snapshot so the GUI badges
			// reflect goal/plan/todo without extra round-trips.
			const modes = modesOf(live.agentSession);
			snap.state.goalMode = modes.goalMode;
			snap.state.planMode = modes.planMode;
			snap.state.todo = modes.todo;
			snap.state.modeId = live.modeId;
			// Compaction state rides along too: the GUI's compaction status
			// line keys off the live getter (the view has no compaction event).
			snap.state.isCompacting = modes.isCompacting;
			// Pause gate state: the GUI badge and status lines key off it
			// without a separate round-trip.
			snap.state.paused = live.pauseGate.paused;
			snap.state.pausedAt = live.pauseGate.pausedAt ?? null;
			// The view's isStreaming flag is event-driven and can go stale
			// (abort paths never emit turn_end) — the agent's live getter is
			// authoritative for what the GUI should show as working.
			const agentLike = live.agentSession as unknown as { isStreaming?: boolean };
			if (typeof agentLike.isStreaming === "boolean") {
				snap.state.isStreaming = agentLike.isStreaming;
			}
			// Watermark stamp: clients gate catchup/gap recovery on the
			// journal tail, never on the view's applied-event count (the
			// SDK-transcript seed path can diverge from it). The branch is
			// fully synchronous, so the in-memory tail cannot race the
			// snapshot: every record ≤ tail is either in the snapshot or
			// arrives as a live envelope with seq > tail.
			snap.cursor = live.journal?.tailSeq ?? snap.cursor;
			return snap;
		}
		// History path: no running session — serve the persisted materialized
		// snapshot, degrading to a journal replay when the cache is absent.
		// Archived sessions are by definition idle: a stored isStreaming=true
		// (daemon shut down mid-stream) must never make the GUI show a phantom
		// working turn with an un-stoppable stop button.
		const archivedPause = await readPauseSidecar(sessionId, JOURNAL_DIR);
		// Watermark stamp: read the journal tail BEFORE building the view, so
		// a concurrent append can only push records ABOVE the stamped cursor —
		// the client then sees a (self-healing) gap and catchup replays the
		// overlap idempotently, instead of the stamp punching a silent hole
		// over records the snapshot never contained.
		const tail = await AppendJournal.readTailSeq(path.join(JOURNAL_DIR, `${sessionId}.journal.jsonl`));
		const idleHistory = (view: MaterializedView): Static<typeof sessionSnapshot> => {
			const snap = view.snapshot();
			snap.cursor = tail;
			snap.state.isStreaming = false;
			snap.state.queuedMessageCount = 0;
			// Paused state survives the archive via the sidecar: the GUI/TUI
			// keep showing the paused badge on archived sessions.
			snap.state.paused = archivedPause.paused;
			snap.state.pausedAt = archivedPause.pausedAt;
			return snap;
		};
		const persisted = this.#store.load(sessionId);
		if (persisted) {
			const headerCwd =
				persisted.header && typeof persisted.header === "object"
					? String((persisted.header as { cwd?: string }).cwd ?? "")
					: "";
			const view = MaterializedView.fromSnapshot(sessionId, headerCwd, persisted);
			if (view) return idleHistory(view);
		}
		const journal = new AppendJournal(JOURNAL_DIR, sessionId);
		await journal.open();
		try {
			const { checkpoint, events } = await journal.replaySource();
			if (checkpoint || events.length > 0) {
				const view = checkpoint
					? (MaterializedView.fromSnapshot(sessionId, "", checkpoint.snapshot) ??
						MaterializedView.replay(sessionId, "", events))
					: MaterializedView.replay(sessionId, "", events);
				return idleHistory(view);
			}
		} finally {
			void journal.close();
		}
		// SDK transcript fallback: sessions created by the CLI (or any session
		// the daemon never journaled) live as jsonl under the agent dir.
		// Project their events into the snapshot shape (the wire format differs
		// from the journal's stream events — `message` rows are final).
		const { resolveResumableSession } = await import("../session/session-listing");
		const match = await resolveResumableSession(sessionId, this.#options.cwd ?? "");
		if (!match) throw new Error(`Unknown session: ${sessionId}`);
		const fallback = await snapshotFromJsonl(match.session.path, sessionId);
		fallback.cursor = tail;
		return fallback;
	}

	/** Checkpoint seq for a session (0 when never compacted) — resume uses it
	 *  to signal compactedThrough. */
	async checkpointSeq(sessionId: string): Promise<number> {
		const ckpt = await AppendJournal.readCheckpoint(path.join(JOURNAL_DIR, `${sessionId}.journal.jsonl`));
		return ckpt?.seq ?? 0;
	}

	/**
	 * Catch-up deltas for a resume cursor: journal records with seq > cursor.
	 * Sends each as an event envelope on the connection (caller orders this
	 * after the resume response so the snapshot lands first).
	 *
	 * Pages the replay through the connection's event batcher (one frame per
	 * page) and yields between pages so a huge catch-up (long idle gap) never
	 * starves other connections' events or interactive RPC responses.
	 */
	async catchup(sessionId: string, cursor: number, conn: DaemonConnection): Promise<void> {
		const journal = new AppendJournal(JOURNAL_DIR, sessionId);
		await journal.open();
		try {
			const batcher = this.batcherFor(conn);
			let page = 0;
			for (const record of await journal.readAll()) {
				if (record.seq > cursor) batcher.push({ kind: "event", seq: record.seq, payload: record.event, sessionId });
				page += 1;
				if (page % CATCHUP_PAGE_SIZE === 0) {
					batcher.flushNow();
					// Yield to the event loop: pending RPC responses and other
					// connections' envelopes interleave between pages.
					const { promise, resolve } = Promise.withResolvers<void>();
					setImmediate(resolve);
					await promise;
				}
			}
			batcher.flushNow();
		} finally {
			void journal.close();
		}
	}

	/**
	 * session.catchup RPC core (roadmap M1.4 gap fill): replay every journal
	 * record with seq > afterSeq through the connection's event batcher, in
	 * journal order. The resync guards are the pure {@link catchupPlan}:
	 * afterSeq predating the compaction checkpoint, or ahead of the journal
	 * tail (divergent watermark), both answer `{resyncRequired}` WITHOUT
	 * pushing anything. Session identity IS the epoch: with restart-
	 * persistent seqs (journal open recovers the tail from the file), a
	 * cursor for this session id is always expressed in this journal's
	 * numbering.
	 */
	async catchupFrom(
		sessionId: string,
		afterSeq: number,
		conn: DaemonConnection,
	): Promise<{ ok: true } | { resyncRequired: true; compactedThrough: number }> {
		const live = this.#sessions.get(sessionId);
		const checkpointSeq = await this.checkpointSeq(sessionId);
		// Prefer the live journal: a fresh instance would miss appends whose
		// writes are still queued in the live instance's chain (readAll only
		// flushes its own instance).
		const journal = live?.journal ?? null;
		const plan = journal
			? catchupPlan(afterSeq, checkpointSeq, journal.tailSeq)
			: catchupPlan(afterSeq, checkpointSeq, await AppendJournal.readTailSeq(journalFilePath(sessionId)));
		if (plan.resyncRequired) return plan;
		if (!journal) {
			const detached = new AppendJournal(JOURNAL_DIR, sessionId);
			await detached.open();
			try {
				return await this.replayCatchup(sessionId, afterSeq, detached, conn);
			} finally {
				void detached.close();
			}
		}
		return this.replayCatchup(sessionId, afterSeq, journal, conn);
	}

	/** Replay loop for `catchupFrom`: journal records with seq > afterSeq,
	 *  in order, paged through the connection's batcher (see `catchup`).
	 *  Public so the M1.4 ordered-replay contract is testable with a
	 *  temp-dir journal without standing up a full daemon. */
	async replayCatchup(
		sessionId: string,
		afterSeq: number,
		journal: AppendJournal,
		conn: DaemonConnection,
	): Promise<{ ok: true }> {
		const batcher = this.batcherFor(conn);
		const records = await journal.recordsAfter(afterSeq);
		for (let i = 0; i < records.length; i++) {
			const record = records[i];
			batcher.push({ kind: "event", seq: record.seq, payload: record.event, sessionId });
			if ((i + 1) % CATCHUP_PAGE_SIZE === 0) {
				batcher.flushNow();
				// Yield to the event loop: pending RPC responses and other
				// connections' envelopes interleave between pages.
				const { promise, resolve } = Promise.withResolvers<void>();
				setImmediate(resolve);
				await promise;
			}
		}
		batcher.flushNow();
		return { ok: true };
	}

	/** All known sessions (live + persisted history) with queryable metadata. */
	/** Bust the SDK-session scan cache (session.forkAt writes a new file). */
	invalidateHistoryCache(): void {
		this.#historyCache = null;
	}

	async knownSessions(): Promise<
		(ReturnType<ViewStore["list"]>[number] & { liveCursor?: number; title?: string; status?: SessionStatus })[]
	> {
		const live = new Map<string, number>();
		for (const [id, s] of this.#sessions) live.set(id, s.view.cursor);
		const rows = this.#store.list();
		// SDK session-dir history (CLI-created transcripts the daemon never
		// journaled) — read-only scan, TTL-cached. Rows without a journal are
		// listed too so the GUI can resume them; `title` carries the jsonl
		// first-user-message fallback for the tree label.
		const { listAllSessions } = await import("../session/session-listing");
		let history = this.#historyCache;
		if (!history || Date.now() - history.at > 10_000) {
			const scan = await listAllSessions();
			history = { at: Date.now(), rows: scan };
			this.#historyCache = history;
		}
		const merged = new Map<string, MaterializedRow & { title?: string; status?: SessionStatus }>(
			rows.map(r => [r.sessionId, r]),
		);
		for (const h of history.rows) {
			const existing = merged.get(h.id);
			const first = h.firstMessage && h.firstMessage !== "(no messages)" ? h.firstMessage : undefined;
			if (existing) {
				// Store rows carry the snapshot header title only (persisted
				// before the async auto-title landed, or a create-time title).
				// Backfill the jsonl title slot when the stored title is empty
				// so daemon-restarted sessions keep their generated titles.
				if (!existing.title && h.title) existing.title = h.title;
				// Lifecycle status (complete/interrupted/aborted/error/pending)
				// comes from the jsonl tail — the store snapshot has no such
				// field, so the SDK scan is authoritative for it.
				if (!existing.status && h.status) existing.status = h.status;
				continue;
			}
			merged.set(h.id, {
				sessionId: h.id,
				cursor: 0,
				createdAt: h.created.getTime(),
				updatedAt: h.modified.getTime(),
				cwd: h.cwd,
				model: null,
				messageCount: h.messageCount,
				// SDK transcripts never carried a preset header until the
				// GUI chips landed — no mode to report for these.
				modeId: null,
				// SDK transcripts record forks under header.parentSession
				// (a session-file path) — derive the parent's id so the tree
				// renders branch structure (OMP /tree). Session files are
				// named "<timestamp>_<sessionId>.jsonl".
				parentId: h.parentSessionPath
					? path.basename(h.parentSessionPath, ".jsonl").split("_").slice(1).join("_") || null
					: null,
				// Title = the persisted title slot (auto-generated or /rename)
				// when present; SDK-transcript fallback is the first user
				// message. listAllSessions reads the slot now.
				title: h.title ?? first,
				status: h.status,
			});
		}
		const all = [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
		// Live sessions: the realtime session name wins over the store
		// snapshot — auto-generated titles land async after the first user
		// message (jsonl title slot + in-memory sessionName), long before any
		// snapshot persist would carry them. User /rename titles are the same
		// field, so they stay authoritative here too.
		for (const row of all) {
			const s = this.#sessions.get(row.sessionId);
			if (!s) continue;
			const name = s.agentSession.sessionManager.getSessionName();
			if (name) row.title = name;
			// Live preset wins: the in-memory modeId is what session.modes
			// reports, so the sidebar's hover card can never disagree with
			// the composer chips. The store column covers idle sessions.
			if (s.modeId) row.modeId = s.modeId;
		}
		// Persisted rows win on cursor (authoritative for history); live-only
		// sessions (pre-first-persist) fall back to the in-memory view.
		return all.map(r => ({
			...r,
			cursor: Math.max(r.cursor, live.get(r.sessionId) ?? 0),
		}));
	}

	/**
	 * Permanently delete a session: closes it if live, then removes the
	 * journal file (the single source of truth), the materialized query
	 * tables AND the SDK transcript files. Mirrors the TUI delete —
	 * workspace files are never touched.
	 */
	async deleteSession(sessionId: string): Promise<void> {
		// TUI parity (`/session delete` refuses while streaming): tearing a
		// session down mid-turn leaves the agent's in-flight runLoop
		// rejecting into a void — the daemon must not delete under it.
		const live = this.#sessions.get(sessionId);
		if (live && (live.view.snapshot().state.isStreaming || live.agentSession.isStreaming)) {
			throw new Error("Cannot delete the session while streaming.");
		}
		this.close(sessionId);
		this.#store.remove(sessionId);
		try {
			await fs.promises.unlink(path.join(JOURNAL_DIR, `${sessionId}.journal.jsonl`));
		} catch (err) {
			// Journal may already be gone; only surface a real IO failure.
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
		// Pause sidecar: a deleted session must not resurrect as paused
		// (a stale file would freeze a re-created session with the same id).
		try {
			await fs.promises.unlink(pauseSidecarPath(sessionId, JOURNAL_DIR));
		} catch (err) {
			// Absence is the non-paused state; a real IO failure still
			// surfaces so a stuck delete is visible.
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
		// SDK transcript files (`<sessionsDir>/<project>/<id>.jsonl`) and
		// their artifacts dir (`<project>/<id>/` — subagent transcripts,
		// tool logs) — the file-scan history (session.list / recent
		// sessions) reads them via listAllSessions, not the journal.
		// Deleting only the journal would let a deleted session come back
		// in the history list (jsonl 复活). scanSync returns paths
		// RELATIVE to the root, so join before unlinking — a bare
		// relative unlink resolves against the daemon's cwd and fails.
		const sessionsRoot = getSessionsDir();
		try {
			for (const f of new Bun.Glob(`*/*${sessionId}*`).scanSync(sessionsRoot)) {
				const full = path.join(sessionsRoot, f);
				const st = await fs.promises.stat(full);
				if (st.isDirectory()) {
					await fs.promises.rm(full, { recursive: true, force: true });
				} else {
					await fs.promises.unlink(full);
				}
			}
		} catch {
			// transcript already gone — fine
		}
	}

	/** Lazy workspace file-content index (settings → 索引库 → 代码库). */
	ensureFileIndex(): FileIndexService {
		if (!this.#fileIndex) {
			this.#fileIndex = new FileIndexService(path.join(getAgentDir(), "file-index.db"));
		}
		return this.#fileIndex;
	}

	/** P1 过渡：物化视图库句柄交予 ViewStoreService 认领查询面与路由
	 *  （history.messages / session.search）。实例归属仍在宿主——
	 *  idle 快照 upsert / 复活 load / 处置 close 都纠缠会话生命周期，
	 *  P2 cordis 化时再切实例归属。 */
	get viewStore(): ViewStore {
		return this.#store;
	}

	/** workspace.tree 根目录兜底（原 workspaceTree 内联语义：
	 *  #options.cwd 未设置时由 FileService 落到 homedir）。 */
	get workspaceFallbackCwd(): string | undefined {
		return this.#options.cwd;
	}

	async subscribe(sessionId: string, conn: DaemonConnection): Promise<{ seq: number }> {
		// History sessions (idle-closed / pre-restart) reactivate on demand so
		// opening them in the GUI yields a live stream, not a dead snapshot.
		let live = this.#sessions.get(sessionId);
		if (!live) live = await this.activate(sessionId);
		// Multi-subscription per connection: envelopes carry `sessionId`, so
		// the GUI routes each to its own store — the old single-active
		// subscription contract (one current store, daemon pushes only the
		// selected session) is replaced by per-session routing on the client.
		live.subscribers.set(conn.id, event => this.emitEvent(conn, { ...event, sessionId }));
		// Replay still-unanswered ask questions to THIS connection: the ask
		// card lives in app-level state (not the per-session journal), so a
		// question raised while another session was displayed would otherwise
		// never surface when the user switches here.
		for (const record of live.approvals.pendingAsks.values()) {
			this.emitEvent(conn, { kind: "ask-request", seq: ++live.seq, sessionId, payload: askRequestPayload(record) });
		}
		return { seq: live.seq };
	}

	unsubscribeAll(connectionId: string): void {
		for (const live of this.#sessions.values()) live.subscribers.delete(connectionId);
	}

	/**
	 * Per-connection event coalescer. Pushes ride an 8ms window; a burst
	 * lands as ONE `{ kind: "batch", events }` frame instead of one frame
	 * per envelope, and flushes defer while the socket write buffer is
	 * backed up (bounded by maxDeferMs). RPC responses bypass this entirely
	 * (callers use conn.send directly), so interactive requests stay ahead
	 * of the event flood.
	 */
	batcherFor(conn: DaemonConnection): EventBatcher {
		let batcher = this.#batchers.get(conn.id);
		if (!batcher) {
			batcher = new EventBatcher(message => conn.send(message), {
				buffered: conn.writableLength ?? (() => 0),
			});
			this.#batchers.set(conn.id, batcher);
		}
		return batcher;
	}

	/** Push one subscription envelope through the connection's coalescer. */
	emitEvent(conn: DaemonConnection, event: BatchedEvent): void {
		this.batcherFor(conn).push(event);
	}

	disconnect(connectionId: string): void {
		this.unsubscribeAll(connectionId);
		const batcher = this.#batchers.get(connectionId);
		if (batcher) {
			batcher.flushNow();
			this.#batchers.delete(connectionId);
		}
	}

	dispose(): void {
		if (this.#idleScanner) {
			clearInterval(this.#idleScanner);
			this.#idleScanner = null;
		}
		for (const live of this.#sessions.values()) live.dispose();
		this.#sessions.clear();
		this.#store.close();
		// Host-owned MCP managers: one disconnect per cwd for the whole daemon
		// (sessions never disconnect them — they pass them via
		// options.mcpManager). Guarded against double-dispose by clearing the
		// maps first; the daemon process exits soon after, so fire-and-forget
		// is safe even if a server resists the disconnect.
		void this.#disposeSharedMCPManagers();
	}
}

/** Render materialized session entries to plain text (debug.transcript —
 *  TUI /debug "export transcript" parity: the TUI dumps its visible chat;
 *  the daemon dumps the persisted conversation). Text blocks only; tool and
 *  image blocks are skipped with a marker so the dump stays readable. */
export function renderDebugTranscript(entries: unknown[]): string {
	const lines: string[] = [];
	for (const raw of entries) {
		if (typeof raw !== "object" || raw === null) continue;
		const entry = raw as { type?: unknown; role?: unknown; content?: unknown; text?: unknown };
		const type = typeof entry.type === "string" ? entry.type : "";
		if (type !== "user" && type !== "assistant") continue;
		const role = typeof entry.role === "string" ? entry.role : type;
		lines.push(`[${role}]`);
		const text = extractEntryText(entry);
		if (text) lines.push(text);
	}
	return lines.join("\n").trimEnd();
}

/** Best-effort text extraction from a wire entry's content (blocks array,
 *  string, or plain text field). */
export function extractEntryText(entry: { content?: unknown; text?: unknown }): string {
	const content = entry.content;
	if (typeof content === "string") return content.trimEnd();
	if (!Array.isArray(content)) return typeof entry.text === "string" ? entry.text.trimEnd() : "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === "string") {
			parts.push(block);
			continue;
		}
		if (typeof block !== "object" || block === null) continue;
		const b = block as { type?: unknown; text?: unknown };
		if (b.type === "text" && typeof b.text === "string") {
			parts.push(b.text);
		} else if (typeof b.type === "string") {
			parts.push(`[${b.type}]`);
		}
	}
	return parts.join("\n").trimEnd();
}
