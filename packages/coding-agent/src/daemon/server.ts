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
 * added — see gui-architecture decision 7.
 */

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { getDashboardStats } from "@musepi/omp-stats";
import { AgentPauseGate, agentPauseGate } from "@musepi/pi-agent-core";
import { getOAuthProviders } from "@musepi/pi-ai/oauth";
import { PROVIDER_REGISTRY } from "@musepi/pi-ai/registry";
import {
	validateAnthropicCompatibleApiKey,
	validateOpenAICompatibleApiKey,
} from "@musepi/pi-ai/registry/api-key-validation";
import { getSupportedEfforts } from "@musepi/pi-catalog/model-thinking";
import { type GeneratedProvider, getBundledModels, getBundledProviders } from "@musepi/pi-catalog/models";
import { FileType, type GlobMatch, listWorkspace } from "@musepi/pi-natives";
import { getAgentDir, getConfigRootDir, getSessionsDir, logger, prompt, VERSION } from "@musepi/pi-utils";
import type { AgentEvent, SessionEntry, SessionHeader, SessionState, WireMessage } from "@musepi/pi-wire";
import type { SessionStreamEvent } from "@musepi/sdk";
import { MaterializedView, messageKey, type Static, type sessionSnapshot } from "@musepi/sdk";
import { YAML } from "bun";
import { reset as resetCapabilities } from "../capability";
import { CollabHost } from "../collab/host";
import { LocalShareManager } from "../collab/local-share";
import type { WorkspaceSessionInfo } from "../collab/protocol";
import { isWireAgentEvent, toWireAgentEvent } from "../collab/wire-guard";
import { findConfigFile } from "../config";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { SettingPath } from "../config/settings-schema";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../discovery/helpers";
import { buildSkillPromptMessage, parseSkillInvocation } from "../extensibility/skills";
import { loadSlashCommands } from "../extensibility/slash-commands";
import { FileIndexService } from "../file-index";
import { computeContextBreakdown } from "../modes/utils/context-usage";
import idleRecapPrompt from "../prompts/system/recap-user.md" with { type: "text" };
import type { CompactMode } from "../session/compact-modes";
import { SKILL_PROMPT_MESSAGE_TYPE } from "../session/messages";
import type { SessionInfo } from "../session/session-listing";
import type { SnapcompactSavingsEstimate } from "../session/snapcompact-inline";
import { executeAcpBuiltinSlashCommand } from "../slash-commands/acp-builtins";
import { lookupBuiltinSlashCommand } from "../slash-commands/builtin-registry";
import { parseSlashCommand } from "../slash-commands/helpers/parse";
import { resolvePromptInput } from "../system-prompt";
import { refreshAgentDiscovery } from "../task";
import type { ConfiguredThinkingLevel } from "../thinking";
import { previewLine, TRUNCATE_LENGTHS } from "../tools/render-utils";
import { nextActionableTask, type TodoPhase } from "../tools/todo";
import {
	type CronRun,
	type CronStatus,
	type CronTask,
	computeNextRun,
	loadCronRuns,
	loadCronTasks,
	saveCronRuns,
	saveCronTasks,
	validateCronTask,
} from "./crons";
import { createWorkspaceDir, deleteWorkspaceEntry, renameWorkspaceEntry, writeWorkspaceFile } from "./fs-ops.js";
import { addRemoteHost, browseRemoteDir, connectRemoteHost, disconnectRemoteHost, listRemoteHosts } from "./remote";

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

/** sessionPromptInputs + a desktop-interface note. The daemon serves the
 *  GUI/browser, so agents here must know which settings are no-ops: any
 *  `ui.tuiOnly` setting (theme.*, statusLine.*, terminal.*, tui.*, …) only
 *  affects the terminal UI — editing it in a desktop session changes nothing
 *  the agent can observe. The list is generated from SETTINGS_SCHEMA (single
 *  source of truth), so it cannot drift from the settings UI. (display.*
 *  entries that the desktop transcript consumes — smoothStreaming,
 *  hideToolActivity, showTokenUsage, collapseCompacted — are NOT flagged,
 *  so they stay out of this note and the GUI's TUI-only badge.) */
async function desktopSessionPromptInputs(
	cwd: string,
): Promise<{ customSystemPrompt?: string; appendSystemPrompt?: string }> {
	const base = await sessionPromptInputs(cwd);
	const { tuiOnlySettingKeys } = await import("../config/settings-schema");
	const tuiOnly = tuiOnlySettingKeys();
	if (tuiOnly.length === 0) return base;
	const note =
		"当前为桌面界面（GUI）会话。以下设置仅对终端界面（TUI）生效，在本次会话中修改不会影响当前界面：" +
		tuiOnly.join(", ") +
		"。";
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

import { ModelsConfigFile } from "../config/models-config";
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import type { AgentSession } from "../session/agent-session";
import type { StoredAuthCredential } from "../session/auth-storage";
import { USER_INTERRUPT_LABEL } from "../session/messages";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "../task/types";
import { EventBus } from "../utils/event-bus";
import { openPath } from "../utils/open";
import { type ApprovalBridge, createApprovalBridge, type PendingApproval } from "./approval-bridge";
import { AppendJournal } from "./journal";
import { type MaterializedRow, ViewStore, viewStorePath } from "./view-store";
import { type DaemonWsHandle, startDaemonWs } from "./ws-transport";

export interface DaemonOptions {
	socketPath?: string;
	/** Optional WebSocket port (browser-reachable JSON-RPC transport). */
	wsPort?: number;
	cwd?: string;
}

/**
 * Daemon runtime dir: socket + journal + materialized view store. Defaults
 * to a shared temp dir, but MUST be isolatable (MUSEPI_DAEMON_DIR) so test
 * daemons never collide with the user's: two daemons sharing the journal
 * dir race the materialized.db write lock and the journal compaction .tmp
 * rename — both crash the process.
 */
const SOCKET_DIR = process.env.MUSEPI_DAEMON_DIR || path.join(os.tmpdir(), "musepi-daemon");

/** One skill entry served by skills.list (scan + enablement state). */
interface SkillListItem {
	name: string;
	description: string;
	filePath: string;
	source: string;
	hide: boolean;
	_source?: { provider: string; providerName: string; path: string; level: "user" | "project" | "native" };
}

/** Unified extension entry (extension control center, TUI parity). */
type Extension = import("../modes/components/extensions/types").Extension;

/** Minimal typed view over the live AgentSession's mode state. */
interface ModeSessionLike {
	getGoalModeState?(): { enabled?: boolean; goal?: { objective?: string; status?: string } } | undefined;
	getPlanModeState?(): { enabled?: boolean } | undefined;
	getTodoPhases?(): TodoPhase[];
	isCompacting?: boolean;
}

/** Goal/plan mode + aggregated todo progress for the GUI badges. */
function modesOf(session: unknown): {
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
		goalMode:
			goal?.enabled && goal.goal?.objective
				? { enabled: true, objective: goal.goal.objective, status: goal.goal.status }
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
const DEFAULT_SOCKET = path.join(SOCKET_DIR, "daemon.sock");
const JOURNAL_DIR = path.join(SOCKET_DIR, "journal");

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

function estimateSnapcompactSavings(session: AgentSession): SnapcompactSavingsEstimate | null {
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
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const IDLE_SCAN_INTERVAL_MS = 60 * 1000;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
/** Idle-recap delay bounds (TUI event-controller parity). */
const IDLE_RECAP_MIN_SECONDS = 1;
const IDLE_RECAP_MAX_SECONDS = 3600;

// ── JSON-RPC 2.0 ────────────────────────────────────────────────────────────

interface RpcRequest {
	jsonrpc: "2.0";
	id: number | string;
	method: string;
	params?: unknown;
}

// ── Session host ────────────────────────────────────────────────────────────

interface LiveSession {
	sessionId: string;
	agentSession: AgentSession;
	/** When false, the session-tree title never falls back to the first
	 *  user message (Settings → 会话 → 自动生成会话标题 off). */
	autoTitle: boolean;
	/** Incrementing event sequence for the stream contract. */
	seq: number;
	journal: AppendJournal | null;
	view: MaterializedView;
	subscribers: Map<string, (event: SessionStreamEvent) => void>;
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
	publishWireEvent(event: Parameters<typeof AgentSession.prototype.subscribe>[0] extends (e: infer E) => void ? E : never): void;
	dispose: () => void;
}

/** A connected RPC client; `send` writes a newline-framed JSON message. */
export interface DaemonConnection {
	readonly id: string;
	send(message: unknown): void;
}

/** Backed-up tail of one session.revertTo — restorable by
 *  session.restoreRevert (openchamber RevertedMessageDock Restore parity):
 *  the truncated wire entries (re-emitted into journal/view) plus, for
 *  history sessions, the raw jsonl records cut from the SDK transcript. */
export interface RevertBackup {
	wireEntries: SessionEntry[];
	fileLines: string[];
	/** Target user-message text (dock display + composer restore). */
	text: string;
	/** View entry id of the target user message (per-item restore/fork). */
	messageId: string;
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
	/** In-flight history-session reactivations (dedupe concurrent subscribe/send). */
	readonly #activating = new Map<string, Promise<LiveSession>>();
	/** First live session's model registry — shared for provider/model RPCs
	 *  (login/logout/custom-model) that must work without a live session
	 *  (history sessions are resumed, not live). */
	#registry: ModelRegistry | null = null;
	/** Global settings instance (first live session's, reused for the
	 *  session-less settings.* RPCs — one config, one writer). */
	#settings: Settings | null = null;
	readonly #options: DaemonOptions;
	readonly #store: ViewStore;
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
	/** Revert backups (openchamber RevertedMessageDock Restore parity): the
	 *  wire entries truncated by each session.revertTo, per session, LIFO.
	 *  session.restoreRevert pops the latest and re-emits them into the
	 *  journal/view (and, for live sessions, into the agent context via
	 *  AgentSession.restoreRevert). In-memory: matches the GUI's revert-dock
	 *  lifetime (both reset on restart). */
	readonly #revertBackups = new Map<string, RevertBackup[]>();

	/** Per-session revert backups (LIFO — the latest revert is popped first
	 *  by session.restoreRevert). */
	revertBackupsFor(sessionId: string): RevertBackup[] {
		let list = this.#revertBackups.get(sessionId);
		if (!list) {
			list = [];
			this.#revertBackups.set(sessionId, list);
		}
		return list;
	}

	/** Discard the session's revert backups (session.delete path). */
	clearRevertBackups(sessionId: string): void {
		this.#revertBackups.delete(sessionId);
	}

	constructor(options: DaemonOptions = {}) {
		this.#options = options;
		this.#store = new ViewStore(viewStorePath(JOURNAL_DIR));
		this.#idleScanner = setInterval(() => this.#scanIdle(), IDLE_SCAN_INTERVAL_MS);
		this.#idleScanner.unref?.();
	}

	async createSession(params: {
		cwd?: string;
		title?: string;
		forkOf?: string;
		autoTitle?: boolean;
		modelPattern?: string;
		thinkingLevel?: ConfiguredThinkingLevel;
	}): Promise<{ sessionId: string }> {
		const cwd = path.resolve(params.cwd ?? this.#options.cwd ?? process.cwd());
		const parentId = params.forkOf && this.#sessions.has(params.forkOf) ? params.forkOf : null;
		// Lazy import keeps daemon startup cheap; createAgentSession owns the
		// full agent runtime bootstrap (settings, extensions, storage).
		const { createAgentSession } = await import("../sdk");
		const pauseGate = new AgentPauseGate();
		const result = await createAgentSession({
			cwd,
			hasUI: true,
			interfaceLabel: "desktop (GUI)",
			eventBus: this.#eventBus,
			pauseGate,
			...(await desktopSessionPromptInputs(cwd)),
			...(params.modelPattern ? { modelPattern: params.modelPattern } : {}),
			...(params.thinkingLevel ? { thinkingLevel: params.thinkingLevel } : {}),
		});
		const live = await this.#adoptAgentSession(result.session, cwd, result.setToolUIContext, parentId, pauseGate);
		live.autoTitle = params.autoTitle !== false;
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
		const pauseGate = new AgentPauseGate();
		const resumeCwd = match.session.cwd || cwd;
		const result = await createAgentSession({
			cwd: resumeCwd,
			sessionManager: manager,
			hasUI: true,
			interfaceLabel: "desktop (GUI)",
			eventBus: this.#eventBus,
			pauseGate,
			...(await desktopSessionPromptInputs(resumeCwd)),
		});
		// The resumed manager adopts the transcript's header id; a mismatch
		// means the file wasn't the requested session after all.
		if (result.session.sessionId !== sessionId) {
			await result.session.dispose?.();
			throw new Error(`Unknown session: ${sessionId}`);
		}
		return this.#adoptAgentSession(result.session, cwd, result.setToolUIContext, null, pauseGate);
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
		const approvals = createApprovalBridge(record => {
			for (const send of live.subscribers.values()) {
				try {
					send({
						kind: "approval-request",
						seq: ++live.seq,
						payload: { requestId: record.requestId, tool: record.tool, args: null },
					});
				} catch {
					// subscriber socket died; removed on close
				}
			}
		});
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
			view =
				MaterializedView.fromSnapshot(sessionId, cwd, {
					entries: sdkEntries,
					state: { isStreaming: false, queuedMessageCount: 0, cwd, participants: [] },
					cursor: sdkEntries.length,
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
			agentSession,
			autoTitle: true,
			seq: viewFinal.cursor,
			journal,
			view: viewFinal,
			subscribers: new Map(),
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
							payload: { requestId: record.requestId, tool: record.tool, args: null },
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
			publishWireEvent: (event: Parameters<typeof AgentSession.prototype.subscribe>[0] extends (e: infer E) => void ? E : never) => {
				const wireEvent = toWireAgentEvent(event);
				if (!wireEvent) return;
				const seq = ++live.seq;
				live.journal?.append(wireEvent);
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
				void agentSession.dispose();
			},
		};
		live.idleTimer = setTimeout(() => this.close(sessionId), IDLE_TIMEOUT_MS);		live.idleTimer.unref?.();
		// Subagent progress/lifecycle (task tool) rides the GUI stream: the
		// EventBus channels are per-daemon shared, so payloads from any session
		// are keyed by agent id and fan out to this session's subscribers like
		// the wire events below. Unsubscribed on session close.
		const onSubagentProgress = (payload: unknown): void => {
			const seq = ++live.seq;
			for (const send of live.subscribers.values()) {
				try {
					send({ kind: "agent-progress", seq, payload: payload as never });
				} catch {
					// subscriber socket died; removed on close
				}
			}
		};
		const onSubagentLifecycle = (payload: unknown): void => {
			const seq = ++live.seq;
			for (const send of live.subscribers.values()) {
				try {
					send({ kind: "agent-lifecycle", seq, payload: payload as never });
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
			if (event.type === "agent_end") this.#scheduleIdleRecap(live);
			const seq = ++live.seq;
			const wireEvent = toWireAgentEvent(event);
			if (!wireEvent) return;
			live.journal?.append(wireEvent);
			live.view.apply(wireEvent);
			schedulePersist();
			// Compact when the journal crosses a bound: fold the materialized
			// snapshot into a checkpoint and trim. Checked amortized (every
			// 200th event) so the read is cheap.
			eventsSinceCompactionCheck += 1;
			if (eventsSinceCompactionCheck >= 200 && live.journal) {
				eventsSinceCompactionCheck = 0;
				void live.journal.shouldCompact().then(needed => {
					if (needed && live.journal) void live.journal.compact(live.view.cursor, live.view.snapshot());
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
			for (const send of live.subscribers.values()) {
				try {
					send({ kind: "pause-state", seq, payload });
				} catch {
					// subscriber socket died; removed on close
				}
			}
		});
		this.#sessions.set(sessionId, live);
		return live;
	}

	sessions(): IterableIterator<string> {
		return this.#sessions.keys();
	}

	get(sessionId: string): LiveSession | undefined {
		return this.#sessions.get(sessionId);
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
						(this.get(row.sessionId)?.autoTitle !== false ? this.firstUserMessage(row.sessionId) : undefined) ??
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
	persistHeaderPatch(sessionId: string, patch: { model?: string; thinkingLevel?: string }): boolean {
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
		// Lazy import keeps daemon startup cheap (same rationale as createSession):
		// the registry bootstrap is only needed when provider/model RPCs arrive
		// without any live session ever having been created.
		const { createAgentSession } = await import("../sdk");
		const result = await createAgentSession({
			cwd: this.#options.cwd ?? process.cwd(),
			hasUI: false,
			eventBus: this.#eventBus,
		});
		this.#registry = result.session.modelRegistry;
		this.#settings ??= result.session.settings as unknown as Settings;
		await result.session.dispose?.();
		return this.#registry;
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
	 * Truncate the daemon journal/view to just before a user message
	 * (session.revertTo — the agent session itself was already truncated).
	 * Returns the surviving cursor, or -1 when the message isn't journaled.
	 */
	async truncateSession(sessionId: string, messageId: string): Promise<number> {
		const journal = new AppendJournal(JOURNAL_DIR, sessionId);
		const live = this.#sessions.get(sessionId);
		await journal.open();
		try {
			// messageId is the view's message key ("role:timestamp"); wire
			// messages carry no id — match the message_start event.
			const m = /^([^:]+):(\d+)$/.exec(messageId);
			if (!m) return -1;
			let target = -1;
			for (const record of await journal.readAll()) {
				const ev = record.event as { type?: string; message?: { role?: string; timestamp?: number } };
				if (ev?.type === "message_start" && ev.message?.role === m[1] && String(ev.message?.timestamp) === m[2]) {
					target = record.seq - 1;
					break;
				}
			}
			if (target < 0) {
				// Compacted history: the message_start may be folded into the
				// checkpoint — truncate the folded snapshot in place.
				const ckpt = await AppendJournal.readCheckpoint(journal.filePath);
				if (!ckpt) {
					// Last resort: the message survives only in the materialized
					// view (journal truncated without a checkpoint). Truncate the
					// stored snapshot; the journal restarts empty from its cursor.
					const persisted = this.#store.load(sessionId);
					if (persisted) {
						const idx = persisted.entries.findIndex(e => e.type === "message" && e.id === messageId);
						if (idx >= 0) {
							persisted.entries = persisted.entries.slice(0, idx);
							const view = MaterializedView.fromSnapshot(
								sessionId,
								typeof persisted.header?.cwd === "string" ? persisted.header.cwd : (this.#options.cwd ?? ""),
								persisted,
							);
							if (view) {
								await journal.truncate(0);
								if (live) {
									live.view = view;
									live.seq = view.cursor;
								}
								this.#store.upsert(sessionId, view.snapshot());
								return view.cursor;
							}
						}
					}
					return -1;
				}
				const snap = ckpt.snapshot as { entries?: { type?: string; id?: string }[] } | null;
				if (!snap || !Array.isArray(snap.entries)) return -1;
				const idx = snap.entries.findIndex(e => e.type === "message" && e.id === messageId);
				if (idx < 0) return -1;
				const entries = snap.entries.slice(0, idx);
				const trimmed = { ...(ckpt.snapshot as object), entries };
				await journal.replaceCheckpoint(trimmed, ckpt.seq);
				const view = MaterializedView.fromSnapshot(sessionId, this.#options.cwd ?? "", trimmed);
				if (!view) return -1;
				if (live) {
					live.view = view;
					live.seq = view.cursor;
				}
				this.#store.upsert(sessionId, view.snapshot());
				return view.cursor;
			}
			await journal.truncate(target);
			const { events } = await journal.replaySource();
			const cwd = live?.view
				? (live.view.snapshot().state.cwd ?? this.#options.cwd ?? "")
				: (this.#options.cwd ?? "");
			const view = MaterializedView.replay(sessionId, cwd, events);
			// Rounds that completed before this truncation keep their frozen
			// totals (the replay itself never records durations).
			view.seedRoundDurations(this.#store.load(sessionId)?.roundDurations);
			if (live) live.view = view;
			this.#store.upsert(sessionId, view.snapshot());
			return view.cursor;
		} finally {
			void journal.close();
		}
	}

	/** Persist a materialized snapshot to the view store (revert path). */
	persistSnapshot(sessionId: string, snapshot: unknown): void {
		this.#store.upsert(sessionId, snapshot as never);
	}

	/** Refresh a live session's idle clock (called on session.send). */
	touch(sessionId: string): void {
		const live = this.#sessions.get(sessionId);
		if (!live) return;
		live.lastActivity = Date.now();
		this.#cancelIdleRecap(live);
		if (live.idleTimer) {
			clearTimeout(live.idleTimer);
			live.idleTimer = setTimeout(() => this.close(sessionId), IDLE_TIMEOUT_MS);
			live.idleTimer.unref?.();
		}
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
		live.dispose();
	}

	#scanIdle(): void {
		const now = Date.now();
		for (const [id, live] of this.#sessions) {
			if (now - live.lastActivity > IDLE_TIMEOUT_MS) this.close(id);
		}
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
				state: { goalMode?: unknown; planMode?: unknown; todo?: unknown; isStreaming?: boolean };
			};
			// Live mode state rides along on the snapshot so the GUI badges
			// reflect goal/plan/todo without extra round-trips.
			const modes = modesOf(live.agentSession);
			snap.state.goalMode = modes.goalMode;
			snap.state.planMode = modes.planMode;
			snap.state.todo = modes.todo;
			// The view's isStreaming flag is event-driven and can go stale
			// (abort paths never emit turn_end) — the agent's live getter is
			// authoritative for what the GUI should show as working.
			const agentLike = live.agentSession as unknown as { isStreaming?: boolean };
			if (typeof agentLike.isStreaming === "boolean") {
				snap.state.isStreaming = agentLike.isStreaming;
			}
			return snap;
		}
		// History path: no running session — serve the persisted materialized
		// snapshot, degrading to a journal replay when the cache is absent.
		const persisted = this.#store.load(sessionId);
		if (persisted) {
			const headerCwd =
				persisted.header && typeof persisted.header === "object"
					? String((persisted.header as { cwd?: string }).cwd ?? "")
					: "";
			const view = MaterializedView.fromSnapshot(sessionId, headerCwd, persisted);
			if (view) return view.snapshot();
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
				return view.snapshot();
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
		return snapshotFromJsonl(match.session.path, sessionId);
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
	 */
	async catchup(sessionId: string, cursor: number, conn: DaemonConnection): Promise<void> {
		const journal = new AppendJournal(JOURNAL_DIR, sessionId);
		await journal.open();
		try {
			for (const record of await journal.readAll()) {
				if (record.seq > cursor) conn.send({ kind: "event", seq: record.seq, payload: record.event });
			}
		} finally {
			void journal.close();
		}
	}

	/** All known sessions (live + persisted history) with queryable metadata. */
	/** Bust the SDK-session scan cache (session.forkAt writes a new file). */
	invalidateHistoryCache(): void {
		this.#historyCache = null;
	}

	async knownSessions(): Promise<(ReturnType<ViewStore["list"]>[number] & { liveCursor?: number; title?: string })[]> {
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
		const merged = new Map<string, MaterializedRow & { title?: string }>(rows.map(r => [r.sessionId, r]));
		for (const h of history.rows) {
			const existing = merged.get(h.id);
			const first = h.firstMessage && h.firstMessage !== "(no messages)" ? h.firstMessage : undefined;
			if (existing) {
				// Store rows carry the snapshot header title only (persisted
				// before the async auto-title landed, or a create-time title).
				// Backfill the jsonl title slot when the stored title is empty
				// so daemon-restarted sessions keep their generated titles.
				if (!existing.title && h.title) existing.title = h.title;
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
		this.close(sessionId);
		this.#store.remove(sessionId);
		try {
			await fs.promises.unlink(path.join(JOURNAL_DIR, `${sessionId}.journal.jsonl`));
		} catch (err) {
			// Journal may already be gone; only surface a real IO failure.
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

	/** Cross-session message search over the materialized query tables. */
	searchMessages(query: string, limit: number): ReturnType<ViewStore["search"]> {
		return this.#store.search(query, limit);
	}

	/** Lazy workspace file-content index (settings → 索引库 → 代码库). */
	ensureFileIndex(): FileIndexService {
		if (!this.#fileIndex) {
			this.#fileIndex = new FileIndexService(path.join(getAgentDir(), "file-index.db"));
		}
		return this.#fileIndex;
	}

	/** Earliest user message for a session — session-tree title source. */
	firstUserMessage(sessionId: string): string {
		return this.#store.firstUserMessage(sessionId);
	}

	/** All message rows for one session (history viewer), oldest first. */
	sessionMessages(sessionId: string, limit: number): ReturnType<ViewStore["messagesFor"]> {
		return this.#store.messagesFor(sessionId, limit);
	}

	/**
	 * Structured workspace tree (file pane): native single-pass scan with
	 * per-directory caps (recent + oldest kept when over cap). Mirrors the
	 * TUI workspace-tree semantics without the rendered-string format.
	 */
	async workspaceTree(
		cwd: string,
		options: { maxDepth?: number; perDirLimit?: number | null } = {},
	): Promise<{
		rootPath: string;
		truncated: boolean;
		entries: Array<{ name: string; path: string; isDir: boolean; size: number; mtime: number; depth: number }>;
	}> {
		const rootPath = path.resolve(cwd || this.#options.cwd || os.homedir());
		const maxDepth = options.maxDepth ?? 2;
		const perDirLimit = options.perDirLimit ?? 50;
		let result: { entries: readonly GlobMatch[]; truncated: boolean };
		try {
			const scan = await listWorkspace({
				path: rootPath,
				maxDepth,
				hidden: true,
				gitignore: true,
			});
			result = { entries: scan.entries, truncated: scan.truncated };
		} catch {
			// Native scan unavailable (e.g. missing binary) — empty tree.
			result = { entries: [], truncated: false };
		}
		// Per-directory cap: sort by mtime desc, keep recent + oldest (same
		// strategy as the TUI: limit-1 newest + the single oldest).
		const byParent = new Map<string, Array<{ name: string; entry: GlobMatch; parentPath: string }>>();
		const entries: Array<{ name: string; path: string; isDir: boolean; size: number; mtime: number; depth: number }> =
			[];
		for (const entry of result.entries) {
			const slash = entry.path.lastIndexOf("/");
			const name = slash === -1 ? entry.path : entry.path.slice(slash + 1);
			const parentPath = slash === -1 ? "" : entry.path.slice(0, slash);
			const bucket = byParent.get(parentPath) ?? [];
			bucket.push({ name, entry, parentPath });
			byParent.set(parentPath, bucket);
		}
		let truncated = result.truncated;
		for (const [parentPath, bucket] of byParent) {
			if (perDirLimit !== null && bucket.length > perDirLimit) {
				bucket.sort((a, b) => (b.entry.mtime ?? 0) - (a.entry.mtime ?? 0));
				const keep =
					perDirLimit <= 1
						? bucket.slice(0, Math.max(0, perDirLimit))
						: [...bucket.slice(0, perDirLimit - 1), bucket.at(-1)!];
				byParent.set(
					parentPath,
					keep.map(k => ({ name: k.name, entry: k.entry, parentPath })),
				);
				truncated = true;
			}
		}
		for (const [parentPath, bucket] of byParent) {
			for (const item of bucket) {
				entries.push({
					name: item.name,
					path: parentPath ? `${parentPath}/${item.name}` : item.name,
					isDir: item.entry.fileType === FileType.Dir,
					size: item.entry.size ?? 0,
					mtime: item.entry.mtime ?? 0,
					depth: parentPath ? parentPath.split("/").length + 1 : 1,
				});
			}
		}
		entries.sort((a, b) => a.path.localeCompare(b.path));
		return { rootPath, truncated, entries };
	}

	async subscribe(sessionId: string, conn: DaemonConnection): Promise<{ seq: number }> {
		// History sessions (idle-closed / pre-restart) reactivate on demand so
		// opening them in the GUI yields a live stream, not a dead snapshot.
		let live = this.#sessions.get(sessionId);
		if (!live) live = await this.activate(sessionId);
		live.subscribers.set(conn.id, event => conn.send(event));
		return { seq: live.seq };
	}

	unsubscribeAll(connectionId: string): void {
		for (const live of this.#sessions.values()) live.subscribers.delete(connectionId);
	}

	disconnect(connectionId: string): void {
		this.unsubscribeAll(connectionId);
	}

	dispose(): void {
		if (this.#idleScanner) {
			clearInterval(this.#idleScanner);
			this.#idleScanner = null;
		}
		for (const live of this.#sessions.values()) live.dispose();
		this.#sessions.clear();
		this.#store.close();
	}
}

// ── Method dispatch ─────────────────────────────────────────────────────────

class DaemonServer {
	readonly #host: DaemonSessionHost;
	/** Scheduled tasks (cron): loaded from ~/.musepi/crons.json; a 30s
	 *  scanner runs due tasks in fresh sessions (kimi cron parity). */
	#cronTasks: CronTask[] = [];
	#cronRuns: CronRun[] = [];
	#cronTimer: ReturnType<typeof setInterval> | null = null;
	#cronStarting = new Set<string>();

	/** Session ids owned by scheduled tasks (run history + last run per
	 *  task) — the GUI groups them apart from regular sessions. */
	#cronSessionIds(): Set<string> {
		const ids = new Set<string>();
		for (const task of this.#cronTasks) {
			const last = task.state?.lastSessionId;
			if (last) ids.add(last);
		}
		for (const run of this.#cronRuns) {
			if (run.sessionId) ids.add(run.sessionId);
		}
		return ids;
	}

	constructor(host: DaemonSessionHost) {
		this.#host = host;
		this.#cronTasks = loadCronTasks();
		this.#cronRuns = loadCronRuns();
		this.#cronTimer = setInterval(() => this.#cronScan(), 30_000);
		this.#cronTimer.unref?.();
	}

	/** Active GUI collab share (ZCode remote-control dialog). */
	#collab: { host: CollabHost; transport: LocalShareManager } | null = null;

	#resumeLive: LiveSession | null = null;

	/** Scheduled-task scanner: fire every enabled task whose nextRunAt is
	 *  due (or missing — first enable after a manual edit recomputes it on
	 *  the next tick). Runs are fire-and-forget; the per-session agent
	 *  subscription updates state when the turn finishes. */
	#cronScan(): void {
		const now = Date.now();
		for (const task of this.#cronTasks) {
			if (!task.enabled) continue;
			if (this.#cronStarting.has(task.id)) continue;
			if (task.state.nextRunAt === undefined || task.state.nextRunAt <= now) {
				void this.#cronRun(task);
			}
		}
	}

	/** Execute one scheduled task in a fresh session bound to its cwd. */
	async #cronRun(task: CronTask): Promise<void> {
		if (this.#cronStarting.has(task.id)) return;
		this.#cronStarting.add(task.id);
		const startedAt = Date.now();
		const run: CronRun = {
			id: `run-${task.id}-${startedAt}`,
			taskId: task.id,
			startedAt,
			status: "running",
		};
		this.#cronRuns.push(run);
		saveCronRuns(this.#cronRuns);
		task.state.lastRunAt = startedAt;
		task.state.lastStatus = "running";
		task.state.lastError = undefined;
		task.state.nextRunAt = computeNextRun(task, startedAt) ?? undefined;
		saveCronTasks(this.#cronTasks);
		let live: LiveSession | undefined;
		try {
			const { sessionId } = await this.#host.createSession({
				cwd: task.cwd || undefined,
				modelPattern: task.model || undefined,
				thinkingLevel:
					task.thinkingLevel && task.thinkingLevel !== "default"
						? (task.thinkingLevel as unknown as ConfiguredThinkingLevel)
						: undefined,
			});
			live = this.#host.get(sessionId);
			if (!live) throw new Error("session not adopted");
			run.sessionId = sessionId;
			task.state.lastSessionId = sessionId;
			saveCronTasks(this.#cronTasks);
			const finish = (status: CronStatus, error?: string): void => {
				run.status = status;
				run.finishedAt = Date.now();
				run.error = error;
				task.state.lastStatus = status;
				task.state.lastError = error;
				saveCronRuns(this.#cronRuns);
				saveCronTasks(this.#cronTasks);
				this.#cronStarting.delete(task.id);
			};
			const unsubscribe = live.agentSession.subscribe(e => {
				if (e.type === "agent_end") {
					unsubscribe();
					finish("success");
				}
			});
			await live.agentSession.sendUserMessage(task.prompt);
		} catch (err) {
			run.status = "error";
			run.finishedAt = Date.now();
			run.error = err instanceof Error ? err.message : String(err);
			task.state.lastStatus = "error";
			task.state.lastError = run.error;
			saveCronRuns(this.#cronRuns);
			saveCronTasks(this.#cronTasks);
			this.#cronStarting.delete(task.id);
		}
	}

	/** Recompute nextRunAt for every task after edits (keep state honest
	 *  without waiting for the next tick). */
	#cronRecompute(): void {
		const now = Date.now();
		for (const task of this.#cronTasks) {
			if (task.enabled) task.state.nextRunAt = computeNextRun(task, now) ?? undefined;
		}
		saveCronTasks(this.#cronTasks);
	}

	/**
	 * Outstanding OAuth onPrompt resolvers keyed by provider id. GUI answers
	 * via `providers.loginInput`; the waiting auth-storage login settles.
	 */
	#promptResolvers = new Map<
		string,
		{ resolve(value: string): void; reject(error: Error): void; abort: AbortController }
	>();
	/** Event sequence for non-session (provider) envelopes. */
	#eventSeq = 0;

	/** Live pty bridges keyed by terminal id (bridge process owns node-pty). */
	#terminals = new Map<string, { write(msg: unknown): Promise<void>; dispose(): void }>();

	/** Clients subscribed to global-pause broadcasts (daemon.pauseStatus
	 *  subscribes; dead sockets are dropped lazily inside broadcast). */
	#pauseConns = new Set<DaemonConnection>();

	/** TTL cache of the extension/plugin scan (settings → plugins tab). */
	#pluginsCache: {
		at: number;
		plugins: { path: string; label: string | null; tools: number; commands: number; handlers: number }[];
		errors: { path: string; error: string }[];
	} | null = null;

	/** TTL cache of the skills scan (settings → skills tab + slash
	 *  completion). */
	#skillsCache: {
		at: number;
		skills: SkillListItem[];
		warnings: string[];
	} | null = null;

	/** TTL cache of the unified extension scan (extensions.list — the
	 *  Extension Control Center's 10 capability kinds, TUI parity).
	 *  Invalidated by the mutation RPCs below. */
	#extensionsCache: { at: number; extensions: Extension[] } | null = null;

	/** Unified extension inventory (10 kinds, three states) with the same
	 *  normalization the TUI /extensions dashboard uses. */
	/** Settings with lazy bootstrap (settings.get/set RPC pattern). */
	async #settingsForRpc(): Promise<Settings> {
		let settings = this.#host.settings();
		if (!settings) {
			await this.#host.ensureRegistry();
			settings = this.#host.settings();
		}
		if (!settings) throw new Error("settings unavailable");
		return settings;
	}

	async #getExtensions(): Promise<Extension[]> {
		if (!this.#extensionsCache || Date.now() - this.#extensionsCache.at > 10_000) {
			const { loadAllExtensions } = await import("../modes/components/extensions/state-manager");
			let settings = this.#host.settings();
			if (!settings) {
				await this.#host.ensureRegistry();
				settings = this.#host.settings();
			}
			const disabledIds = (settings?.get("disabledExtensions") ?? []) as string[];
			this.#extensionsCache = {
				at: Date.now(),
				extensions: await loadAllExtensions(this.#host.cwd(), disabledIds),
			};
		}
		return this.#extensionsCache.extensions;
	}

	/** TTL-refreshed skills scan shared by skills.list and commands.list. */
	async #getSkills(): Promise<SkillListItem[]> {
		if (!this.#skillsCache || Date.now() - this.#skillsCache.at > 10_000) {
			const { discoverSkills } = await import("../sdk");
			const { skills, warnings } = await discoverSkills(this.#host.cwd());
			this.#skillsCache = {
				at: Date.now(),
				skills: skills.map(s => ({
					name: s.name,
					description: s.description,
					filePath: s.filePath,
					source: s.source,
					hide: s.hide === true,
					_source: s._source,
				})),
				warnings: warnings.map(w => `${w.skillPath}: ${w.message}`),
			};
		}
		return this.#skillsCache.skills;
	}

	/** Broadcast the process-global freeze state to subscribed clients
	 *  (daemon.pauseStatus registers; the gate's onChange drives it). */
	broadcastGlobalPause(paused: boolean, pausedAt: number | null): void {
		const seq = ++this.#eventSeq;
		for (const conn of this.#pauseConns) {
			try {
				conn.send({ kind: "global-pause-state", seq, payload: { paused, pausedAt } });
			} catch {
				this.#pauseConns.delete(conn);
			}
		}
	}

	/** Replay resume catch-up deltas after the response was written, then
	 *  attach the live stream so replayed deltas never duplicate live events. */
	async catchupIfNeeded(method: string, params: unknown, conn: DaemonConnection): Promise<void> {
		if (method !== "session.resume") return;
		const p = (params ?? {}) as { sessionId: string; cursor?: number };
		const live = this.#resumeLive;
		this.#resumeLive = null;
		try {
			if (typeof p.cursor === "number") {
				await this.#host.catchup(p.sessionId, p.cursor, conn);
			}
		} finally {
			if (live) {
				this.#host.touch(live.sessionId);
				await this.#host.subscribe(live.sessionId, conn);
			}
		}
	}

	/** Spawn a terminal and wire its output to the caller.
	 * Primary backend: bun-pty runs natively inside this Bun daemon (no
	 * extra process). If that fails (platform/build), fall back to the
	 * node pty-bridge child. Shell/env handling mirrors opencode:
	 * $SHELL → platform default, login shell for bash/zsh/sh/dash/ksh,
	 * TERM/COLORTERM forced. */
	async #openTerminal(cwd: string, cols: number, rows: number, conn: DaemonConnection): Promise<string> {
		const path = await import("node:path");
		const fs = await import("node:fs");
		const id = `term-${++this.#terminalSeq}`;
		// Resolve the shell + env exactly as the bridge would.
		const platform = process.platform;
		const shell = process.env.SHELL || (platform === "win32" ? "powershell.exe" : "bash");
		const base = path.basename(shell).toLowerCase();
		const args = ["bash", "zsh", "sh", "dash", "ksh"].includes(base) ? ["-l"] : [];
		let realCwd = cwd;
		try {
			if (!realCwd || !fs.statSync(realCwd).isDirectory()) realCwd = process.env.HOME || "/";
		} catch {
			realCwd = process.env.HOME || "/";
		}
		const env: Record<string, string> = {
			...process.env,
			TERM: "xterm-256color",
			COLORTERM: "truecolor",
			SHELL: shell,
			COLUMNS: String(cols),
			LINES: String(rows),
			// GUI-spawned daemons inherit Electron/node-child artifacts that
			// would leak into every pty shell (openchamber parity):
			// ELECTRON_RUN_AS_NODE turns `node`/`npx` into Electron's node,
			// NODE_CHANNEL_FD points at a dead IPC fd, BASH_ENV/ENV silently
			// alter shell startup. APPLE_SUPPRESS_DEVELOPER_TOOL_POPUP stops
			// the "install command line developer tools" dialog from a pty
			// nobody can answer (proma parity); GIT_TERMINAL_PROMPT keeps git
			// from hanging on credentials.
			APPLE_SUPPRESS_DEVELOPER_TOOL_POPUP: "1",
			GIT_TERMINAL_PROMPT: "0",
		};
		for (const k of [
			"ELECTRON_RUN_AS_NODE",
			"NODE_CHANNEL_FD",
			"BASH_ENV",
			"BASH_XTRACEFD",
			"ENV",
			"ARGV0",
		] as const) {
			delete env[k];
		}
		if (platform === "win32") {
			env.LC_ALL = "C.UTF-8";
			env.LC_CTYPE = "C.UTF-8";
			env.LANG = "C.UTF-8";
		}

		// Primary: bun-pty inside this process.
		try {
			const { spawn: bunSpawn } = (await import("bun-pty")) as {
				spawn(
					cmd: string,
					args: string[],
					opts: { cols: number; rows: number; cwd: string; env: Record<string, string> },
				): {
					pid: number;
					write(d: string): void;
					resize(c: number, r: number): void;
					kill(): void;
					onData(cb: (d: string) => void): void;
					onExit(cb: (e: { exitCode: number }) => void): void;
				};
			};
			const proc = bunSpawn(shell, args, { cols, rows, cwd: realCwd, env });
			proc.onData(d => conn.send({ kind: "terminal-output", seq: ++this.#eventSeq, payload: { id, data: d } }));
			proc.onExit(({ exitCode }) => {
				this.#terminals.delete(id);
				conn.send({ kind: "terminal-exit", seq: ++this.#eventSeq, payload: { id, code: exitCode } });
			});
			this.#terminals.set(id, {
				async write(msg: { method: string; params?: Record<string, unknown> }): Promise<void> {
					if (msg.method === "input") proc.write(String(msg.params?.data ?? ""));
					else if (msg.method === "resize")
						proc.resize?.(Number(msg.params?.cols) || cols, Number(msg.params?.rows) || rows);
					else if (msg.method === "close") proc.kill();
				},
				dispose(): void {
					proc.kill();
				},
			});
			return id;
		} catch {
			// Fall through to the node bridge.
		}

		const { spawn } = await import("node:child_process");
		const { createInterface } = await import("node:readline");
		const bridgePath = path.join(import.meta.dir, "pty-bridge.cjs");
		// node-pty needs a REAL node host — Bun's runtime doesn't drive the
		// native read loop, so pty output never arrives. Probe common node
		// binaries (Electron-spawned daemons have a stripped PATH).
		const nodeBin = await this.#resolveNodeBinary();
		const child = spawn(nodeBin, [bridgePath], {
			stdio: ["pipe", "pipe", "inherit"],
			env: { ...process.env, COLUMNS: String(cols), LINES: String(rows) },
		}) as unknown as {
			stdin: NodeJS.WritableStream;
			stdout: NodeJS.ReadableStream;
			kill(): void;
			on(event: "exit", cb: (code: number | null) => void): void;
			once(event: "error", cb: (err: Error) => void): void;
		};
		const lines = createInterface({ input: child.stdout, crlfDelay: Infinity }) as unknown as {
			on(event: "line", cb: (line: string) => void): void;
			once(event: "line", cb: (line: string) => void): void;
			close(): void;
		};
		let open = false;
		let exitSent = false;
		lines.on("line", line => {
			let msg: { kind?: string; id?: string; data?: string; code?: number; message?: string };
			try {
				msg = JSON.parse(line) as typeof msg;
			} catch {
				return;
			}
			if (msg.kind === "data" && open) {
				conn.send({ kind: "terminal-output", seq: ++this.#eventSeq, payload: { id, data: msg.data ?? "" } });
			} else if (msg.kind === "open") {
				open = true;
			} else if (msg.kind === "exit" && !exitSent) {
				exitSent = true;
				conn.send({ kind: "terminal-exit", seq: ++this.#eventSeq, payload: { id, code: msg.code ?? 0 } });
			} else if (msg.kind === "error") {
				conn.send({ kind: "terminal-error", seq: ++this.#eventSeq, payload: { id, message: msg.message ?? "" } });
			}
		});
		child.on("exit", () => {
			if (!exitSent) {
				exitSent = true;
				conn.send({ kind: "terminal-exit", seq: ++this.#eventSeq, payload: { id, code: -1 } });
			}
			this.#terminals.delete(id);
		});
		const entry = {
			async write(msg: unknown): Promise<void> {
				if (child.stdin.writable) child.stdin.write(`${JSON.stringify(msg)}\n`);
			},
			dispose(): void {
				lines.close();
				child.kill();
			},
		};
		this.#terminals.set(id, entry);
		await new Promise<void>((resolve, reject) => {
			const t = setTimeout(() => reject(new Error("terminal bridge spawn timeout")), 8000);
			lines.once("line", () => {
				clearTimeout(t);
				resolve();
			});
			child.once("error", err => {
				clearTimeout(t);
				reject(err);
			});
		});
		// Send the open request now that the bridge is alive.
		await entry.write({
			method: "open",
			id,
			params: { cwd, cols, rows, shell: process.env.SHELL },
		});
		return id;
	}

	#terminalSeq = 0;

	/** Find a node binary that can host node-pty (spawn-helper fork). */
	async #resolveNodeBinary(): Promise<string> {
		const { existsSync } = await import("node:fs");
		const candidates = [
			process.env.NODE_BINARY,
			"/opt/homebrew/bin/node",
			"/usr/local/bin/node",
			"/opt/local/bin/node",
			"/usr/bin/node",
			"/usr/bin/env node",
		].filter((c): c is string => typeof c === "string");
		for (const c of candidates) {
			if (c === "/usr/bin/env node") return c;
			try {
				if (existsSync(c)) return c;
			} catch {
				// ignore
			}
		}
		return "node";
	}

	async handle(method: string, params: unknown, conn: DaemonConnection): Promise<unknown> {
		switch (method) {
			case "system.meta": {
				// Derived, never hardcoded: MUSEPI_VERSION is baked by the
				// bundle (bundle-dist.ts) or set by src/musepi.ts / the
				// Electron daemon.cjs spawn; VERSION resolves the OMP engine
				// version from pi-utils. version/musepiVersion/engineVersion
				// are split so the GUI can show both numbers separately.
				const musepiVersion = process.env.MUSEPI_VERSION;
				return {
					version: musepiVersion ?? VERSION,
					musepiVersion: musepiVersion ?? null,
					engineVersion: VERSION,
					engine: musepiVersion ? `MusePi ${musepiVersion} (OMP ${VERSION})` : `MusePi (OMP ${VERSION})`,
					dataRoot: getConfigRootDir(),
					configDir: getAgentDir(),
					runtime: `Bun ${process.versions.bun} · ${process.platform}/${process.arch}`,
				};
			}
			case "changelog.startup": {
				// New-version release notes for the GUI announcement panel.
				// Shares the TUI marker file (agentDir), so whichever surface
				// runs first consumes the notes and the other skips them —
				// one source of truth, no double-push. `force` peeks the
				// three most recent entries WITHOUT advancing the marker
				// (manual "what's new" re-open).
				const { parseChangelog, resolveStartupChangelogForDisplay, selectStartupChangelog } =
					await import("../utils/changelog");
				const currentVersion = process.env.MUSEPI_VERSION ?? VERSION;
				const force = (params as { force?: boolean } | undefined)?.force === true;
				if (force) {
					const entries = await parseChangelog(undefined);
					const sel = selectStartupChangelog(entries, "0.0.0", currentVersion);
					return sel
						? { markdown: sel.markdown, latestVersion: sel.latestVersion }
						: null;
				}
				const settings = await this.#settingsForRpc();
				const mode = String(
					settings.get("startup.changelogMode") ?? "summary",
				) as "summary" | "expanded" | "hidden";
				const changelog = await resolveStartupChangelogForDisplay({
					mode,
					currentVersion,
					agentDir: getAgentDir(),
				});
				return changelog
					? { markdown: changelog.markdown, latestVersion: changelog.latestVersion }
					: null;
			}
			case "updates.check": {
				// npm-registry latest-version probe (TUI checkForNewVersion
				// parity). Respects startup.checkUpdate; network failure or
				// up-to-date resolve to null so the GUI never nags.
				const settings = await this.#settingsForRpc();
				if (!settings.get("startup.checkUpdate")) {
					return { latest: null };
				}
				try {
					const res = await fetch("https://registry.npmjs.org/@musepi/pi-coding-agent/latest", {
						signal: AbortSignal.timeout(5_000),
					});
					if (!res.ok) return { latest: null };
					const data = (await res.json()) as { version?: unknown };
					const latest = typeof data.version === "string" ? data.version : undefined;
					const currentVersion = process.env.MUSEPI_VERSION ?? VERSION;
					return { latest: latest && latest !== currentVersion ? latest : null };
				} catch {
					return { latest: null };
				}
			}
			case "system.capabilities":
				return { protocol: 1, capabilities: { subscribe: true } };
			case "system.prewarmStatus":
				// GUI boot splash waits on this (waitForSdkPrewarm in app.tsx)
				// so the first session op is never cold.
				return { ready: sdkPrewarmed };
			case "system.features":
				return {};
			case "session.create":
				return this.#host.createSession((params ?? {}) as { cwd?: string; title?: string; forkOf?: string });
			case "session.list": {
				const cronIds = this.#cronSessionIds();
				return (await this.#host.knownSessions()).map(r => {
					const live = this.#host.get(r.sessionId);
					return {
						id: r.sessionId,
						parentId: r.parentId,
						kind: "session",
						timestamp: new Date(r.updatedAt).toISOString(),
						model: r.model ?? undefined,
						messageCount: r.messageCount,
						cwd: r.cwd || undefined,
						paused: live?.pauseGate.paused === true,
						// Real-time status (kimi 实时提醒 parity): `working` = a
						// live session with a running agent turn (the materialized
						// view's streaming flag — driven by the same turn_start/
						// turn_end wire events the GUI store consumes, so it
						// agrees with the in-chat orb); `live` marks sessions
						// currently held by the daemon (subscribed or streaming)
						// so the GUI can tell a warm session from an idle snapshot.
						working: live?.pauseGate.paused === true ? false : (live?.view.snapshot().state.isStreaming ?? false),
						live: live !== undefined,
						source: cronIds.has(r.sessionId) ? "cron" : undefined,
						// Title = stored auto-title, else the first user message
						// (session.tree parity; the history viewer shows it).
						title:
							r.title ??
							(this.#host.get(r.sessionId)?.autoTitle !== false
								? this.#host.firstUserMessage(r.sessionId)
								: undefined),
					};
				});
			}
			case "history.messages": {
				// One session's message rows (history viewer right pane) —
				// straight from the materialized view-store, no session
				// activation required.
				const p = (params ?? {}) as { sessionId: string; limit?: number };
				return this.#host.sessionMessages(p.sessionId, p.limit ?? 500);
			}
			case "tray.state": {
				// Menu-bar tray snapshot (openchamber tray parity): the
				// session list plus live activity, pending approvals (inline
				// Allow/Deny in the tray menu) and usage — one round-trip
				// per 5s poll, so the tray never fans out RPCs.
				const cronIds = this.#cronSessionIds();
				const sessions = (await this.#host.knownSessions()).map(r => ({
					id: r.sessionId,
					parentId: r.parentId,
					kind: "session",
					timestamp: new Date(r.updatedAt).toISOString(),
					model: r.model ?? undefined,
					messageCount: r.messageCount,
					cwd: r.cwd || undefined,
					paused: this.#host.get(r.sessionId)?.pauseGate.paused ?? false,
					source: cronIds.has(r.sessionId) ? "cron" : undefined,
					title:
						r.title ??
						(this.#host.get(r.sessionId)?.autoTitle !== false
							? this.#host.firstUserMessage(r.sessionId)
							: undefined),
				}));
				const approvals: Array<{
					id: string;
					sessionId: string;
					tool: string;
					prompt: string;
					sessionTitle: string | null;
				}> = [];
				let activeCount = 0;
				for (const id of this.#host.sessions()) {
					const live = this.#host.get(id);
					if (!live) continue;
					if (live.agentSession.isStreaming) activeCount += 1;
					const title = live.agentSession.sessionManager.getSessionName() ?? null;
					for (const [requestId, record] of live.approvals.pending) {
						approvals.push({
							id: requestId,
							sessionId: id,
							tool: record.tool,
							prompt: record.prompt,
							sessionTitle: title,
						});
					}
				}
				let usage: { totalTokens: number; totalCost: number; topModels: { name: string; cost: number }[] } | null =
					null;
				try {
					const stats = await getDashboardStats(null);
					const o = stats.overall;
					usage = {
						totalTokens:
							(o.totalInputTokens ?? 0) +
							(o.totalOutputTokens ?? 0) +
							(o.totalCacheReadTokens ?? 0) +
							(o.totalCacheWriteTokens ?? 0),
						totalCost: o.totalCost ?? 0,
						topModels: (stats.byModel ?? []).slice(0, 3).map(m => ({ name: m.model, cost: m.totalCost })),
					};
				} catch {
					// stats unavailable (no session files yet) — tray omits Usage
				}
				return { sessions, activeCount, approvals, usage };
			}
			case "browser.endpoint": {
				// Shared automation Chromium (same instance the agent drives)
				// — endpoint + stable profile for the settings panel.
				const { browserEndpoint } = await import("./browser-rpc");
				return browserEndpoint(await this.#settingsForRpc(), this.#host.cwd());
			}
			case "browser.tabs": {
				const { browserTabs } = await import("./browser-rpc");
				return browserTabs(await this.#settingsForRpc(), this.#host.cwd());
			}
			case "browser.screenshot": {
				const p = (params ?? {}) as { targetId: string };
				if (!p.targetId) throw new Error("browser.screenshot requires targetId");
				const { browserScreenshot } = await import("./browser-rpc");
				return browserScreenshot(await this.#settingsForRpc(), this.#host.cwd(), p.targetId);
			}
			case "browser.extensions": {
				const { browserExtensions } = await import("./browser-rpc");
				return browserExtensions(await this.#settingsForRpc(), this.#host.cwd());
			}
			case "browser.relayInstall": {
				const { browserRelayInstall } = await import("./browser-rpc");
				return browserRelayInstall();
			}
			case "browser.importChrome": {
				const { browserImportChrome } = await import("./browser-rpc");
				return browserImportChrome(await this.#settingsForRpc(), this.#host.cwd());
			}
			case "browser.clearCache": {
				const { browserClearCache } = await import("./browser-rpc");
				return browserClearCache(await this.#settingsForRpc(), this.#host.cwd());
			}
			case "browser.clearAll": {
				const { browserClearAll } = await import("./browser-rpc");
				return browserClearAll(await this.#settingsForRpc(), this.#host.cwd());
			}
			case "session.tree": {
				// Cross-session tree (OMP /tree): sessions fork from a parent
				// (parentId) into a hierarchy. Roots have no parent.
				const rows = await this.#host.knownSessions();
				const cronIds = this.#cronSessionIds();
				const nodes = new Map<
					string,
					{
						entry: {
							type: string;
							id: string;
							parentId: string | null;
							timestamp: string;
							label?: string;
							source?: string;
						};
						children: unknown[];
					}
				>();
				const roots: unknown[] = [];
				for (const r of rows) {
					const title =
						r.title ??
						(this.#host.get(r.sessionId)?.autoTitle !== false
							? this.#host.firstUserMessage(r.sessionId)
							: undefined);
					nodes.set(r.sessionId, {
						entry: {
							type: "session",
							id: r.sessionId,
							parentId: r.parentId,
							timestamp: new Date(r.updatedAt).toISOString(),
							source: cronIds.has(r.sessionId) ? "cron" : undefined,
							// Title = first user request (opencode/Codex convention);
							// omit when empty so the GUI falls back to the id.
							...(title ? { label: title.length > 60 ? `${title.slice(0, 60)}…` : title } : {}),
						},
						children: [],
					});
				}
				for (const r of rows) {
					const node = nodes.get(r.sessionId);
					if (!node) continue;
					const parent = r.parentId ? nodes.get(r.parentId) : undefined;
					if (parent) {
						(parent.children as unknown[]).push(node);
					} else {
						roots.push(node);
					}
				}
				return roots;
			}
			case "session.search": {
				const p = (params ?? {}) as { query: string; limit?: number };
				const matches = this.#host.searchMessages(p.query, p.limit ?? 50);
				// Group by session, newest first (store already orders by time).
				const bySession = new Map<string, (typeof matches)[number][]>();
				for (const m of matches) {
					const list = bySession.get(m.sessionId) ?? [];
					list.push(m);
					bySession.set(m.sessionId, list);
				}
				return {
					matches,
					sessions: [...bySession.entries()].map(([sessionId, msgs]) => ({
						sessionId,
						messageCount: msgs.length,
					})),
				};
			}
			case "session.subscribe": {
				const p = (params ?? {}) as { sessionId: string };
				await this.#host.subscribe(p.sessionId, conn);
				return { stream: conn.id, initial: await this.#host.snapshot(p.sessionId) };
			}
			case "index.status": {
				// Workspace file-index state (settings → 索引库 → 代码库).
				return this.#host.ensureFileIndex().status();
			}
			case "index.setEnabled": {
				const p = (params ?? {}) as { enabled?: boolean };
				this.#host.ensureFileIndex().setEnabled(p.enabled ?? false);
				return this.#host.ensureFileIndex().status();
			}
			case "index.scan": {
				// Fire-and-forget background scan of the workspace dir
				// (cwd fallback: this daemon's launch directory).
				const p = (params ?? {}) as { cwd?: string };
				const index = this.#host.ensureFileIndex();
				const dir = p.cwd ? path.resolve(p.cwd) : this.#host.cwd();
				// Don't await — the GUI polls index.status for progress.
				void index.scan(dir).catch(err => console.error("[file-index] scan failed:", err));
				return index.status();
			}
			case "index.search": {
				const p = (params ?? {}) as { query?: string; limit?: number };
				return this.#host.ensureFileIndex().search(p.query ?? "", p.limit ?? 30);
			}
			case "stats.sync": {
				// Usage-stats sync (CLI `omp stats` parity): incrementally
				// scan every session file (mtime/offset skip) into the shared
				// SQLite stats db. GUI settings → 数据与统计 → 使用统计.
				const { syncAllSessions } = await import("@musepi/omp-stats");
				return await syncAllSessions();
			}
			case "stats.dashboard": {
				// Aggregated usage dashboard (model/folder/time-series/cost).
				const { getDashboardStats } = await import("@musepi/omp-stats");
				const { range } = (params ?? {}) as { range?: string };
				return await getDashboardStats(typeof range === "string" && range ? range : null);
			}
			case "stats.tools": {
				// Tool-usage dashboard (calls per tool, by model).
				const { getToolDashboardStats } = await import("@musepi/omp-stats");
				return await getToolDashboardStats();
			}
			case "session.pauseStatus": {
				// Return the selected session's freeze state (TUI `/pause`
				// parity, but per-session: each daemon session owns an
				// AgentPauseGate, so pausing one session never freezes the
				// others). Live transitions ride the session stream as
				// `pause-state` envelopes once subscribed.
				const p = (params ?? {}) as { sessionId?: string };
				if (!p.sessionId) throw new Error("sessionId required");
				const live = this.#host.get(p.sessionId) ?? (await this.#host.activate(p.sessionId));
				return { paused: live.pauseGate.paused, pausedAt: live.pauseGate.pausedAt ?? null };
			}
			case "session.pause": {
				const p = (params ?? {}) as { sessionId?: string };
				if (!p.sessionId) throw new Error("sessionId required");
				const live = this.#host.get(p.sessionId) ?? (await this.#host.activate(p.sessionId));
				const engaged = live.pauseGate.pause();
				return { engaged, paused: live.pauseGate.paused, pausedAt: live.pauseGate.pausedAt ?? null };
			}
			case "session.pauseRelease": {
				const p = (params ?? {}) as { sessionId?: string };
				if (!p.sessionId) throw new Error("sessionId required");
				const live = this.#host.get(p.sessionId) ?? (await this.#host.activate(p.sessionId));
				const duration = live.pauseGate.resume();
				return { duration: duration ?? null, paused: live.pauseGate.paused };
			}
			case "daemon.pauseStatus": {
				// Process-global freeze (TUI /pause parity) across every session
				// in the daemon: engages agentPauseGate, which every agent loop
				// consults BEFORE its own per-session gate, so a global pause
				// freezes main/subagent/advisor loops of ALL sessions while
				// leaving each session's own pause state untouched. Subscribes
				// the connection to global-pause-state broadcasts.
				this.#pauseConns.add(conn);
				return { paused: agentPauseGate.paused, pausedAt: agentPauseGate.pausedAt ?? null };
			}
			case "daemon.pause": {
				const engaged = agentPauseGate.pause();
				return { engaged, paused: agentPauseGate.paused, pausedAt: agentPauseGate.pausedAt ?? null };
			}
			case "daemon.pauseRelease": {
				const duration = agentPauseGate.resume();
				return { duration: duration ?? null, paused: agentPauseGate.paused };
			}
			case "plugins.list": {
				// Session-independent extension scan (settings → plugins tab).
				// Mirrors the CLI extension discovery; TTL-cached like the
				// session-dir scan so list refreshes don't re-walk the FS.
				if (!this.#pluginsCache || Date.now() - this.#pluginsCache.at > 10_000) {
					const { discoverExtensionPaths } = await import("../extensibility/extensions");
					const { loadExtensions } = await import("../extensibility/extensions/loader");
					const cwd = this.#host.cwd();
					const paths = await discoverExtensionPaths([], cwd);
					const result = await loadExtensions(paths, cwd);
					this.#pluginsCache = {
						at: Date.now(),
						plugins: result.extensions.map(ext => ({
							path: ext.path,
							label: ext.label ?? null,
							tools: ext.tools.size,
							commands: ext.commands.size,
							handlers: ext.handlers.size,
						})),
						errors: result.errors,
					};
				}
				return this.#pluginsCache;
			}
			case "skills.list": {
				// Session-independent skill discovery (settings → skills tab).
				const skills = await this.#getSkills();
				// Per-skill enablement is computed at response time (NOT
				// cached): skills.ignoredSkills is what the agent loop applies
				// (loadSkills glob patterns), and the toggles below write it.
				const settings = this.#host.settings();
				const ignored = (settings?.get("skills.ignoredSkills") ?? []) as string[];
				const list = skills.map(s => ({
					...s,
					ignored: ignored.some(pattern => new Bun.Glob(pattern).match(s.name)),
				}));
				return { skills: list, warnings: this.#skillsCache!.warnings };
			}
			case "skills.delete": {
				// Remove a user-level skill's SKILL.md. Refuses builtin /
				// omp-managed skills (auto-learn) — the GUI mirrors this guard.
				const p = (params ?? {}) as { name: string };
				const skills = await this.#getSkills();
				const skill = skills.find(s => s.name === p.name);
				if (!skill) throw new Error(`unknown skill: ${p.name}`);
				const src = skill._source;
				if (src?.level !== "user" || src.provider === "omp-managed" || src.provider === "native") {
					throw new Error("only user-level skills can be deleted");
				}
				const { rm } = await import("node:fs/promises");
				await rm(skill.filePath, { force: true });
				this.#skillsCache = null;
				return { ok: true };
			}
			case "skills.read": {
				// SKILL.md source for the skill detail pane (OpenCode parity).
				const p = (params ?? {}) as { name: string };
				const skills = await this.#getSkills();
				const skill = skills.find(s => s.name === p.name);
				if (!skill) throw new Error(`unknown skill: ${p.name}`);
				const { readFile } = await import("node:fs/promises");
				const content = await readFile(skill.filePath, "utf8");
				return {
					name: skill.name,
					filePath: skill.filePath,
					content: content.length > 64 * 1024 ? `${content.slice(0, 64 * 1024)}\n… (truncated)` : content,
				};
			}
			case "context.list": {
				// Context files (AGENTS.md / CLAUDE.md …) for the extensions
				// center (skills + context unified view). Paths + level only —
				// content is served lazily via fs.read when a detail opens.
				const { discoverContextFiles } = await import("../sdk");
				const files = await discoverContextFiles(this.#host.cwd());
				const cwd = this.#host.cwd();
				return {
					contexts: files.map(f => ({
						path: f.path,
						name: path.basename(f.path),
						rel: f.path.startsWith(cwd) ? path.relative(cwd, f.path) : f.path,
						level: (f as { level?: string }).level ?? "project",
						depth: f.depth,
					})),
				};
			}
			case "extensions.list": {
				// 扩展控制中心统一数据源 (TUI /extensions parity): all 10
				// capability kinds normalized to one Extension shape with
				// three states (active/disabled/shadowed). raw is heavy and
				// served lazily via extensions.raw for the inspector.
				const extensions = await this.#getExtensions();
				const { buildProviderTabs } = await import("../modes/components/extensions/state-manager");
				const tabs = buildProviderTabs(extensions);
				const { getAllProvidersInfo } = await import("../capability");
				const providers = getAllProvidersInfo().map(p => ({
					id: p.id,
					displayName: p.displayName,
					enabled: p.enabled,
				}));
				return {
					extensions: extensions.map(({ raw: _raw, ...rest }) => rest),
					tabs,
					providers,
				};
			}
			case "extensions.raw": {
				// Raw capability item for the inspector panel (JSON, capped).
				const p = (params ?? {}) as { id: string };
				const extensions = await this.#getExtensions();
				const ext = extensions.find(e => e.id === p.id);
				if (!ext) throw new Error(`unknown extension: ${p.id}`);
				const text = JSON.stringify(ext.raw, null, 2);
				return { raw: text.length > 16 * 1024 ? `${text.slice(0, 16 * 1024)}\n… (truncated)` : text };
			}
			case "extensions.setEnabled": {
				// Item toggle (TUI /extensions parity): writes
				// settings.disabledExtensions with the same `kind:name` ids
				// the dashboard uses. MCP toggles route through the canonical
				// mcp.json denylist so /mcp list, the MCP runtime and this
				// center agree (issue #3827).
				const p = (params ?? {}) as { id: string; enabled: boolean };
				let settings = this.#host.settings();
				if (!settings) {
					await this.#host.ensureRegistry();
					settings = this.#host.settings();
				}
				if (!settings) throw new Error("settings unavailable");
				if (p.id.startsWith("mcp:")) {
					const { setMcpServerEnabled } = await import("../mcp/config-writer");
					const { getMCPConfigPath } = await import("@musepi/pi-utils");
					await setMcpServerEnabled({
						userPath: getMCPConfigPath("user", this.#host.cwd()),
						projectPath: getMCPConfigPath("project", this.#host.cwd()),
						sourcePath: undefined,
						name: p.id.slice("mcp:".length),
						enabled: p.enabled,
					});
					// Reconcile legacy `mcp:<name>` flags in disabledExtensions
					// (TUI parity) so a stale entry doesn't keep the server
					// marked disabled after re-enabling via the UI.
					const stored = [...((settings.get("disabledExtensions") ?? []) as string[])];
					const had = stored.indexOf(p.id);
					if (p.enabled && had !== -1) {
						stored.splice(had, 1);
						settings.set("disabledExtensions", stored);
						await settings.flush();
					}
				} else {
					const disabled = [...((settings.get("disabledExtensions") ?? []) as string[])];
					const i = disabled.indexOf(p.id);
					if (p.enabled && i >= 0) disabled.splice(i, 1);
					if (!p.enabled && i < 0) disabled.push(p.id);
					settings.set("disabledExtensions", disabled);
					await settings.flush();
				}
				this.#extensionsCache = null;
				return { ok: true };
			}
			case "extensions.setProviderEnabled": {
				// Provider-level toggle (TUI parity): enableProvider /
				// disableProvider persist to settings.disabledProviders;
				// flush here so the change survives a daemon restart (the
				// capability layer only settings.set's).
				const p = (params ?? {}) as { providerId: string; enabled: boolean };
				if (p.providerId === "native") throw new Error("native provider cannot be toggled");
				const { enableProvider, disableProvider, getAllProvidersInfo } = await import("../capability");
				if (!getAllProvidersInfo().some(pr => pr.id === p.providerId)) {
					throw new Error(`unknown provider: ${p.providerId}`);
				}
				if (p.enabled) enableProvider(p.providerId);
				else disableProvider(p.providerId);
				const settings = this.#host.settings();
				if (settings) await settings.flush();
				this.#extensionsCache = null;
				return { ok: true };
			}
			case "board.list": {
				// Boards persist on the daemon (~/.musepi/boards/boards.json)
				// so the GUI, the agent and other windows share one store
				// (localStorage was the fallback for the offline GUI).
				const { readBoards } = await import("./boards");
				return { boards: readBoards() };
			}
			case "board.save": {
				const { boards } = (params ?? {}) as { boards?: unknown };
				const { readBoards, validateBoards, writeBoards } = await import("./boards");
				const { WIDGET_TYPES } = await import("../tools/widget");
				const check = validateBoards(boards, WIDGET_TYPES);
				if (!check.ok) throw new Error(`board.save: ${check.error}`);
				const list = boards as Array<{ id?: string; builtin?: boolean }>;
				// Builtin examples are protected: a full-list overwrite from
				// any client must not drop them (agents can't modify them, so
				// they always come back factory-fresh).
				const current = readBoards();
				const currentBuiltin = current.filter(b => b.builtin === true && !list.some(x => x.id === b.id));
				if (currentBuiltin.length > 0) writeBoards([...(boards as never[]), ...(currentBuiltin as never[])]);
				else writeBoards(boards as never);
				return { ok: true, boards: readBoards() };
			}
			case "cron.list": {
				return { tasks: this.#cronTasks, runs: this.#cronRuns.slice(-20) };
			}
			case "cron.upsert": {
				const { task } = (params ?? {}) as { task?: unknown };
				const check = validateCronTask(task);
				if (!check.ok) throw new Error(`cron.upsert: ${check.error}`);
				const t = task as CronTask;
				const now = Date.now();
				const existing = t.id ? this.#cronTasks.find(x => x.id === t.id) : undefined;
				const merged: CronTask = existing
					? { ...existing, ...t, state: { ...existing.state, ...t.state } }
					: {
							id: t.id && /^[a-z0-9-]+$/i.test(t.id) ? t.id : `cron-${now.toString(36)}`,
							name: t.name,
							enabled: t.enabled !== false,
							schedule: t.schedule,
							prompt: t.prompt,
							cwd: t.cwd || process.cwd(),
							state: { ...t.state, createdAt: now },
						};
				if (merged.enabled) merged.state.nextRunAt = computeNextRun(merged, now) ?? undefined;
				else merged.state.nextRunAt = undefined;
				if (existing) {
					this.#cronTasks = this.#cronTasks.map(x => (x.id === existing.id ? merged : x));
				} else {
					this.#cronTasks.push(merged);
				}
				saveCronTasks(this.#cronTasks);
				return { tasks: this.#cronTasks, task: merged };
			}
			case "cron.delete": {
				const { id, cleanup } = (params ?? {}) as { id?: string; cleanup?: "none" | "archive" | "delete" };
				if (!id) throw new Error("cron.delete: id required");
				const task = this.#cronTasks.find(t => t.id === id);
				this.#cronTasks = this.#cronTasks.filter(t => t.id !== id);
				this.#cronStarting.delete(id);
				saveCronTasks(this.#cronTasks);
				// Task-scoped session disposal (GUI asks after the delete
				// confirm dialog): "delete" removes each session the task ever
				// ran — journal, materialized row AND the SDK transcript file
				// (deleteSession now removes the transcript too), so the
				// file-scan history cannot resurrect it.
				if (cleanup === "delete" && task) {
					const sessionIds = new Set<string>();
					if (task.state.lastSessionId) sessionIds.add(task.state.lastSessionId);
					for (const run of this.#cronRuns) {
						if (run.taskId === task.id && run.sessionId) sessionIds.add(run.sessionId);
					}
					for (const sid of sessionIds) {
						await this.#host.deleteSession(sid);
					}
					this.#cronRuns = this.#cronRuns.filter(r => r.taskId !== task.id);
					saveCronRuns(this.#cronRuns);
				}
				return { tasks: this.#cronTasks };
			}
			case "cron.toggle": {
				const { id, enabled } = (params ?? {}) as { id?: string; enabled?: boolean };
				const task = this.#cronTasks.find(t => t.id === id);
				if (!task) throw new Error(`cron.toggle: unknown task "${id}"`);
				task.enabled = enabled !== false;
				task.state.nextRunAt = task.enabled ? (computeNextRun(task, Date.now()) ?? undefined) : undefined;
				saveCronTasks(this.#cronTasks);
				return { tasks: this.#cronTasks };
			}
			case "cron.runNow": {
				const { id } = (params ?? {}) as { id?: string };
				const task = this.#cronTasks.find(t => t.id === id);
				if (!task) throw new Error(`cron.runNow: unknown task "${id}"`);
				void this.#cronRun(task);
				return { ok: true, tasks: this.#cronTasks };
			}
			case "widget.schema": {
				// Agent-facing widget schema (widget tool parity): types,
				// fields, defaults and card tones so agents can author board
				// widgets without hardcoding shapes.
				const { WIDGET_TYPES } = await import("../tools/widget");
				const { WIDGET_TONES } = await import("../tools/widget");
				return { types: WIDGET_TYPES, tones: WIDGET_TONES };
			}
			case "git.log": {
				// Recent commit history for the right-pane git view.
				// Runs git in the caller's session cwd (params.cwd), not the
				// daemon cwd — the GUI passes snap.state.cwd. With
				// `graph: true` returns `git log --graph --all` ASCII (the
				// GUI parses it into the commit-graph SVG).
				const p = (params ?? {}) as { cwd?: unknown; graph?: unknown };
				const cwd = path.resolve(typeof p.cwd === "string" && p.cwd.length > 0 ? p.cwd : this.#host.cwd());
				const args =
					p.graph === true
						? ["log", "--graph", "--all", "--oneline", "--decorate", "-n", "60"]
						: ["log", "--oneline", "--decorate", "-n", "30"];
				const proc = Bun.spawnSync({
					cmd: ["git", ...args],
					cwd,
					stdout: "pipe",
					stderr: "pipe",
				});
				if (proc.exitCode !== 0) return { error: "not a git repository" };
				return p.graph === true
					? { graph: proc.stdout.toString().trim() }
					: { commits: proc.stdout.toString().trim() };
			}
			case "git.diff": {
				// Working-tree diff for the right-pane workspace-changes view.
				// Runs git in the caller's session cwd (params.cwd); returns
				// status + staged/unstaged unified diffs (default 200 lines
				// cap per file). An optional `path` narrows to a single file
				// (changes-tree expand).
				const p = (params ?? {}) as { maxLines?: number; path?: string; cwd?: unknown };
				const maxLines = Math.min(500, Math.max(20, p.maxLines ?? 200));
				const cwd = path.resolve(typeof p.cwd === "string" && p.cwd.length > 0 ? p.cwd : this.#host.cwd());
				const run = async (args: string[]): Promise<string> => {
					const proc = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
					return proc.stdout.toString();
				};
				let root = "";
				try {
					root = (await run(["rev-parse", "--show-toplevel"])).trim();
				} catch {
					return { error: "not a git repository" };
				}
				const fileArgs = p.path ? ["--", p.path] : [];
				const [statusRaw, stagedRaw, unstagedRaw] = await Promise.all([
					run(["status", "--short"]),
					run(["diff", "--cached", `--unified=3`, ...fileArgs]),
					run(["diff", `--unified=3`, ...fileArgs]),
				]);
				const cap = (text: string): string =>
					text.length > maxLines * 400 ? `${text.slice(0, maxLines * 400)}\n… (truncated)` : text;
				return {
					root,
					status: statusRaw.trim(),
					staged: cap(stagedRaw),
					unstaged: cap(unstagedRaw),
				};
			}
			case "git.status": {
				// Structured working-tree state for the changes tree: branch,
				// ahead/behind vs upstream, and per-file staged/unstaged/
				// untracked lists (parsed from `status --porcelain=v1`).
				// `ignored: true` also lists gitignored files (--ignored flag,
				// parsed from the `!!` lines) — the settings Git tab toggle.
				//
				// Async spawns (NOT spawnSync — that froze the whole daemon
				// event loop, stalling every session's turn while git ran),
				// and the four probes run concurrently instead of serially.
				const p = (params ?? {}) as { ignored?: boolean; cwd?: unknown };
				const cwd = path.resolve(typeof p.cwd === "string" && p.cwd.length > 0 ? p.cwd : this.#host.cwd());
				const run = (args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> => {
					const proc = Bun.spawn({
						cmd: ["git", ...args],
						cwd,
						stdout: "pipe",
						stderr: "pipe",
					});
					// Belt-and-braces: a hung git (network FS, hooks) must
					// never pin the RPC open forever.
					setTimeout(() => {
						try {
							proc.kill();
						} catch {
							// already exited
						}
					}, 10_000);
					return Promise.all([
						proc.exited.catch(() => null),
						new Response(proc.stdout).text(),
						new Response(proc.stderr).text(),
					]).then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }));
				};
				const [root, branchRaw, aheadRaw, statusRaw] = await Promise.all([
					run(["rev-parse", "--show-toplevel"]),
					run(["branch", "--show-current"]),
					run(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]),
					run(["status", "--porcelain=v1", ...(p.ignored ? ["--ignored"] : [])]),
				]);
				if (root.exitCode !== 0) return { error: "not a git repository" };
				const staged: { path: string; status: string }[] = [];
				const unstaged: { path: string; status: string }[] = [];
				const untracked: { path: string; status: string }[] = [];
				const ignored: { path: string; status: string }[] = [];
				for (const line of statusRaw.stdout.toString().split("\n")) {
					if (!line) continue;
					const x = line[0] ?? " ";
					const y = line[1] ?? " ";
					const file = line.slice(3);
					if (x === "!" && y === "!") ignored.push({ path: file, status: "!!" });
					else if (x === "?" && y === "?") untracked.push({ path: file, status: "??" });
					else {
						if (x !== " " && x !== "?") staged.push({ path: file, status: x });
						if (y !== " ") unstaged.push({ path: file, status: y });
					}
				}
				let ahead = 0;
				let behind = 0;
				if (aheadRaw.exitCode === 0) {
					const [a, b] = aheadRaw.stdout
						.toString()
						.trim()
						.split(/\s+/)
						.map((n: string) => Number.parseInt(n, 10) || 0);
					ahead = a;
					behind = b;
				}
				return {
					root: root.stdout.toString().trim(),
					branch: branchRaw.exitCode === 0 ? branchRaw.stdout.toString().trim() : null,
					ahead,
					behind,
					staged,
					unstaged,
					untracked,
					ignored: p.ignored ? ignored : undefined,
				};
			}
			case "git.stage": {
				// Stage paths into the index (changes panel + button).
				const p = (params ?? {}) as Record<string, unknown>;
				const paths = Array.isArray(p.paths) ? (p.paths as string[]).filter(x => typeof x === "string") : [];
				const cwd = path.resolve(
					typeof p.cwd === "string" && (p.cwd as string).length > 0 ? (p.cwd as string) : this.#host.cwd(),
				);
				const proc = Bun.spawn({ cmd: ["git", "add", "--", ...paths], cwd, stdout: "pipe", stderr: "pipe" });
				setTimeout(() => {
					try {
						proc.kill();
					} catch {
						// already exited
					}
				}, 10_000);
				const [exit, err] = await Promise.all([proc.exited.catch(() => null), new Response(proc.stderr).text()]);
				if (exit !== 0) return { error: err.trim() || "git add failed" };
				return { ok: true };
			}
			case "git.unstage": {
				// Unstage paths (git restore --staged, fallback reset HEAD).
				const p = (params ?? {}) as Record<string, unknown>;
				const paths = Array.isArray(p.paths) ? (p.paths as string[]).filter(x => typeof x === "string") : [];
				const cwd = path.resolve(
					typeof p.cwd === "string" && (p.cwd as string).length > 0 ? (p.cwd as string) : this.#host.cwd(),
				);
				const proc = Bun.spawn({
					cmd: ["git", "restore", "--staged", "--", ...paths],
					cwd,
					stdout: "pipe",
					stderr: "pipe",
				});
				setTimeout(() => {
					try {
						proc.kill();
					} catch {
						// already exited
					}
				}, 10_000);
				const [exit] = await Promise.all([proc.exited.catch(() => null), new Response(proc.stderr).text()]);
				if (exit !== 0) {
					// Older git (pre-2.23) lacks restore — fall back to reset.
					const proc2 = Bun.spawn({
						cmd: ["git", "reset", "HEAD", "--", ...paths],
						cwd,
						stdout: "pipe",
						stderr: "pipe",
					});
					const [exit2, err2] = await Promise.all([
						proc2.exited.catch(() => null),
						new Response(proc2.stderr).text(),
					]);
					if (exit2 !== 0) return { error: err2.trim() || "git unstage failed" };
				}
				return { ok: true };
			}
			case "git.commit": {
				// Commit the staged index. Identity (settings Git tab 身份) is
				// injected per-commit with -c (never writes the repo's local
				// config — openchamber persists it instead, but a desktop
				// setting must not silently mutate the user's repo).
				const p = (params ?? {}) as Record<string, unknown>;
				const message = typeof p.message === "string" ? p.message : "";
				if (!message.trim()) throw new Error("message required");
				const id = (p.identity ?? {}) as Record<string, unknown>;
				const identity = {
					name: typeof id.name === "string" ? id.name : undefined,
					email: typeof id.email === "string" ? id.email : undefined,
				};
				const cwd = path.resolve(
					typeof p.cwd === "string" && (p.cwd as string).length > 0 ? (p.cwd as string) : this.#host.cwd(),
				);
				const args: string[] = [];
				if (identity.name) args.push("-c", `user.name=${identity.name}`);
				if (identity.email) args.push("-c", `user.email=${identity.email}`);
				const [subject, ...body] = message.trim().split("\n");
				const proc = Bun.spawn({
					cmd: ["git", ...args, "commit", "-m", subject, ...(body.length ? ["-m", body.join("\n").trim()] : [])],
					cwd,
					stdout: "pipe",
					stderr: "pipe",
				});
				setTimeout(() => {
					try {
						proc.kill();
					} catch {
						// already exited
					}
				}, 15_000);
				const [exit, out, err] = await Promise.all([
					proc.exited.catch(() => null),
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
				]);
				if (exit !== 0) return { error: err.trim() || out.trim() || "git commit failed" };
				return { ok: true, summary: (out.toString() || err.toString()).trim() };
			}
			case "git.branches": {
				// Local branch list + current branch for the welcome/new-session
				// branch selector (openchamber parity). Runs in the caller's
				// cwd; not a git repo → { error }.
				const p = (params ?? {}) as { cwd?: unknown };
				const cwd = path.resolve(typeof p.cwd === "string" && p.cwd.length > 0 ? p.cwd : this.#host.cwd());
				const current = Bun.spawnSync({
					cmd: ["git", "branch", "--show-current"],
					cwd,
					stdout: "pipe",
					stderr: "pipe",
				});
				const list = Bun.spawnSync({
					cmd: ["git", "for-each-ref", "refs/heads", "--format=%(refname:short)"],
					cwd,
					stdout: "pipe",
					stderr: "pipe",
				});
				if (current.exitCode !== 0 || list.exitCode !== 0) return { error: "not a git repository" };
				const branches = list.stdout
					.toString()
					.trim()
					.split("\n")
					.filter(Boolean)
					.sort((a, b) => a.localeCompare(b));
				return {
					current: current.stdout.toString().trim() || null,
					branches,
				};
			}
			case "git.checkout": {
				// Switch the repo's branch (welcome branch selector). Caller's
				// cwd; uncommitted changes are git's problem (checkout fails
				// with a clear stderr, surfaced to the GUI toast).
				const p = (params ?? {}) as { cwd?: unknown; branch?: unknown };
				const branch = typeof p.branch === "string" && p.branch.length > 0 ? p.branch : "";
				if (!branch) throw new Error("branch required");
				const cwd = path.resolve(typeof p.cwd === "string" && p.cwd.length > 0 ? p.cwd : this.#host.cwd());
				const proc = Bun.spawnSync({
					cmd: ["git", "checkout", branch],
					cwd,
					stdout: "pipe",
					stderr: "pipe",
				});
				if (proc.exitCode !== 0) return { error: proc.stderr.toString().trim() || "git checkout failed" };
				return { ok: true };
			}
			case "remote.hosts":
				return listRemoteHosts();
			case "remote.hostAdd":
				return addRemoteHost((params ?? {}) as Parameters<typeof addRemoteHost>[0]);
			case "remote.connect":
				return connectRemoteHost((params ?? {}) as { name?: unknown });
			case "remote.browse":
				return browseRemoteDir((params ?? {}) as { name?: unknown; path?: unknown });
			case "remote.disconnect":
				return disconnectRemoteHost((params ?? {}) as { name?: unknown });
			case "github.prs": {
				// Pull-request list for the right-pane PR view. Uses the
				// `gh` CLI when available (same credentials the user's shell
				// has); reports a clear error otherwise. Async spawn + 15s
				// cap: `gh pr list` hits the network, and a sync call here
				// froze every session's turn while it hung.
				const gh = ghPath();
				if (gh === null) return { error: "gh CLI not installed" };
				// Session cwd when the caller passes it (GUI PR pane) — the
				// host cwd is the daemon launch dir, which may be a different
				// repo (git RPC cwd-isolation parity).
				const p = (params ?? {}) as { cwd?: string };
				const cwd = p.cwd && p.cwd.trim() !== "" ? path.resolve(p.cwd) : this.#host.cwd();
				const storedToken = readGhToken();
				const proc = Bun.spawn({
					cmd: [
						gh,
						"pr",
						"list",
						"--json",
						"number,title,author,isDraft,state,headRefName,baseRefName,createdAt,url",
					],
					cwd,
					stdout: "pipe",
					stderr: "pipe",
					env: storedToken ? { ...process.env, GH_TOKEN: storedToken.token } : undefined,
				});
				setTimeout(() => {
					try {
						proc.kill();
					} catch {
						// already exited
					}
				}, 15_000);
				const [exitCode, stdout, stderr] = await Promise.all([
					proc.exited.catch(() => null),
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
				]);
				if (exitCode !== 0) {
					const err = stderr.trim();
					return { error: err.includes("not found") ? "gh CLI not installed" : err || "gh unavailable" };
				}
				try {
					return { prs: JSON.parse(stdout) };
				} catch {
					return { error: "invalid gh output" };
				}
			}
			case "github.authStatus": {
				// gh CLI auth state (settings Git tab): login/active account +
				// email. Async spawn + 10s cap — a hung gh (keyring lock) must
				// not freeze the GUI. `gh auth status --json` field names vary
				// across gh versions, so use the text form + `gh api user`.
				const run = async (
					args: string[],
					env?: Record<string, string>,
				): Promise<{ exit: number; out: string; err: string }> => {
					const gh = ghPath();
					if (gh === null) return { exit: -1, out: "", err: "gh CLI not installed" };
					const proc = Bun.spawn({ cmd: [gh, ...args], stdout: "pipe", stderr: "pipe", env });
					setTimeout(() => {
						try {
							proc.kill();
						} catch {
							// already exited
						}
					}, 10_000);
					const [exit, out, err] = await Promise.all([
						proc.exited.catch(() => null),
						new Response(proc.stdout).text(),
						new Response(proc.stderr).text(),
					]);
					return { exit: exit ?? -1, out, err };
				};
				// Daemon-owned token (openchamber pattern) wins: it was saved
				// by the device flow and needs no api.github.com round-trip to
				// be trusted. The keyring (gh CLI manual login) is the
				// fallback path below.
				const stored = readGhToken();
				if (stored) {
					// No blocking network: the device flow already stored
					// login/email (this machine can reach github.com but
					// api.github.com is flaky). Refresh identity in the
					// background; the GUI is not kept waiting.
					void (async () => {
						const who = await run(["api", "user", "--jq", '.login + "\\u0000" + (.email // "")'], {
							...process.env,
							GH_TOKEN: stored.token,
						});
						if (who.exit !== 0) return;
						const [apiLogin, mail] = who.out.trim().split("\0");
						if (!apiLogin) return;
						writeGhToken(stored.token, { login: apiLogin, email: mail || undefined });
					})();
					return {
						installed: true,
						authenticated: true,
						login: stored.login,
						email: stored.email || undefined,
						// Avatar is derived from the login (github.com/<login>.png),
						// not fetched — api.github.com may be unreachable but
						// github.com itself works (device flow proves it).
						avatarUrl: stored.login ? `https://github.com/${stored.login}.png` : undefined,
						active: true,
					};
				}
				if (ghPath() === null) return { installed: false };
				const status = await run(["auth", "status"]);
				if (status.exit !== 0) {
					return { installed: true, authenticated: false, detail: status.err.trim() || status.out.trim() };
				}
				// "Logged in to github.com account MuseLinn (keyring)"
				const loginMatch = /Logged in to github\.com account (\S+)/.exec(status.out);
				const who = await run(["api", "user", "--jq", '.login + "\\u0000" + (.email // "")']);
				let login = loginMatch?.[1];
				let email = "";
				if (who.exit === 0) {
					const [apiLogin, mail] = who.out.trim().split("\0");
					if (apiLogin) login = apiLogin;
					email = mail;
				}
				return {
					installed: true,
					authenticated: true,
					login,
					email: email || undefined,
					avatarUrl: login ? `https://github.com/${login}.png` : undefined,
					active: true,
				};
			}
			case "github.authStart": {
				// GitHub OAuth device flow (same public client the gh CLI
				// ships): returns a user code + verification URL the GUI shows,
				// then polls github.authPoll until the user authorizes.
				let resp: Response;
				try {
					resp = await fetch("https://github.com/login/device/code", {
						method: "POST",
						headers: { Accept: "application/json" },
						body: new URLSearchParams({
							client_id: "178c6fc778ccc68e1d6a",
							scope: "repo read:org gist workflow",
						}),
					});
				} catch (err) {
					return { error: friendlyNetworkError(err) };
				}
				if (!resp.ok) return { error: `device flow start failed (${resp.status})` };
				const body = (await resp.json()) as {
					device_code?: string;
					user_code?: string;
					verification_uri?: string;
					expires_in?: number;
					interval?: number;
					error?: string;
				};
				if (body.error || !body.device_code) return { error: body.error ?? "device flow start failed" };
				return {
					deviceCode: body.device_code,
					userCode: body.user_code,
					verificationUri: body.verification_uri,
					expiresIn: body.expires_in ?? 899,
					interval: body.interval ?? 5,
				};
			}
			case "github.authPoll": {
				// Poll the device-flow authorization; on success the token is
				// imported into the gh keyring (gh auth login --with-token) so
				// every existing gh-based RPC picks it up.
				const p = (params ?? {}) as { deviceCode?: string; interval?: number };
				if (!p.deviceCode) throw new Error("deviceCode required");
				let poll: Response;
				try {
					poll = await fetch("https://github.com/login/oauth/access_token", {
						method: "POST",
						headers: { Accept: "application/json" },
						body: new URLSearchParams({
							client_id: "178c6fc778ccc68e1d6a",
							device_code: p.deviceCode,
							grant_type: "urn:ietf:params:oauth:grant-type:device_code",
						}),
					});
				} catch (err) {
					// Transient network hiccup → keep polling (GitHub device
					// flow guidance); fatal TLS errors surface clearly.
					if (classifyNetworkError(err) === "transient") {
						return { pending: true, interval: Math.max(10, (p.interval ?? 5) + 5) };
					}
					return { error: friendlyNetworkError(err) };
				}
				const body = (await poll.json()) as { access_token?: string; error?: string; error_description?: string };
				if (body.error === "authorization_pending" || body.error === "slow_down") {
					return {
						pending: true,
						interval: Math.max(5, (p.interval ?? 5) + (body.error === "slow_down" ? 5 : 0)),
					};
				}
				if (body.error) return { error: body.error_description ?? body.error };
				if (!body.access_token) return { error: "no access token" };
				// openchamber pattern: persist the token daemon-side instead
				// of `gh auth login --with-token` (whose validation requests
				// api.github.com and fails the whole flow on flaky networks).
				// gh RPCs receive it via GH_TOKEN env.
				writeGhToken(body.access_token);
				// Best-effort identity for the UI; unreachable api.github.com
				// is tolerated — the token itself is already valid.
				const gh = ghPath();
				if (gh !== null) {
					const who = Bun.spawnSync({
						cmd: [gh, "api", "user", "--jq", '.login + "\\u0000" + (.email // "")'],
						stdout: "pipe",
						stderr: "pipe",
						env: { ...process.env, GH_TOKEN: body.access_token },
					});
					if (who.exitCode === 0) {
						const [login, email] = who.stdout.toString().trim().split("\0");
						try {
							fs.writeFileSync(
								ghTokenPath(),
								JSON.stringify(
									{ token: body.access_token, login, email, updatedAt: new Date().toISOString() },
									null,
									2,
								),
								{ mode: 0o600 },
							);
						} catch {
							// keep the basic write
						}
						return { connected: true, login: login || undefined };
					}
				}
				return { connected: true };
			}
			case "github.authLogout": {
				// Drop the daemon-owned token (openchamber pattern); also
				// best-effort `gh auth logout --yes` for a keyring login the
				// user made via the gh CLI directly. 10s cap on the gh spawn.
				clearGhToken();
				const gh = ghPath();
				if (gh === null) return { ok: true };
				const proc = Bun.spawn({
					cmd: [gh, "auth", "logout", "--hostname", "github.com", "--yes"],
					stdout: "pipe",
					stderr: "pipe",
				});
				setTimeout(() => {
					try {
						proc.kill();
					} catch {
						// already exited
					}
				}, 10_000);
				const [exit, err] = await Promise.all([proc.exited.catch(() => null), new Response(proc.stderr).text()]);
				return { ok: exit === 0, detail: exit === 0 ? undefined : err.trim() };
			}
			case "session.resume": {
				const p = (params ?? {}) as { sessionId: string; cursor?: number };
				const snapshot = await this.#host.snapshot(p.sessionId);
				const live = this.#host.get(p.sessionId);
				// Subscription attaches AFTER catch-up (see catchupIfNeeded) so
				// replayed deltas never duplicate live events.
				this.#resumeLive = live ?? null;
				// compactedThrough: the requested cursor predates the compaction
				// checkpoint — deltas between cursor and checkpoint were folded
				// into the snapshot, so the client must refresh derived state.
				const checkpointSeq = await this.#host.checkpointSeq(p.sessionId);
				const compacted = typeof p.cursor === "number" && checkpointSeq > p.cursor;
				return { stream: live ? conn.id : null, snapshot, compactedThrough: compacted };
			}
			case "session.setDraft": {
				// GUI composer un-sent draft state — the daemon-side analogue
				// of the TUI's editor-draft idle-recap guard (a draft present
				// at schedule/fire time suppresses the recap).
				const p = (params ?? {}) as { sessionId?: unknown; draft?: unknown };
				if (typeof p.sessionId !== "string") throw new Error("sessionId required");
				this.#host.setEditorDraft(p.sessionId, p.draft === true);
				return { ok: true };
			}
			case "session.send": {
				const p = (params ?? {}) as {
					sessionId: string;
					text: string;
					deliverAs?: "prompt" | "steer" | "followUp";
					images?: { type: "image"; data: string; mimeType: string }[];
				};
				// Reactivate history sessions on send so continuing an old
				// conversation works (the GUI opens them snapshot-only via
				// session.resume; activation makes them live again).
				const live = this.#host.get(p.sessionId) ?? (await this.#host.activate(p.sessionId));
				// "prompt" (default) = plain sendUserMessage; steer/followUp
				// map to the AgentSession delivery semantics.
				const options = p.deliverAs && p.deliverAs !== "prompt" ? { deliverAs: p.deliverAs } : undefined;
				const images = Array.isArray(p.images) && p.images.length > 0 ? p.images : undefined;
				// Image attachments ride along as content parts (openchamber
				// paste/drag parity); sendUserMessage accepts text+images.}
				const content =
					images && images.length > 0
						? [
								...(p.text ? [{ type: "text" as const, text: p.text }] : []),
								...images.map(img => ({ type: "image" as const, data: img.data, mimeType: img.mimeType })),
							]
						: p.text;
				this.#host.touch(p.sessionId);
				// TUI parity: auto-generate the session title from the first
				// user message (input-controller calls maybeStartTitleGeneration
				// on first submit). The gate inside is idempotent — a session
				// that already has a name (or a low-signal first message, or
				// PI_NO_TITLE) is a no-op — so calling it every send is safe.
				// The GUI's Settings → 会话 → 自动生成会话标题 toggle gates it.
				if (live.autoTitle) {
					const textPart =
						typeof content === "string" ? content : (content.find(c => c.type === "text")?.text ?? "");
					if (textPart) live.agentSession.maybeStartTitleGeneration(textPart);
				}
				await live.agentSession.sendUserMessage(content, options);
				return { accepted: true };
			}
			case "session.revertTo": {
				// Undo / edit-and-reconverse: physically truncate the session
				// to just before a user message (openchamber revert parity).
				// The agent session, the daemon journal and the materialized
				// view all lose the abandoned tail; the client restores the
				// message text into the composer. Works on live sessions (the
				// agent context is truncated too) and history sessions (the
				// journal/view are the whole story there).
				const p = (params ?? {}) as { sessionId: string; messageId: string };
				if (!p.messageId) throw new Error("messageId required");
				const live = this.#host.get(p.sessionId);
				// Backup the tail this revert removes (openchamber
				// RevertedMessageDock Restore parity): every wire entry from
				// the target user message onward, captured BEFORE any
				// truncation so session.restoreRevert can re-emit them.
				let removedTail: SessionEntry[] = [];
				{
					const pre = (
						live ? live.view.snapshot().entries : (await this.#host.snapshot(p.sessionId)).entries
					) as SessionEntry[];
					const idx = pre.findIndex(
						e => typeof e === "object" && e !== null && (e as { id?: unknown }).id === p.messageId,
					);
					if (idx >= 0) removedTail = pre.slice(idx);
				}
				/** Removed raw jsonl records (history-path revert only) — restored
				 *  by re-appending to the SDK transcript file. */
				let removedFileLines: string[] = [];
				let text: string | null = null;
				if (live) {
					// A running turn must stop BEFORE the transcript is cut:
					// otherwise the agent keeps generating against the
					// truncated context and the GUI's reload sees a stale
					// isStreaming → phantom "working" orb + thinking blocks
					// after the revert (user: revert shows thinking again).
					const agent = live.agentSession as unknown as {
						isStreaming: boolean;
						abort(options?: { reason?: string }): Promise<void>;
					};
					if (agent.isStreaming) {
						await agent.abort({ reason: "interrupted" });
						await (live.agentSession as unknown as { waitForIdle?(): Promise<void> }).waitForIdle?.();
					}
					text = await live.agentSession.revertTo(p.messageId);
					if (text === null) {
						// The AgentSession (SDK transcript) and the daemon journal
						// can diverge (e.g. the session was continued elsewhere),
						// so the view's message id may be unknown to the agent.
						// Fall back to a view-only truncation below; the transcript
						// file is left untouched in that case.
						const rawEntry = live.view
							.snapshot()
							.entries.find(
								e =>
									typeof e === "object" &&
									e !== null &&
									(e as { type?: unknown }).type === "message" &&
									(e as { id?: unknown }).id === p.messageId,
							) as { type: "message"; id: string; message: { role?: string; content?: unknown } } | undefined;
						if (rawEntry?.message.role !== "user") throw new Error(`Unknown message: ${p.messageId}`);
						text = extractSnapshotText(rawEntry.message.content);
					}
				} else {
					// History path: pull the text from the snapshot for the
					// composer restore, then truncate journal + view (or the
					// SDK transcript when the daemon never journaled it).
					const snapshot = await this.#host.snapshot(p.sessionId);
					const entry = snapshot.entries.find(
						(e): e is { type: "message"; id: string; message: { role?: string; content?: unknown } } =>
							typeof e === "object" &&
							e !== null &&
							(e as { type?: unknown }).type === "message" &&
							(e as { id?: unknown }).id === p.messageId,
					);
					const msg = entry && entry.message.role === "user" && entry.id === p.messageId ? entry : null;
					if (!msg) throw new Error(`Unknown message: ${p.messageId}`);
					text = extractSnapshotText(msg.message.content);
				}
				// History path (no live agent): truncate the SDK transcript
				// file itself — keep the header + every record up to
				// (excluding) the target message. Runs UNCONDITIONALLY for
				// non-live sessions: even when the journal covers the session
				// (it idled out), the file is what the next resume re-projects
				// the view from — leaving it whole silently undoes the revert.
				let file = "";
				if (!live) {
					const { resolveResumableSession } = await import("../session/session-listing");
					const match = await resolveResumableSession(p.sessionId, this.#host.cwd());
					if (!match) throw new Error(`Unknown session: ${p.sessionId}`);
					file = match.session.path;
					const lines = (await fs.promises.readFile(file, "utf8")).split("\n");
					let keep = 0;
					let found = false;
					for (let i = 1; i < lines.length; i++) {
						const line = lines[i];
						if (!line?.trim()) continue;
						try {
							const rec = JSON.parse(line) as {
								type?: string;
								id?: string;
								message?: { role?: string; timestamp?: number | string; toolCallId?: string };
							};
							if (rec.type === "message") {
								// Match either the jsonl id (SDK hex) or the view's
								// messageKey ("role:timestamp") — the GUI always sends
								// the view key, which jsonl ids never equal.
								const key =
									rec.message &&
									(rec.message.role === "toolResult"
										? `toolResult:${rec.message.toolCallId}`
										: `${rec.message.role}:${rec.message.timestamp}`);
								if (rec.id === p.messageId || key === p.messageId) {
									found = true;
									break;
								}
							}
						} catch {
							// malformed line — treat as content to keep
						}
						keep = i;
					}
					if (!found) throw new Error(`Unknown message: ${p.messageId}`);
					await fs.promises.writeFile(file, `${lines.slice(0, keep + 1).join("\n")}\n`);
					// Keep the removed jsonl records so a later restoreRevert
					// can re-append them (history sessions have no SDK agent
					// to re-insert from).
					removedFileLines = lines.slice(keep + 1).filter(l => l?.trim());
				}
				const cursor = await this.#host.truncateSession(p.sessionId, p.messageId);
				if (cursor < 0) {
					// The journal locates messages by their view key
					// ("role:timestamp"); the GUI sends the transcript id
					// (rec.id). For live sessions map through the view entry;
					// the AgentSession already truncated its memory (and
					// rewrites the jsonl on flush), so journal+view are all
					// that remain.
					if (live) {
						const rawEntry = live.view
							.snapshot()
							.entries.find(
								e =>
									typeof e === "object" &&
									e !== null &&
									(e as { type?: unknown }).type === "message" &&
									(e as { id?: unknown }).id === p.messageId,
							) as { type: "message"; message: { role: string; timestamp?: number | string } } | undefined;
						if (!rawEntry) throw new Error(`Unknown message: ${p.messageId}`);
						const key = messageKey(rawEntry.message as WireMessage);
						const journalCursor = await this.#host.truncateSession(p.sessionId, key);
						if (journalCursor < 0) {
							// Fresh journal (session activated after its history
							// was written): nothing to truncate on disk — rebuild
							// the live view from the agent's (already truncated)
							// in-memory transcript.
							const sdkEntries = (
								live.agentSession.sessionManager as { getEntries?: () => SessionEntry[] } | null
							)?.getEntries?.();
							if (!sdkEntries) throw new Error(`Unknown message in journal: ${p.messageId}`);
							const rebuilt = MaterializedView.fromSnapshot(p.sessionId, live.view.snapshot().state.cwd ?? "", {
								entries: sdkEntries,
								state: live.view.snapshot().state,
								cursor: sdkEntries.length,
								agents: [],
							});
							if (!rebuilt) throw new Error(`Unknown message in journal: ${p.messageId}`);
							live.view = rebuilt;
							live.seq = rebuilt.cursor;
							this.#host.persistSnapshot(p.sessionId, rebuilt.snapshot());
						}
					} else {
						// No journal for this session (CLI-created, never
						// journaled): the file above was already truncated —
						// if a view got activated meanwhile (subscribe raced
						// the revert), re-project it from the shortened file.
						const activated = this.#host.get(p.sessionId);
						if (activated) {
							const projected = await snapshotFromJsonl(file, p.sessionId);
							const rebuilt =
								MaterializedView.fromSnapshot(
									p.sessionId,
									activated.view.snapshot().state.cwd ?? "",
									projected,
								) ?? activated.view;
							activated.view = rebuilt;
							activated.seq = rebuilt.cursor;
							for (const send of activated.subscribers.values()) {
								try {
									send({ kind: "state", seq: ++activated.seq, payload: rebuilt.snapshot().state });
								} catch {
									// subscriber socket died; removed on close
								}
							}
						}
					}
				}
				if (live) {
					// Notify subscribers so live GUIs can reload the snapshot.
					for (const send of live.subscribers.values()) {
						try {
							send({ kind: "state", seq: ++live.seq, payload: live.view.snapshot().state });
						} catch {
							// subscriber socket died; removed on close
						}
					}
				}
				// The revert succeeded — keep the backup for restoreRevert.
				if (removedTail.length > 0) {
					const backups = this.#host.revertBackupsFor(p.sessionId);
					backups.push({ wireEntries: removedTail, fileLines: removedFileLines, text: text ?? "", messageId: p.messageId });
				}
				return { ok: true, text, cursor };
			}
			case "session.restoreRevert": {
				// Undo session.revertTo (openchamber RevertedMessageDock
				// Restore parity): put an abandoned tail back — agent context
				// (live), SDK transcript file (history), journal and view.
				// {index} restores that single revert (还原单轮),
				// {all: true} every revert (还原全部); without either, the
				// latest revert (backward-compatible). Backups are
				// push-ordered oldest-first; restore newest-first so
				// re-appending tails reconstructs the pre-revert transcript
				// in order — overlapping tails (a newer revert truncates
				// deeper) are deduped by wire message key vs the view.
				const p = (params ?? {}) as { sessionId: string; index?: number; all?: boolean };
				const backups = this.#host.revertBackupsFor(p.sessionId);
				const selected =
					p.all === true
						? [...backups].reverse()
						: p.index !== undefined
							? backups[p.index] !== undefined
								? [backups[p.index]]
								: []
							: backups.length > 0
								? [backups[backups.length - 1]]
								: [];
				if (selected.length === 0) return { ok: false, reason: "no-revert" };
				const live = this.#host.get(p.sessionId);
				// Dedup: never re-insert a message already present in the
				// view (nested reverts back up overlapping tails).
				const existingKeys = new Set<string>();
				{
					const current = (
						live ? live.view.snapshot().entries : (await this.#host.snapshot(p.sessionId)).entries
					) as SessionEntry[];
					for (const e of current) {
						if (e.type === "message") existingKeys.add(messageKey(e.message as WireMessage));
					}
				}
				const dedupEntries = (
					entries: SessionEntry[],
				): Array<Extract<SessionEntry, { type: "message" }>> =>
					entries.filter((e): e is Extract<SessionEntry, { type: "message" }> => {
						if (e.type !== "message") return false;
						const key = messageKey(e.message as WireMessage);
						if (existingKeys.has(key)) return false;
						existingKeys.add(key);
						return true;
					});
				const dedupFileLines = async (lines: string[], file: string): Promise<string[]> => {
					// Dedup against the CURRENT transcript file, not the wire
					// entries: the raw records carry the same messages, so
					// re-appending them must skip records the file already has
					// (e.g. the file was never truncated — nothing to restore).
					const present = new Set<string>();
					try {
						const cur = (await fs.promises.readFile(file, "utf8")).split("\n");
						for (const line of cur) {
							if (!line?.trim()) continue;
							try {
								const rec = JSON.parse(line) as {
									type?: string;
									message?: { role?: string; timestamp?: number | string; toolCallId?: string };
								};
								if (rec.type === "message" && rec.message) {
									present.add(
										rec.message.role === "toolResult"
											? `toolResult:${rec.message.toolCallId}`
											: `${rec.message.role}:${rec.message.timestamp}`,
									);
								}
							} catch {
								// malformed existing line — ignore for dedup
							}
						}
					} catch {
						// file missing — treat as empty
					}
					const out: string[] = [];
					for (const line of lines) {
						if (!line?.trim()) continue;
						try {
							const rec = JSON.parse(line) as {
								type?: string;
								message?: { role?: string; timestamp?: number | string; toolCallId?: string };
							};
							const key =
								rec.type === "message" && rec.message
									? rec.message.role === "toolResult"
										? `toolResult:${rec.message.toolCallId}`
										: `${rec.message.role}:${rec.message.timestamp}`
									: null;
							if (key && present.has(key)) continue;
							if (key) present.add(key);
						} catch {
							// malformed line — restore it as-is
						}
						out.push(line);
					}
					return out;
				};
				let restored = 0;
				for (const backup of selected) {
					const entries = dedupEntries(backup.wireEntries);
					if (entries.length === 0) continue;
					if (live) {
						const agent = live.agentSession as unknown as {
							restoreRevert?: (tail: SessionEntry[]) => Promise<boolean>;
						};
						const ok = await agent.restoreRevert?.(entries);
						if (!ok) return { ok: false, reason: "no-agent-tail", restored };
						// Re-emit the removed messages into the journal + view
						// and fan them out so subscribed GUIs re-render the tail.
						for (const entry of entries) {
							const msg = entry.message as WireMessage;
							for (const wireEvent of [
								{ type: "message_start", message: msg },
								{ type: "message_end", message: msg },
							] as AgentEvent[]) {
								live.journal?.append(wireEvent as never);
								live.view.apply(wireEvent as never);
								const seq = ++live.seq;
								for (const send of live.subscribers.values()) {
									try {
										send({ kind: "event", seq, payload: wireEvent });
									} catch {
										// subscriber socket died; removed on close
									}
								}
							}
						}
						this.#host.persistSnapshot(p.sessionId, live.view.snapshot());
						for (const send of live.subscribers.values()) {
							try {
								send({ kind: "state", seq: ++live.seq, payload: live.view.snapshot().state });
							} catch {
								// subscriber socket died; removed on close
							}
						}
					} else {
						// History path: restore the SDK transcript file (the
						// raw records cut by the revert), then rebuild the
						// journal + view from the restored tail.
						const { resolveResumableSession } = await import("../session/session-listing");
						const match = await resolveResumableSession(p.sessionId, this.#host.cwd());
						if (match) {
							const file = match.session.path;
							const fileLines = await dedupFileLines(backup.fileLines, file);
							if (fileLines.length > 0) {
								await fs.promises.appendFile(file, `${fileLines.join("\n")}\n`);
							}
						}
						const journal = new AppendJournal(JOURNAL_DIR, p.sessionId);
						await journal.open();
						try {
							for (const entry of entries) {
								const msg = entry.message as WireMessage;
								journal.append({ type: "message_start", message: msg } as never);
								journal.append({ type: "message_end", message: msg } as never);
							}
							const { events } = await journal.replaySource();
							const snapshot = await this.#host.snapshot(p.sessionId);
							const cwd =
								typeof snapshot.state === "object" &&
								snapshot.state !== null &&
								typeof (snapshot.state as { cwd?: unknown }).cwd === "string"
									? ((snapshot.state as { cwd: string }).cwd ?? "")
									: (this.#host.cwd() ?? "");
							const view = MaterializedView.replay(p.sessionId, cwd, events);
							// Keep totals of rounds completed before the revert that
							// produced this backup (replay records none).
							view.seedRoundDurations(
								(snapshot as { roundDurations?: [number, number][] }).roundDurations,
							);
							this.#host.persistSnapshot(p.sessionId, view.snapshot());
						} finally {
							void journal.close();
						}
					}
					restored++;
				}
				// Drop the restored backups from the stack.
				if (p.all === true) {
					this.#host.clearRevertBackups(p.sessionId);
				} else if (p.index !== undefined && backups[p.index]) {
					backups.splice(p.index, 1);
					if (backups.length === 0) this.#host.clearRevertBackups(p.sessionId);
				} else if (backups.length > 0) {
					backups.pop();
					if (backups.length === 0) this.#host.clearRevertBackups(p.sessionId);
				}
				return { ok: true, restored };
			}
			case "session.revertList": {
				// The revert-dock contents (openchamber RevertedMessageDock
				// parity): one entry per backed-up revert, oldest first — the
				// daemon is the single source of truth so GUI state never
				// drifts from what restoreRevert can actually restore.
				const p = (params ?? {}) as { sessionId: string };
				const backups = this.#host.revertBackupsFor(p.sessionId);
				return { items: backups.map((b, i) => ({ index: i, text: b.text, messageId: b.messageId })) };
			}
			case "session.discardRevert": {
				// Drop a revert backup without restoring it (dock 丢弃): the
				// GUI's local list removal used to drift from the daemon's
				// stack — now both sides agree through this RPC.
				const p = (params ?? {}) as { sessionId: string; index?: number };
				const backups = this.#host.revertBackupsFor(p.sessionId);
				if (p.index !== undefined && backups[p.index]) backups.splice(p.index, 1);
				else if (p.index === undefined) backups.splice(0, backups.length);
				if (backups.length === 0) this.#host.clearRevertBackups(p.sessionId);
				return { ok: true };
			}
			case "session.abort": {
				const p = (params ?? {}) as { sessionId: string };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				await live.agentSession.abort({ reason: "interrupted" });
				return { ok: true };
			}
			case "session.ephemeralAsk": {
				// Throwaway question (CLI --no-session parity): answer a
				// prompt with the session's model WITHOUT recording anything
				// to the transcript, journal or SDK file. Backed by
				// AgentSession.runEphemeralTurn (the idle-recap side
				// channel), which is explicitly safe to run while the main
				// turn is mid-tool-call (dedicated provider side-channel
				// session id). Powers the GUI selection→ask popover.
				const p = (params ?? {}) as { sessionId: string; promptText: string };
				if (!p.sessionId) throw new Error("sessionId required");
				if (!p.promptText?.trim()) throw new Error("promptText required");
				const live = this.#host.get(p.sessionId) ?? (await this.#host.activate(p.sessionId));
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				const { replyText } = await live.agentSession.runEphemeralTurn({ promptText: p.promptText });
				return { replyText };
			}
			case "session.forkAt": {
				// Non-destructive fork (GUI 分叉): copy the parent session's
				// transcript truncated at the target message into a new
				// session file (new id, parentSession header). The parent is
				// untouched — unlike session.revertTo this never mutates the
				// original. Works for live and history sessions.
				// `includeTarget: true` keeps the target record as the new
				// session's LAST record (TUI navigateTree parity for non-user
				// nodes — the leaf lands ON the node, e.g. an assistant reply
				// or toolResult stays and the user continues from there).
				// Default (false) truncates BEFORE the target — the user-message
				// case, whose text is backfilled into the composer to re-answer.
				const p = (params ?? {}) as { sessionId: string; messageId: string; includeTarget?: boolean };
				if (!p.messageId) throw new Error("messageId required");
				const live = this.#host.get(p.sessionId);
				// Flush a live session's pending writes so the file on disk
				// reflects everything the agent has produced.
				if (live) {
					const mgr = (
						live.agentSession as unknown as {
							sessionManager?: { flush?(): Promise<unknown> };
						}
					)?.sessionManager;
					await mgr?.flush?.();
				}
				const { resolveResumableSession } = await import("../session/session-listing");
				const match = await resolveResumableSession(p.sessionId, this.#host.cwd());
				if (!match) throw new Error(`Unknown session: ${p.sessionId}`);
				const file = match.session.path;
				const lines = (await fs.promises.readFile(file, "utf8")).split("\n");
				let header: Record<string, unknown> = {};
				try {
					header = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
				} catch {
					// missing/partial header — tolerate, keep going
				}
				let keep = 0;
				let found = false;
				for (let i = 1; i < lines.length; i++) {
					const line = lines[i];
					if (!line?.trim()) continue;
					try {
						const rec = JSON.parse(line) as {
							type?: string;
							id?: string;
							message?: { role?: string; timestamp?: number | string; toolCallId?: string };
						};
						if (rec.type === "message") {
							// Match the jsonl id (SDK hex) OR the view key
							// ("role:timestamp") — the GUI sends the latter.
							const key =
								rec.message &&
								(rec.message.role === "toolResult"
									? `toolResult:${rec.message.toolCallId}`
									: `${rec.message.role}:${rec.message.timestamp}`);
							if (rec.id === p.messageId || key === p.messageId) {
								found = true;
								if (p.includeTarget === true) keep = i;
								break;
							}
						}
					} catch {
						// malformed line — treat as content to keep
					}
					keep = i;
				}
				if (!found) throw new Error(`Unknown message: ${p.messageId}`);
				const newId = randomUUID();
				const timestamp = new Date().toISOString();
				const newHeader = {
					...header,
					id: newId,
					timestamp,
					// The SDK's fork() records the parent under parentSession.
					parentSession: typeof header.id === "string" ? header.id : p.sessionId,
				};
				const dir = path.dirname(file);
				const newFile = path.join(dir, `${timestamp.replace(/[:.]/g, "-")}_${newId}.jsonl`);
				const body = lines
					.slice(1, keep + 1)
					.filter(l => l?.trim())
					.join("\n");
				await fs.promises.writeFile(newFile, `${JSON.stringify(newHeader)}\n${body}${body ? "\n" : ""}`);
				// Bust the SDK-session scan cache so the tree lists the fork
				// on the next refresh (listAllSessions is TTL-cached).
				this.#host.invalidateHistoryCache();
				return { sessionId: newId, parentId: typeof header.id === "string" ? header.id : p.sessionId };
			}
			case "session.close": {
				const p = (params ?? {}) as { sessionId: string };
				this.#host.close(p.sessionId);
				return { ok: true };
			}
			case "collab.start": {
				const p = (params ?? {}) as { sessionId?: string; mode?: "session" | "workspace" };
				const mode = p.mode === "workspace" ? "workspace" : "session";
				if (mode === "session" && !p.sessionId) {
					throw new Error("open or create a session first to share it");
				}
				// History sessions (idle-closed / pre-restart) reactivate on
				// demand so sharing works from any session the GUI has open.
				// Workspace mode needs no initial session: the directory is
				// served from the journal and focus binds lazily on the first
				// guest select. An explicitly passed sessionId still activates
				// so its card lists as live right away.
				let live: LiveSession | null = null;
				if (mode === "session" || p.sessionId) {
					live =
						this.#host.get(p.sessionId!) ??
						(await this.#host.activate(p.sessionId!).catch((err: unknown) => {
							// Empty sessions (never sent) have no SDK transcript to
							// reactivate — surface that instead of a raw Unknown session.
							if (this.#host.hasJournal(p.sessionId!)) {
								throw new Error("This session has no messages to share yet — send something first");
							}
							throw err;
						}));
				}
				if (this.#collab) {
					return {
						link: this.#collab.host.link,
						webLink: this.#collab.host.webLink,
						viewLink: this.#collab.host.viewLink,
					};
				}
				// The CollabHost expects the TUI interactive context; daemon-side
				// we hand it a minimal stub covering exactly the members it reads.
				// `focus` is a live-session pointer the workspace provider re-points
				// on session switches, so the host's taps follow the new session.
				let focus = live;
				type CollabSessionLike = {
					sessionId: string;
					isStreaming: boolean;
					isAborting: boolean;
					queuedMessageCount: number;
					sessionName: string | undefined;
					model: unknown;
					thinkingLevel: unknown;
					subscribe(cb: (e: unknown) => void): () => void;
					emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
					abort(options: { reason: string }): Promise<unknown>;
					promptCustomMessage(message: unknown, options: unknown): Promise<unknown>;
				};
				// Before any guest focuses a session (workspace mode with no
				// initial sessionId) the host still emits join notices on
				// ctx.session — hand it a no-op session until focus binds.
				const noopCollabSession: CollabSessionLike = {
					sessionId: "workspace",
					isStreaming: false,
					isAborting: false,
					queuedMessageCount: 0,
					sessionName: undefined,
					model: undefined,
					thinkingLevel: undefined,
					subscribe: () => () => {},
					emitNotice: () => {},
					abort: async () => {},
					promptCustomMessage: async () => {},
				};
				const focusSession = (): CollabSessionLike =>
					(focus?.agentSession as unknown as CollabSessionLike | undefined) ?? noopCollabSession;
				const stubCtx = {
					collabHost: undefined,
					get session() {
						return focusSession();
					},
					get sessionManager() {
						// The real SessionManager: snapshotForReplication,
						// onEntryAppended, getCwd all live on it.
						const sm = focus?.agentSession?.sessionManager;
						if (!sm) {
							// Unfocused workspace mode: only emitNotice/status
							// taps run until a session is selected.
							return {
								getSessionId: () => "workspace",
								getCwd: () => "",
								snapshotForReplication: () => ({ entries: [], header: {} }),
								onEntryAppended: undefined,
							};
						}
						return sm as unknown as {
							getSessionId(): string;
							getCwd(): string;
							snapshotForReplication(): unknown;
							onEntryAppended: unknown;
						};
					},
					statusLine: {
						getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
						setCollabStatus: () => {},
						invalidate: () => {},
					},
					settings: { get: () => undefined },
					ui: { requestRender: () => {} },
					showStatus: () => {},
					updatePendingMessagesDisplay: () => {},
					eventBus: undefined,
					workspace: {
						listWorkspaceSessions: () => this.#host.listWorkspaceSessions(),
						subscribeWorkspace: (cb: () => void) => this.#host.subscribeWorkspaceChanges(cb),
						switchWorkspaceSession: async (sessionId: string) => {
							const next = this.#host.get(sessionId) ?? (await this.#host.activate(sessionId).catch(() => null));
							if (!next) {
								throw new Error(
									this.#host.hasJournal(sessionId)
										? "This session has no messages to stream yet — send something first"
										: `Cannot stream session ${sessionId}`,
								);
							}
							focus = next;
							return true;
						},
					},
				};
				const transport = new LocalShareManager({ port: undefined, onStatus: () => {} });
				const collabHost = new CollabHost(stubCtx as never, mode);
				const urls = await transport.startLan();
				await collabHost.start(urls.joinUrl, urls.webUrl, urls.webJoinUrl);
				this.#collab = { host: collabHost, transport };
				return {
					link: collabHost.link,
					webLink: collabHost.webLink,
					viewLink: collabHost.viewLink,
				};
			}
			case "collab.stop": {
				if (!this.#collab) return { ok: true };
				await this.#collab.host.stop("stopped from gui").catch(() => {});
				await this.#collab.transport.stop().catch(() => {});
				this.#collab = null;
				return { ok: true };
			}
			case "collab.status": {
				if (!this.#collab) return { hosting: false };
				return {
					hosting: true,
					link: this.#collab.host.link,
					webLink: this.#collab.host.webLink,
					viewLink: this.#collab.host.viewLink,
				};
			}
			case "session.delete": {
				// Permanently remove a session (journal + materialized tables).
				// Refuses live sessions — close them first. Mirrors the TUI
				// delete; workspace files are never touched.
				const p = (params ?? {}) as { sessionId: string };
				if (typeof p.sessionId !== "string" || !p.sessionId) {
					throw new Error("sessionId required");
				}
				await this.#host.deleteSession(p.sessionId);
				this.#host.clearRevertBackups(p.sessionId);
				return { ok: true };
			}
			case "session.cancel": {
				const p = (params ?? {}) as { stream: string };
				this.#host.unsubscribeAll(p.stream);
				return { ok: true };
			}
			case "models.list": {
				// Available models for a live session (getAvailableModels); a
				// history session has no live AgentSession, so fall back to the
				// registry catalog (models.listAvailable parity) — the GUI model
				// selector must not go empty when opening old sessions.
				const p = (params ?? {}) as { sessionId: string };
				const live = this.#host.get(p.sessionId);
				if (live) {
					return live.agentSession.getAvailableModels().map(modelDetailRow);
				}
				const registry = await this.#host.ensureRegistry();
				if (!registry) return [];
				return registry.getAvailable().map(modelDetailRow).slice(0, 200);
			}
			case "session.setModel": {
				const p = (params ?? {}) as { sessionId: string; model: { id: string; name?: string; provider?: string } };
				if (!p.model?.id) throw new Error("model.id required");
				const live = this.#host.get(p.sessionId);
				if (live) {
					// setModelTemporary resolves the model by id from the registry.
					const models = live.agentSession.getAvailableModels();
					const model = models.find(m => m.id === p.model.id);
					if (!model) throw new Error(`Unknown model: ${p.model.id}`);
					await live.agentSession.setModelTemporary(model);
					return { ok: true };
				}
				// History session: persist the choice on the snapshot header — it
				// applies when the session is next continued (resume picks it up).
				const registry = await this.#host.ensureRegistry();
				const model = registry?.getAvailable().find(m => m.id === p.model.id);
				if (!model) throw new Error(`Unknown model: ${p.model.id}`);
				if (!this.#host.persistHeaderPatch(p.sessionId, { model: `${model.provider}/${model.id}` })) {
					throw new Error(`Unknown session: ${p.sessionId}`);
				}
				return { ok: true, persisted: true };
			}
			case "session.setThinkingLevel": {
				// Switch the session's thinking effort (minimal…max; undefined =
				// off). Mirrors the TUI /model thinking binding.
				const p = (params ?? {}) as { sessionId: string; thinkingLevel?: string | null };
				const level = p.thinkingLevel ?? undefined;
				if (level !== undefined && !["minimal", "low", "medium", "high", "xhigh", "max", "auto"].includes(level)) {
					throw new Error(`Unknown thinking level: ${level}`);
				}
				const live = this.#host.get(p.sessionId);
				if (live) {
					// "auto" rides through to ModelControls, which maps it to the
					// AUTO_THINKING sentinel (per-model default effort).
					(live.agentSession.setThinkingLevel as (l: string | undefined) => void)(level);
					return { ok: true };
				}
				// History session: persist alongside the model choice.
				if (!this.#host.persistHeaderPatch(p.sessionId, { thinkingLevel: level })) {
					throw new Error(`Unknown session: ${p.sessionId}`);
				}
				return { ok: true, persisted: true };
			}
			case "stt.transcribe": {
				// TUI-parity speech-to-text: same asr-client + local worker
				// (sherpa-ONNX) the TUI uses — not Google's web service.
				const p = (params ?? {}) as { audio: number[]; modelKey?: string };
				if (!Array.isArray(p.audio) || p.audio.length === 0) throw new Error("audio required (16kHz mono floats)");
				const { sttClient } = await import("../stt/asr-client");
				const text = await sttClient.transcribe(
					(p.modelKey as "fast" | "balanced" | "turbo" | "parakeet") ?? "balanced",
					Float32Array.from(p.audio),
				);
				return { text };
			}
			case "tts.synthesize": {
				// TUI-parity speech synthesis: Kokoro-82M local model via the
				// same tts-client worker the TUI uses.
				const p = (params ?? {}) as { text: string; modelKey?: string };
				if (!p.text?.trim()) throw new Error("text required");
				const { ttsClient } = await import("../tts/tts-client");
				const { DEFAULT_TTS_LOCAL_MODEL_KEY } = await import("../tts/models");
				const audio = await ttsClient.synthesize((p.modelKey as never) ?? DEFAULT_TTS_LOCAL_MODEL_KEY, p.text);
				if (!audio) return { audio: null, sampleRate: 0 };
				return { audio: Array.from(audio.pcm), sampleRate: audio.sampleRate };
			}
			case "terminal.open": {
				// Interactive terminal backend: a node pty-bridge child hosts
				// node-pty (posix_spawnp is not Bun-hostable); output streams
				// back to this connection as terminal-output envelopes.
				const p = (params ?? {}) as { cwd?: string; cols?: number; rows?: number };
				const id = await this.#openTerminal(p.cwd ?? "", p.cols ?? 100, p.rows ?? 30, conn);
				return { id };
			}
			case "terminal.input": {
				const p = (params ?? {}) as { id: string; data?: string };
				const bridge = this.#terminals.get(p.id);
				if (!bridge) throw new Error(`Unknown terminal: ${p.id}`);
				await bridge.write({ method: "input", id: p.id, params: { data: p.data ?? "" } });
				return { ok: true };
			}
			case "terminal.resize": {
				const p = (params ?? {}) as { id: string; cols?: number; rows?: number };
				const bridge = this.#terminals.get(p.id);
				if (!bridge) throw new Error(`Unknown terminal: ${p.id}`);
				await bridge.write({ method: "resize", id: p.id, params: { cols: p.cols ?? 100, rows: p.rows ?? 30 } });
				return { ok: true };
			}
			case "terminal.close": {
				const p = (params ?? {}) as { id: string };
				const bridge = this.#terminals.get(p.id);
				if (bridge) {
					await bridge.write({ method: "close", id: p.id, params: {} });
					bridge.dispose();
					this.#terminals.delete(p.id);
				}
				return { ok: true };
			}
			case "agents.list": {
				// Agent Control Center data (TUI /agents parity): the live
				// AgentRegistry roster, trimmed to display-safe fields.
				const { AgentRegistry } = await import("../registry/agent-registry");
				const refs = AgentRegistry.global().list();
				return {
					agents: refs.map(ref => ({
						id: ref.id,
						displayName: ref.displayName,
						kind: ref.kind,
						parentId: ref.parentId ?? null,
						status: ref.status,
						activity: ref.activity ?? null,
					})),
				};
			}
			case "agents.kill": {
				// Desktop parity with the TUI Agent Hub's x key / collab
				// agent-cmd kill: abort the live session (if any) and release
				// the registry ref as a tombstone so it reads "aborted".
				const { AgentRegistry } = await import("../registry/agent-registry");
				const { AgentLifecycleManager } = await import("../registry/agent-lifecycle");
				const id =
					typeof (params as { agentId?: unknown })?.agentId === "string"
						? (params as { agentId: string }).agentId
						: "";
				if (!id) throw new Error("agents.kill: missing agentId");
				const ref = AgentRegistry.global().get(id);
				if (!ref) return { ok: false, error: `agent ${id} not found` };
				if (ref.status === "running" && ref.session) {
					await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
				}
				await AgentLifecycleManager.global().release(id, ref, { tombstone: true });
				return { ok: true };
			}
			case "agents.revive": {
				// Desktop parity with the TUI Agent Hub's r key: bring a
				// parked subagent back to a live session (idempotent when
				// already running).
				const { AgentLifecycleManager } = await import("../registry/agent-lifecycle");
				const id =
					typeof (params as { agentId?: unknown })?.agentId === "string"
						? (params as { agentId: string }).agentId
						: "";
				if (!id) throw new Error("agents.revive: missing agentId");
				const session = await AgentLifecycleManager.global().ensureLive(id);
				return { ok: true, sessionId: session.sessionId };
			}
			case "agents.chat": {
				// Desktop parity with the collab host's agent-cmd chat: revive
				// if parked, steer if mid-turn (same semantics as the hub's
				// submitChatMessage).
				const { AgentLifecycleManager } = await import("../registry/agent-lifecycle");
				const p = (params ?? {}) as { agentId?: unknown; text?: unknown };
				const id = typeof p.agentId === "string" ? p.agentId : "";
				const text = typeof p.text === "string" ? p.text.trim() : "";
				if (!id) throw new Error("agents.chat: missing agentId");
				if (!text) throw new Error("agents.chat: empty message");
				const session = await AgentLifecycleManager.global().ensureLive(id);
				await session.prompt(text, { streamingBehavior: "steer" });
				return { ok: true, sessionId: session.sessionId };
			}
			case "commands.list": {
				// Slash-command catalog for the GUI composer's / completion
				// (same source of truth as the TUI's builtin registry, plus the
				// TUI's skill commands when skills.enableSkillCommands is on —
				// default true; /skill:<name> is a real agent-side invocation).
				const { BUILTIN_SLASH_COMMAND_DEFS } = await import("../slash-commands/builtin-registry");
				const { getSkillSlashCommandName } = await import("../extensibility/skills");
				const list: {
					name: string;
					description?: string;
					subcommands?: { name: string; description?: string }[];
					kind: "command" | "skill";
					category: string;
				}[] = BUILTIN_SLASH_COMMAND_DEFS.map(c => ({
					name: c.name,
					description: c.description,
					subcommands: c.subcommands?.map((sc: { name: string; description?: string }) => ({
						name: sc.name,
						description: sc.description,
					})),
					kind: "command",
					category: slashCommandCategory(c.name),
				}));
				for (const skill of await this.#getSkills()) {
					list.push({
						name: getSkillSlashCommandName({ name: skill.name }),
						description: skill.description,
						kind: "skill",
						// Second badge = discovery scope (openchamber's PROJECT tag).
						category: skill.source.split(":")[1] === "project" ? "project" : "user",
					});
				}
				return list;
			}
			case "session.rename": {
				// TUI /rename parity: user-set session title (journal label).
				const p = (params ?? {}) as { sessionId: string; title: string };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				if (!p.title?.trim()) throw new Error("title required");
				await live.agentSession.sessionManager.setSessionName(p.title.trim(), "user");
				return { ok: true };
			}
			case "session.slashCommand": {
				// TUI slash-command parity: execute a "/..." invocation
				// headlessly via the ACP dispatcher (same builtin registry
				// and handlers the TUI uses; only `handle`-backed commands
				// run — TUI-only entries like /login are reported).
				const p = (params ?? {}) as { sessionId: string; text: string };
				if (typeof p.text !== "string" || !p.text.startsWith("/")) throw new Error("slash command required");
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				const session = live.agentSession;
				const outputs: string[] = [];
				// Skill command first (ACP parity): /skill:<name> is an
				// agent-side invocation, not a builtin.
				if (session.skillsSettings?.enableSkillCommands) {
					const parsed = parseSkillInvocation(p.text);
					if (parsed) {
						const skill = session.skills.find(candidate => candidate.name === parsed.name);
						if (!skill) {
							return { consumed: false, reason: "skill-not-found" };
						}
						const built = await buildSkillPromptMessage(skill, parsed.args, "user");
						await session.promptCustomMessage(
							{
								customType: SKILL_PROMPT_MESSAGE_TYPE,
								content: built.message,
								display: true,
								details: built.details,
								attribution: "user",
							},
							{ streamingBehavior: "steer" },
						);
						return { consumed: true, outputs };
					}
				}
				const builtinResult = await executeAcpBuiltinSlashCommand(p.text, {
					session,
					sessionManager: session.sessionManager,
					settings: session.settings,
					cwd: session.sessionManager.getCwd(),
					output: (output: string) => {
						outputs.push(output);
					},
					refreshCommands: () => {},
					reloadPlugins: async () => {
						// Mirrors the interactive /reload-plugins and /move
						// flows (ACP parity): invalidate plugin roots,
						// refresh discovery/capabilities/skills and the
						// session's file slash commands.
						const cwd = session.sessionManager.getCwd();
						const projectPath = await resolveActiveProjectRegistryPath(cwd);
						clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
						await refreshAgentDiscovery(cwd);
						resetCapabilities();
						await session.refreshSkills();
						const fileCommands = await loadSlashCommands({ cwd });
						session.setSlashCommands(fileCommands);
					},
					notifyTitleChanged: async () => {},
					notifyConfigChanged: async () => {},
				});
				if (builtinResult === false) {
					// Distinguish "known but terminal-only" (e.g. /login,
					// /quit) from "no such command" so the GUI can word the
					// message correctly.
					const parsed = parseSlashCommand(p.text);
					const cmd = parsed ? lookupBuiltinSlashCommand(parsed.name) : undefined;
					return { consumed: false, reason: cmd && !cmd.handle ? "tui-only" : "unknown" };
				}
				return {
					consumed: true,
					...(typeof builtinResult === "object" && "prompt" in builtinResult
						? { prompt: builtinResult.prompt }
						: {}),
					outputs,
				};
			}
			case "session.bashCommand": {
				// TUI !/!! parity: run a shell command headlessly. The result
				// is appended to the session transcript as a bashExecution
				// message (visible in the TUI; the GUI surfaces the summary
				// via the RPC response) and injected into the model context
				// unless the "!!" prefix excludes it — same semantics as the
				// TUI input controller and openchamber's shell mode.
				const p = (params ?? {}) as {
					sessionId: string;
					command: string;
					excludeFromContext?: boolean;
				};
				if (typeof p.command !== "string" || !p.command.startsWith("!")) {
					throw new Error("bash command required");
				}
				const excludeFromContext =
					p.excludeFromContext === true || p.command.startsWith("!!");
				const command = (excludeFromContext ? p.command.slice(2) : p.command.slice(1)).trim();
				if (!command) throw new Error("command required");
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				const session = live.agentSession;
				if (session.isBashRunning) {
					throw new Error("A bash command is already running");
				}
				const result = await session.executeBash(command, undefined, {
					excludeFromContext,
					useUserShell: true,
				});
				// The BashRunner appended the bashExecution message to the
				// agent state (model context + SDK transcript) but emits no
				// wire events — the TUI renders it locally, while the GUI
				// transcript folds message_start/end events into its view.
				// Broadcast them so the shell card shows up live.
				const bashMsg = {
					role: "bashExecution" as const,
					command,
					output: result.output,
					exitCode: result.exitCode,
					cancelled: result.cancelled,
					truncated: result.truncated,
					timestamp: Date.now(),
					excludeFromContext,
				};
				live.publishWireEvent({ type: "message_start", message: bashMsg });
				live.publishWireEvent({ type: "message_end", message: bashMsg });
				// The GUI shows a one-line notice; cap the payload at a
				// tail slice so huge outputs don't bloat the RPC frame.
				const MAX_OUTPUT = 4000;
				const long = result.output.length > MAX_OUTPUT;
				return {
					command,
					excludeFromContext,
					exitCode: result.exitCode ?? null,
					cancelled: result.cancelled,
					truncated: result.truncated,
					totalLines: result.totalLines,
					outputTruncated: long,
					output: long ? `…${result.output.slice(-MAX_OUTPUT)}` : result.output,
				};
			}
			case "session.compact": {
				// TUI /compact parity: manual context compaction. The engine
				// gates preconditions itself (no summarizer model, nothing to
				// compact, already compacting) and throws on failure; the GUI
				// button surfaces the error via the standard RPC error path.
				const p = (params ?? {}) as { sessionId: string; instructions?: string; mode?: string };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				const result = await live.agentSession.compact(
					p.instructions?.trim() ? p.instructions.trim() : undefined,
					p.mode ? { mode: p.mode as CompactMode } : undefined,
				);
				return {
					summary: result.summary,
					shortSummary: result.shortSummary ?? null,
					tokensBefore: result.tokensBefore,
				};
			}
			case "session.retry": {
				// TUI /retry parity: retry the last failed agent turn.
				const p = (params ?? {}) as { sessionId: string };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				const didRetry = await live.agentSession.retry();
				return { ok: didRetry };
			}
			case "session.todo": {
				// TUI /todo parity: mutate the session todo list. Tasks are
				// matched by exact content (the GUI panel clicks rows, no
				// fuzzy text matching needed). Persists exactly like the TUI
				// command — setTodoPhases + a user_todo_edit custom entry so
				// the transcript round-trips and survives compaction.
				const p = (params ?? {}) as {
					sessionId: string;
					op: "append" | "start" | "done" | "drop" | "rm";
					content?: string;
					phase?: string;
				};
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				const { getLatestTodoPhasesFromEntries, USER_TODO_EDIT_CUSTOM_TYPE } = await import("../tools/todo");
				const manager = live.agentSession.sessionManager;
				const fromEntries = getLatestTodoPhasesFromEntries(manager.getBranch());
				const phases: TodoPhase[] = fromEntries.length > 0 ? fromEntries : live.agentSession.getTodoPhases();
				const content = p.content?.trim();
				switch (p.op) {
					case "append": {
						if (!content) throw new Error("content required");
						const target = p.phase?.trim();
						let phase = target !== undefined && target !== "" ? phases.find(x => x.name === target) : phases[0];
						if (!phase) {
							phase = { name: target || "Tasks", tasks: [] };
							phases.push(phase);
						}
						phase.tasks.push({ content, status: "pending" });
						break;
					}
					case "start":
					case "done":
					case "drop":
					case "rm": {
						if (!content) throw new Error("content required");
						const status: "in_progress" | "completed" | "abandoned" =
							p.op === "start" ? "in_progress" : p.op === "done" ? "completed" : "abandoned";
						let found = false;
						for (const phase of phases) {
							const task = phase.tasks.find(t => t.content === content);
							if (!task) continue;
							if (p.op === "rm") phase.tasks = phase.tasks.filter(t => t.content !== content);
							else task.status = status;
							found = true;
							break;
						}
						if (!found) throw new Error(`No such task: ${content}`);
						break;
					}
					default:
						throw new Error(`Unknown todo op: ${p.op}`);
				}
				const cleaned = phases.filter(phase => phase.tasks.length > 0);
				live.agentSession.setTodoPhases(cleaned);
				manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: cleaned });
				return {
					todo: cleaned.map(phase => ({
						name: phase.name,
						done: phase.tasks.filter(t => t.status === "completed").length,
						total: phase.tasks.length,
						tasks: phase.tasks.map(t => ({
							content: t.content,
							status: t.status,
							...(t.blocker ? { blocker: t.blocker } : {}),
						})),
					})),
				};
			}
			case "session.thinkingInfo": {
				// Per-model thinking ceiling (TUI parity: some models cap the
				// effort ladder). Powers the GUI selector's disabled levels.
				const p = (params ?? {}) as { sessionId: string };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				// AgentSession exposes the live controls on its model bus. The
				// current model rides along so the settings card can label the
				// live session's model without a separate snapshot round-trip.
				const model = live.agentSession.model;
				return {
					ceiling: live.agentSession.thinkingLevelCeiling,
					level: live.agentSession.thinkingLevel,
					auto: live.agentSession.isAutoThinking,
					// The current model's exact effort ladder (TUI parity: the
					// selector offers off/auto + getSupportedEfforts(model), not
					// a fixed seven-rung ladder).
					efforts: model ? getSupportedEfforts(model as never).map(e => String(e)) : [],
					model: model ? { id: model.id, name: model.name, provider: model.provider } : null,
				};
			}
			case "session.contextUsage": {
				// Live context-window usage (TUI status-line parity): the
				// stats tracker's estimate feeds the composer's usage ring.
				// The snapcompact field carries the TUI /context savings
				// estimate when the experimental settings are enabled.
				const p = (params ?? {}) as { sessionId: string };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				const stats = live.agentSession.getSessionStats();
				const usage = stats.contextUsage ?? null;
				if (!usage) return usage;
				const snapcompact = estimateSnapcompactSavings(live.agentSession);
				return snapcompact ? { ...usage, snapcompact } : usage;
			}
			case "session.modes": {
				// Goal / plan mode + todo progress (TUI /goal /plan parity):
				// live AgentSession state exposed for the GUI badges and the
				// todo progress bar.
				const p = (params ?? {}) as { sessionId: string };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				return modesOf(live.agentSession);
			}
			case "session.setGoal": {
				// Toggle goal mode; with an objective, set/replace the goal.
				const p = (params ?? {}) as { sessionId: string; objective?: string | null };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				const current = live.agentSession.getGoalModeState?.();
				const objective = p.objective?.trim();
				if (objective) {
					const now = Date.now();
					live.agentSession.setGoalModeState?.({
						enabled: true,
						mode: "active",
						goal: {
							id: `goal-${now}`,
							objective,
							status: "active",
							tokensUsed: 0,
							timeUsedSeconds: 0,
							createdAt: now,
							updatedAt: now,
						},
					});
				} else {
					live.agentSession.setGoalModeState?.(current?.enabled ? undefined : (current ?? undefined));
				}
				return modesOf(live.agentSession);
			}
			case "session.setPlan": {
				// Toggle plan mode (read-only proposal flow, TUI /plan parity).
				const p = (params ?? {}) as { sessionId: string; enabled?: boolean };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				const on = p.enabled ?? !(live.agentSession.getPlanModeState?.()?.enabled === true);
				live.agentSession.setPlanModeState?.(on ? { enabled: true, planFilePath: "" } : undefined);
				return modesOf(live.agentSession);
			}
			case "session.roles": {
				// Per-role model presets (TUI /model parity): the modelRoles
				// settings record + the cycle order that decides which roles cycle.
				const p = (params ?? {}) as { sessionId: string };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				const settings = live.agentSession.settings as unknown as {
					get(path: string): Record<string, string> | string[] | undefined;
				};
				const roles = (settings.get("modelRoles") as Record<string, string> | undefined) ?? {};
				const cycleOrder = (settings.get("cycleOrder") as string[] | undefined) ?? [];
				return { roles, cycleOrder };
			}
			case "session.setRoleModel": {
				// Assign a model selector to a role (persisted modelRoles record).
				// Empty modelId is allowed: adding a role without a model yet.
				const p = (params ?? {}) as { sessionId: string; role: string; modelId?: string };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				if (!p.role?.trim()) throw new Error("role required");
				const settings = live.agentSession.settings as unknown as {
					get(path: string): Record<string, string> | undefined;
					set(path: string, value: unknown): void;
				};
				const roles = { ...((settings.get("modelRoles") as Record<string, string> | undefined) ?? {}) };
				if (p.modelId?.trim()) roles[p.role.trim()] = p.modelId.trim();
				else if (!(p.role.trim() in roles)) roles[p.role.trim()] = "";
				// Empty modelId on an existing role leaves it untouched (removal is
				// explicit via session.removeRole).
				settings.set("modelRoles", roles);
				return { ok: true, roles };
			}
			case "session.removeRole": {
				const p = (params ?? {}) as { sessionId: string; role: string };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				const settings = live.agentSession.settings as unknown as {
					get(path: string): Record<string, string> | undefined;
					set(path: string, value: unknown): void;
				};
				const roles = { ...((settings.get("modelRoles") as Record<string, string> | undefined) ?? {}) };
				delete roles[p.role];
				settings.set("modelRoles", roles);
				return { ok: true, roles };
			}
			case "providers.list": {
				// Provider catalog + credential state (login/logout parity
				// with the TUI `/login` provider selector). Two lists:
				//   oauth — providers with an interactive login flow
				//           (subscription accounts: Codex, Antigravity, …);
				//   api   — providers with bundled catalog models, configured
				//           via API-key import (the /setup path). The catalog
				//           is the static models.json, so the list is stable
				//           regardless of which providers are authenticated.
				// Works without a live session — the shared registry backs
				// the auth storage.
				const registry = await this.#host.ensureRegistry();
				if (!registry) throw new Error("No model registry yet — create a session first");
				const storage = registry.authStorage;
				const oauth = getOAuthProviders().map(info => ({
					id: info.id,
					name: info.name,
					available: info.available,
					storeCredentialsAs: info.storeCredentialsAs,
					loggedIn: storage.has(info.storeCredentialsAs ?? info.id),
				}));
				// Registry order (curated display order), only providers that
				// actually ship catalog models.
				const registryOrder: Record<string, number> = {};
				for (const [index, def] of PROVIDER_REGISTRY.entries()) registryOrder[def.id] = index;
				const api = getBundledProviders()
					.filter(id => registryOrder[id] !== undefined)
					.map(id => {
						const models = getBundledModels(id as GeneratedProvider);
						return {
							id,
							name: PROVIDER_REGISTRY[registryOrder[id]!]!.name,
							modelCount: models.length,
							models: models.slice(0, 5).map(model => model.id),
							configured: storage.has(id),
						};
					})
					.sort((a, b) => registryOrder[a.id]! - registryOrder[b.id]!);
				return { oauth, api };
			}
			case "providers.credentials": {
				// Per-credential list for one provider (multi-account logout
				// parity with the TUI /logout account rows). Storage may key
				// credentials under a different id (storeCredentialsAs).
				const p = (params ?? {}) as { providerId: string };
				const registry = await this.#host.ensureRegistry();
				if (!registry) throw new Error("No model registry yet — create a session first");
				if (!p.providerId) throw new Error("providerId required");
				const provider = getOAuthProviders().find(info => info.id === p.providerId);
				const storageKey = provider?.storeCredentialsAs ?? p.providerId;
				return registry.authStorage.listStoredCredentials(storageKey).map(row => ({
					id: row.id,
					accountLabel: storedCredentialLabel(row),
					note: row.credential.note ?? null,
				}));
			}
			case "providers.setCredentialNote": {
				// User note on one credential (multi-account labeling — e.g.
				// "公司主 key" vs "测试 key").
				const p = (params ?? {}) as { providerId: string; credentialId: number; note: string };
				const registry = await this.#host.ensureRegistry();
				if (!registry) throw new Error("No model registry yet — create a session first");
				if (!p.providerId) throw new Error("providerId required");
				const provider = getOAuthProviders().find(info => info.id === p.providerId);
				const storageKey = provider?.storeCredentialsAs ?? p.providerId;
				const ok = await registry.authStorage.setCredentialNote(storageKey, p.credentialId, p.note ?? "");
				if (!ok) throw new Error(`Unknown credential: ${p.credentialId}`);
				return { ok: true };
			}
			case "providers.login": {
				// Run the provider's real OAuth flow (auth-storage owns the
				// login + credential persistence, same as the TUI). The auth URL
				// is pushed to the client as a `provider-auth` event and opened in
				// the default browser; onPrompt providers wait for a
				// `providers.loginInput` RPC with the pasted code/URL.
				const p = (params ?? {}) as { providerId: string };
				const registry = await this.#host.ensureRegistry();
				if (!registry) throw new Error("No model registry yet — create a session first");
				if (!p.providerId) throw new Error("providerId required");
				const storage = registry.authStorage;
				const abort = new AbortController();
				const pending = { resolve: () => {}, reject: () => {}, abort };
				this.#promptResolvers.set(p.providerId, pending);
				try {
					const identity = await storage.login(p.providerId, {
						signal: abort.signal,
						onAuth: info => {
							try {
								conn.send({
									kind: "provider-auth",
									seq: ++this.#eventSeq,
									payload: {
										providerId: p.providerId,
										url: info.url,
										launchUrl: info.launchUrl,
										instructions: info.instructions,
									},
								});
							} catch {
								// socket died
							}
							// Best-effort browser launch (same as the TUI login dialog).
							openPath(info.launchUrl ?? info.url);
						},
						onPrompt: async prompt =>
							new Promise<string>((resolve, reject) => {
								this.#promptResolvers.set(p.providerId, {
									resolve: value => {
										this.#promptResolvers.delete(p.providerId);
										resolve(value);
									},
									reject: error => {
										this.#promptResolvers.delete(p.providerId);
										reject(error);
									},
									abort,
								});
								conn.send({
									kind: "provider-prompt",
									seq: ++this.#eventSeq,
									payload: {
										providerId: p.providerId,
										message: prompt.message,
										placeholder: prompt.placeholder,
									},
								});
							}),
						onProgress: message => {
							try {
								conn.send({
									kind: "provider-progress",
									seq: ++this.#eventSeq,
									payload: { providerId: p.providerId, message },
								});
							} catch {
								// socket died
							}
						},
					});
					await registry.refreshProvider(p.providerId, "online");
					return { ok: true, identity: identity ?? null };
				} finally {
					this.#promptResolvers.delete(p.providerId);
				}
			}
			case "providers.loginInput": {
				const p = (params ?? {}) as { providerId: string; value: string };
				const pending = this.#promptResolvers.get(p.providerId);
				if (!pending) throw new Error(`No pending login for provider: ${p.providerId}`);
				pending.resolve(p.value ?? "");
				return { ok: true };
			}
			case "providers.loginCancel": {
				const p = (params ?? {}) as { providerId: string };
				const pending = this.#promptResolvers.get(p.providerId);
				if (pending) pending.abort.abort();
				return { ok: true };
			}
			case "providers.importApiKey": {
				// /setup parity: import a stored API-key credential for a
				// provider without running OAuth (e.g. OpenRouter, GLM keys).
				const p = (params ?? {}) as { providerId: string; apiKey: string };
				const registry = await this.#host.ensureRegistry();
				if (!registry) throw new Error("No model registry yet — create a session first");
				if (!p.providerId) throw new Error("providerId required");
				if (!p.apiKey?.trim()) throw new Error("api key required");
				const storage = registry.authStorage;
				await storage.importApiKey(p.providerId, p.apiKey.trim());
				await registry.refreshProvider(p.providerId, "online");
				return { ok: true };
			}
			case "providers.testConnection": {
				// One-shot connectivity check against a user-supplied endpoint
				// (onboarding "test connection" button): validates the key and
				// the base URL with a minimal chat request, persisting nothing.
				// OpenAI-compatible and Anthropic-compatible APIs are covered;
				// other api kinds fall back to the OpenAI shape.
				const p = (params ?? {}) as {
					baseUrl: string;
					apiKey?: string;
					api?: string;
					modelId: string;
				};
				if (!p.baseUrl?.trim()) throw new Error("baseUrl required");
				if (!p.modelId?.trim()) throw new Error("modelId required");
				if (!p.apiKey?.trim()) throw new Error("api key required to test the connection");
				const api = p.api ?? "openai-completions";
				const baseUrl = p.baseUrl.trim();
				const apiKey = p.apiKey.trim();
				const model = p.modelId.trim();
				if (api === "anthropic-messages") {
					await validateAnthropicCompatibleApiKey({
						provider: "connection-test",
						baseUrl,
						apiKey,
						model,
					});
				} else {
					await validateOpenAICompatibleApiKey({
						provider: "connection-test",
						baseUrl,
						apiKey,
						model,
					});
				}
				return { ok: true };
			}
			case "providers.logout": {
				// Remove every stored credential for the provider, or exactly
				// one when credentialId is given (multi-account logout parity
				// with the TUI /logout rows). Storage may key credentials under
				// a different id (storeCredentialsAs), then refresh so
				// credential-gated models leave the catalog.
				const p = (params ?? {}) as { providerId: string; credentialId?: number };
				const registry = await this.#host.ensureRegistry();
				if (!registry) throw new Error("No model registry yet — create a session first");
				if (!p.providerId) throw new Error("providerId required");
				const provider = getOAuthProviders().find(info => info.id === p.providerId);
				const storageKey = provider?.storeCredentialsAs ?? p.providerId;
				const storage = registry.authStorage;
				const credentials = storage.listStoredCredentials(storageKey);
				if (p.credentialId !== undefined) {
					if (!credentials.some(credential => credential.id === p.credentialId)) {
						throw new Error(`Unknown credential: ${p.credentialId}`);
					}
					await storage.removeCredential(storageKey, p.credentialId);
				} else {
					for (const credential of credentials) {
						await storage.removeCredential(storageKey, credential.id);
					}
				}
				await registry.refreshProvider(p.providerId, "online");
				return { ok: true, removed: p.credentialId !== undefined ? 1 : credentials.length };
			}
			case "models.listCustom": {
				// Read the current custom-provider block from models.yml (for the
				// settings dialog's custom provider list).
				const filePath = ModelsConfigFile.path();
				try {
					const raw = fs.readFileSync(filePath, "utf8");
					return YAML.parse(raw) as { providers?: Record<string, unknown> };
				} catch {
					return { providers: {} };
				}
			}
			case "settings.get": {
				// Global settings snapshot (session-less): the GUI reads
				// defaults/roles here instead of per-session state.
				const p = (params ?? {}) as { keys?: string[] };
				// Lazy bootstrap like models.listAvailable: the first call boots
				// a minimal session to extract the shared settings instance.
				let settings = this.#host.settings();
				if (!settings) {
					await this.#host.ensureRegistry();
					settings = this.#host.settings();
				}
				if (!settings) throw new Error("settings unavailable");
				const keys = p.keys && p.keys.length > 0 ? p.keys : ["modelRoles", "cycleOrder", "knownRoleIds"];
				const { SETTINGS_SCHEMA, hasUi, isCredential } = await import("../config/settings-schema");
				const out: Record<string, unknown> = {};
				for (const key of keys) {
					// Anything the TUI settings panel exposes (hasUi) plus the
					// model-panel keys is readable. Credentials are NEVER
					// echoed back — the GUI renders a masked placeholder and
					// only writes a non-empty replacement. The computed
					// knownRoleIds/resolvedRoleModels are served below, not
					// schema-backed (hasUi would throw on them).
					const computed = key === "knownRoleIds" || key === "resolvedRoleModels";
					const hasUiMeta = computed ? false : hasUi(key as Parameters<typeof hasUi>[0]);
					const legacy =
						key === "modelRoles" ||
						key === "cycleOrder" ||
						key === "modelTags" ||
						key === "modelProviderOrder" ||
						key === "sideChannelModel" ||
						key === "busyEnter";
					if (!legacy && !hasUiMeta) continue;
					if (key in SETTINGS_SCHEMA && isCredential(key as Parameters<typeof isCredential>[0])) {
						out[key] = undefined;
						continue;
					}
					// Only surface explicitly-configured values for keys the GUI
					// treats as user intent: an unset settings.locale would echo
					// the schema default (en-US) and flip the desktop UI off the
					// OS-detected locale; an unset defaultThinkingLevel would
					// override the composer's neutral preselect. The GUI already
					// falls back to schema defaults for display (2026-08-11).
					if (
						(key === "settings.locale" || key === "defaultThinkingLevel") &&
						!settings.isConfigured(key as Parameters<Settings["isConfigured"]>[0])
					) {
						continue;
					}
					out[key] = settings.get(key as Parameters<Settings["get"]>[0]);
				}
				if (keys.includes("knownRoleIds")) {
					// TUI /model parity: canonical role list = built-ins +
					// configured cycleOrder/modelRoles/modelTags extras.
					const builtins = [
						"default",
						"smol",
						"slow",
						"vision",
						"plan",
						"designer",
						"commit",
						"tiny",
						"task",
						"advisor",
					];
					const roles = (settings.get("modelRoles") as Record<string, string> | undefined) ?? {};
					const cycle = (settings.get("cycleOrder") as string[] | undefined) ?? [];
					const known = [...builtins];
					for (const role of [...cycle, ...Object.keys(roles)]) {
						if (!known.includes(role)) known.push(role);
					}
					out.knownRoleIds = known;
				}
				if (keys.includes("resolvedRoleModels")) {
					// TUI model-hub parity: for every known role, the model that
					// WOULD be selected (explicit assignment, or the auto-derived
					// default/priority resolution when unset). The GUI shows
					// "auto → <model>" on unassigned roles that resolve.
					const { resolveModelRoleValue } = await import("../config/model-resolver");
					const registry = await this.#host.ensureRegistry();
					const roles = (settings.get("modelRoles") as Record<string, string> | undefined) ?? {};
					const known =
						(out.knownRoleIds as string[] | undefined) ??
						(() => {
							const builtins = [
								"default",
								"smol",
								"slow",
								"vision",
								"plan",
								"designer",
								"commit",
								"tiny",
								"task",
								"advisor",
							];
							const cycle = (settings.get("cycleOrder") as string[] | undefined) ?? [];
							const k = [...builtins];
							for (const role of [...cycle, ...Object.keys(roles)]) {
								if (!k.includes(role)) k.push(role);
							}
							return k;
						})();
					const available = registry?.getAvailable() ?? [];
					const resolved: Record<string, { id: string; name: string } | null> = {};
					for (const role of known) {
						const value = roles[role];
						// TUI model-hub parity: unconfigured roles fall back to
						// their `pi/<role>` priority pattern (which carries the
						// default-role inheritance for smol/slow/designer) —
						// displayed as "auto selection: <model>".
						const r = resolveModelRoleValue(
							value ?? (isBuiltinRole(role) ? `pi/${role}` : undefined),
							available,
							{ settings: settings as never },
						);
						resolved[role] = r.model ? { id: r.model.id, name: r.model.name } : null;
					}
					out.resolvedRoleModels = resolved;
				}
				return out;
			}
			case "settings.set": {
				// Write one global setting (GUI settings panel scope).
				const p = (params ?? {}) as { key: string; value: unknown };
				let settings = this.#host.settings();
				if (!settings) {
					await this.#host.ensureRegistry();
					settings = this.#host.settings();
				}
				if (!settings) throw new Error("settings unavailable");
				const { SETTINGS_SCHEMA, hasUi, isCredential } = await import("../config/settings-schema");
				const legacy =
					["modelRoles", "cycleOrder", "modelTags", "modelProviderOrder", "sideChannelModel", "busyEnter"].includes(p.key) ||
					p.key.startsWith("lsp.") ||
					p.key === "read.toolResultPreview";
				if (!legacy && !(p.key in SETTINGS_SCHEMA && hasUi(p.key as Parameters<typeof hasUi>[0]))) {
					throw new Error(`read-only setting: ${p.key}`);
				}
				// Credentials: an empty/absent value keeps the stored one
				// (settings.get never echoes credentials back).
				if (p.key in SETTINGS_SCHEMA && isCredential(p.key as Parameters<typeof isCredential>[0])) {
					if (p.value === "" || p.value === null || p.value === undefined) {
						return { ok: true };
					}
				}
				settings.set(p.key as Parameters<Settings["set"]>[0], p.value as never);
				await settings.flush();
				return { ok: true };
			}
			case "settings.schema": {
				// UI metadata for the settings panel (TUI parity): every
				// setting with ui metadata on the requested tabs, so the GUI
				// renders from the single source of truth instead of a
				// hardcoded copy that drifts.
				const p = (params ?? {}) as { tabs?: string[] };
				const { getEnumValues, SETTINGS_SCHEMA, SETTING_TABS } = await import("../config/settings-schema");
				// Whitelist the requested tabs (B-class audit: the schema walk
				// only knows the TUI's SETTING_TABS). Unknown tab names are
				// dropped — a client cannot ask for an invented tab, and a
				// typo'd tab renders nothing instead of a partial page.
				const requested = p.tabs && p.tabs.length > 0 ? p.tabs : ["memory", "files"];
				const tabs = requested.filter(tab => (SETTING_TABS as readonly string[]).includes(tab));
				const out: Record<string, unknown[]> = {};
				for (const tab of tabs) {
					const items: unknown[] = [];
					for (const [key, def] of Object.entries(SETTINGS_SCHEMA)) {
						const ui = (def as { ui?: { tab?: string; options?: unknown } }).ui;
						if (!ui || ui.tab !== tab) continue;
						const item: Record<string, unknown> = { key, type: def.type, default: def.default, ui };
						// Enums whose options live in the schema's `values`
						// field (edit.mode: EDIT_MODES) get synthesized
						// ui.options — without them the GUI would render a
						// text input instead of a select.
						if (def.type === "enum" && !ui.options) {
							const values = getEnumValues(key as SettingPath);
							if (values && values.length > 0) {
								item.ui = { ...ui, options: values.map(v => ({ value: v, label: v })) };
							}
						}
						// `options: "runtime"` (theme.dark/theme.light) — resolve the
						// runtime list daemon-side so the GUI renders a real select
						// instead of the TUI's runtime-populated submenu. The TUI
						// theme registry is fs-backed (builtins + ~/.musepi/themes),
						// so it enumerates without a terminal.
						if ((ui as { options?: unknown }).options === "runtime") {
							const { getAvailableThemes } = await import("../modes/theme/loader");
							item.runtimeOptions = await getAvailableThemes();
						}
						items.push(item);
					}
					out[tab] = items;
				}
				return out;
			}
			case "session.queued": {
				// Pending-message queue (TUI /queue parity): the agent's live
				// steering + follow-up queues, so the GUI can render the
				// "queue N" chip and preview while the agent is working.
				const p = (params ?? {}) as { sessionId: string };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				const agent = live.agentSession as unknown as {
					queuedMessageCount: number;
					getQueuedMessages(): { steering: readonly string[]; followUp: readonly string[] };
				};
				const queued = agent.getQueuedMessages();
				return {
					count: agent.queuedMessageCount,
					steering: [...queued.steering],
					followUp: [...queued.followUp],
				};
			}
			case "session.queuedPop": {
				// Pull the newest queued user message back into the editor
				// (TUI Alt+Up dequeue parity): the GUI "取回" action.
				const p = (params ?? {}) as { sessionId: string };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				const agent = live.agentSession as unknown as {
					popLastQueuedMessage():
						| { text: string; images?: { type: string; data: string; mimeType: string }[] }
						| undefined;
				};
				const popped = agent.popLastQueuedMessage();
				return popped ? { text: popped.text, images: popped.images ?? null } : null;
			}
			case "session.queuedClear": {
				// Drop every queued user message (TUI clearQueue parity).
				const p = (params ?? {}) as { sessionId: string };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				const agent = live.agentSession as unknown as {
					clearQueue(options?: { forInterrupt?: boolean }): unknown;
				};
				agent.clearQueue();
				return { ok: true };
			}
			case "notes.get": {
				// Project notes (right-panel 项目笔记): one markdown file per
				// workspace, stored under the agent dir (never touches the
				// user's project). Returns "" when no note exists yet.
				const p = (params ?? {}) as { cwd?: string };
				const cwd = p.cwd?.trim() || this.#host.cwd();
				const slug = await hashProjectPath(cwd);
				const file = path.join(getAgentDir(), "notes", `${slug}.md`);
				try {
					return { text: await fs.promises.readFile(file, "utf8") };
				} catch {
					return { text: "" };
				}
			}
			case "notes.set": {
				const p = (params ?? {}) as { cwd?: string; text?: string };
				const cwd = p.cwd?.trim() || this.#host.cwd();
				const slug = await hashProjectPath(cwd);
				const dir = path.join(getAgentDir(), "notes");
				await fs.promises.mkdir(dir, { recursive: true });
				await fs.promises.writeFile(path.join(dir, `${slug}.md`), p.text ?? "", "utf8");
				return { ok: true };
			}
			case "plans.list": {
				// Saved plan files (right-panel 计划, openchamber parity): one
				// markdown file per plan under agentDir/plans/<cwdHash>/, never
				// touching the user's project. Title = first `# heading` or the
				// slug; createdAt = filename `<ts>-<slug>.md` or file mtime.
				const p = (params ?? {}) as { cwd?: string };
				const cwd = p.cwd?.trim() || this.#host.cwd();
				const slug = await hashProjectPath(cwd);
				const dir = path.join(getAgentDir(), "plans", slug);
				let files: string[] = [];
				try {
					files = (await fs.promises.readdir(dir)).filter(f => f.endsWith(".md"));
				} catch {
					// no plans yet
				}
				const plans = [];
				for (const f of files.sort()) {
					const id = f.slice(0, -3);
					let title = id.split("-").slice(1).join("-") || id;
					let createdAt = f.slice(0, 15);
					try {
						const head = await fs.promises.readFile(path.join(dir, f), "utf8");
						const heading = /^#\s+(.+)$/m.exec(head);
						if (heading) title = heading[1]!.trim();
					} catch {
						// keep fallback title
					}
					try {
						const st = await fs.promises.stat(path.join(dir, f));
						if (createdAt.length < 14) createdAt = st.mtime.toISOString().slice(0, 10);
					} catch {
						// keep filename date
					}
					plans.push({ id, title, createdAt });
				}
				return { plans: plans.reverse() };
			}
			case "plans.get": {
				const p = (params ?? {}) as { cwd?: string; id?: string };
				const cwd = p.cwd?.trim() || this.#host.cwd();
				const slug = await hashProjectPath(cwd);
				if (!p.id || /[^a-zA-Z0-9-]/.test(p.id)) return { error: "invalid plan id" };
				try {
					const body = await fs.promises.readFile(path.join(getAgentDir(), "plans", slug, `${p.id}.md`), "utf8");
					return { title: (/^#\s+(.+)$/m.exec(body)?.[1] ?? p.id).trim(), body };
				} catch {
					return { error: "plan not found" };
				}
			}
			case "plans.save": {
				// Save (or overwrite, when id is given) a plan file.
				const p = (params ?? {}) as { cwd?: string; id?: string; title?: string; body?: string };
				const cwd = p.cwd?.trim() || this.#host.cwd();
				const slug = await hashProjectPath(cwd);
				const dir = path.join(getAgentDir(), "plans", slug);
				await fs.promises.mkdir(dir, { recursive: true });
				const title = (p.title ?? "").trim() || "untitled plan";
				const body = `${`# ${title}\n\n${p.body ?? ""}`.trim()}\n`;
				const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
				const id =
					p.id && !/[^a-zA-Z0-9-]/.test(p.id)
						? p.id
						: `${stamp}-${
								title
									.toLowerCase()
									.replace(/[^a-z0-9]+/g, "-")
									.replace(/^-+|-+$/g, "")
									.slice(0, 48) || "plan"
							}`;
				await fs.promises.writeFile(path.join(dir, `${id}.md`), body, "utf8");
				return { id, title, createdAt: stamp };
			}
			case "plans.delete": {
				const p = (params ?? {}) as { cwd?: string; id?: string };
				const cwd = p.cwd?.trim() || this.#host.cwd();
				const slug = await hashProjectPath(cwd);
				if (!p.id || /[^a-zA-Z0-9-]/.test(p.id)) return { error: "invalid plan id" };
				try {
					await fs.promises.unlink(path.join(getAgentDir(), "plans", slug, `${p.id}.md`));
					return { ok: true };
				} catch {
					return { error: "plan not found" };
				}
			}
			case "models.listAvailable": {
				// Session-less model catalog (welcome-composer preselect): the
				// shared registry lists what's available without a live session;
				// the chosen id is applied via session.setModel once the session
				// exists.
				const registry = await this.#host.ensureRegistry();
				if (!registry) return [];
				return registry.getAvailable().map(modelDetailRow).slice(0, 200);
			}
			case "models.detail": {
				// One model's detail row (cost/context/efforts) by id, without a
				// live session — the welcome composer's thinking selector reads
				// the current model's ladder from here.
				const p = (params ?? {}) as { id: string };
				if (!p.id) throw new Error("model id required");
				const registry = await this.#host.ensureRegistry();
				if (!registry) return null;
				const model = registry.getAvailable().find(m => m.id === p.id);
				return model ? modelDetailRow(model) : null;
			}
			case "models.add": {
				// Append an OpenAI-compatible custom provider to models.yml
				// (the same config the TUI `/login` + custom-model docs target),
				// then reload the registry so the model is selectable at once.
				const p = (params ?? {}) as {
					provider: {
						name: string;
						baseUrl?: string;
						apiKey?: string;
						api?: string;
						models: { id: string; name?: string; compactionModel?: string }[];
					};
				};
				const registry = await this.#host.ensureRegistry();
				if (!registry) throw new Error("No model registry yet — create a session first");
				if (!p.provider?.name || !Array.isArray(p.provider.models) || p.provider.models.length === 0) {
					throw new Error("provider.name and provider.models[] are required");
				}
				const filePath = ModelsConfigFile.path();
				let config: { providers?: Record<string, unknown> } = {};
				try {
					const raw = fs.readFileSync(filePath, "utf8");
					config = YAML.parse(raw) as { providers?: Record<string, unknown> };
				} catch {
					// no file yet — start fresh
				}
				const providers = config.providers ?? {};
				const entry: Record<string, unknown> = {
					...(providers[p.provider.name] as Record<string, unknown> | undefined),
				};
				if (p.provider.baseUrl) entry.baseUrl = p.provider.baseUrl;
				if (p.provider.apiKey) entry.apiKey = p.provider.apiKey;
				const api = p.provider.api ?? "openai-completions";
				entry.api = api;
				const existing = Array.isArray(entry.models) ? (entry.models as { id: string }[]) : [];
				const ids = new Set(existing.map(m => m.id));
				for (const m of p.provider.models) {
					if (!ids.has(m.id)) {
						existing.push({
							id: m.id,
							...(m.name ? { name: m.name } : {}),
							...(m.compactionModel ? { compactionModel: m.compactionModel } : {}),
						});
						ids.add(m.id);
					}
				}
				entry.models = existing;
				providers[p.provider.name] = entry;
				fs.mkdirSync(path.dirname(filePath), { recursive: true });
				fs.writeFileSync(filePath, YAML.stringify({ providers }, null, 2));
				// mtime changed → registry reloads the custom models on refresh().
				await registry.refresh();
				return { ok: true };
			}
			case "models.remove": {
				// Remove a provider (or one model within it) from models.yml.
				const p = (params ?? {}) as { providerName: string; modelId?: string };
				const registry = await this.#host.ensureRegistry();
				if (!registry) throw new Error("No model registry yet — create a session first");
				if (!p.providerName) throw new Error("providerName required");
				const filePath = ModelsConfigFile.path();
				let config: { providers?: Record<string, unknown> } = {};
				try {
					const raw = fs.readFileSync(filePath, "utf8");
					config = YAML.parse(raw) as { providers?: Record<string, unknown> };
				} catch {
					return { ok: true }; // nothing to remove
				}
				const providers = config.providers ?? {};
				if (!providers[p.providerName]) return { ok: true };
				if (p.modelId) {
					const entry = providers[p.providerName] as { models?: { id: string }[] };
					if (Array.isArray(entry.models)) {
						entry.models = entry.models.filter(m => m.id !== p.modelId);
					}
				} else {
					delete providers[p.providerName];
				}
				fs.writeFileSync(filePath, YAML.stringify({ providers }, null, 2));
				await registry.refresh();
				return { ok: true };
			}
			case "tool.approve": {
				const p = (params ?? {}) as { sessionId: string; requestId: string };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				if (!live.approvals.resolve(p.requestId, true)) throw new Error(`Unknown approval request: ${p.requestId}`);
				return { ok: true };
			}
			case "tool.deny": {
				const p = (params ?? {}) as { sessionId: string; requestId: string };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				if (!live.approvals.resolve(p.requestId, false))
					throw new Error(`Unknown approval request: ${p.requestId}`);
				return { ok: true };
			}
			case "fs.read": {
				// Minimal safe file read (dev-server detection): text files
				// up to 512 KiB only.
				const p = (params ?? {}) as { path?: string };
				if (!p.path) return { content: null };
				try {
					const st = fs.statSync(p.path);
					if (!st.isFile() || st.size > 512 * 1024) return { content: null };
					return { content: fs.readFileSync(p.path, "utf8") };
				} catch {
					return { content: null };
				}
			}
			case "fs.readBytes": {
				// Binary-safe file read for the GUI file preview (base64 +
				// mime + size). 8 MiB default cap, 32 MiB hard cap — previews
				// are meant for small files; big ones open via the OS.
				const p = (params ?? {}) as { path?: string; maxBytes?: number };
				if (!p.path) return { error: "missing path" };
				try {
					const st = fs.statSync(p.path);
					if (!st.isFile()) return { error: "not a file" };
					const max = Math.min(Math.max(p.maxBytes ?? 8 * 1024 * 1024, 1), 32 * 1024 * 1024);
					if (st.size > max) return { error: `file too large (${st.size} bytes)` };
					const buf = fs.readFileSync(p.path);
					return { base64: buf.toString("base64"), size: buf.length, mime: mimeForPath(p.path) };
				} catch (err) {
					return { error: err instanceof Error ? err.message : String(err) };
				}
			}
			case "fs.write": {
				// Create/overwrite a text file INSIDE the session workspace
				// (relative path only; `..` escapes rejected). Backs the GUI
				// file pane's 新建文件. Content is UTF-8 text.
				const p = (params ?? {}) as { cwd?: string; path?: string; content?: string };
				if (!p.cwd || !p.path) return { error: "missing cwd/path" };
				return writeWorkspaceFile(p.cwd, p.path, p.content ?? "");
			}
			case "fs.mkdir": {
				const p = (params ?? {}) as { cwd?: string; path?: string };
				if (!p.cwd || !p.path) return { error: "missing cwd/path" };
				return createWorkspaceDir(p.cwd, p.path);
			}
			case "fs.rename": {
				const p = (params ?? {}) as { cwd?: string; from?: string; to?: string };
				if (!p.cwd || !p.from || !p.to) return { error: "missing cwd/from/to" };
				return renameWorkspaceEntry(p.cwd, p.from, p.to);
			}
			case "fs.delete": {
				// Delete a workspace entry (file or directory tree). The GUI
				// only sends this after an explicit confirm dialog.
				const p = (params ?? {}) as { cwd?: string; path?: string };
				if (!p.cwd || !p.path) return { error: "missing cwd/path" };
				return deleteWorkspaceEntry(p.cwd, p.path);
			}
			case "workspace.tree": {
				const p = (params ?? {}) as { cwd?: string; maxDepth?: number; perDirLimit?: number | null };
				return this.#host.workspaceTree(p.cwd ?? "", { maxDepth: p.maxDepth, perDirLimit: p.perDirLimit });
			}
			default:
				throw new Error(`Unknown method: ${method}`);
		}
	}
}

/** Non-empty trimmed string, else undefined (credential label helper). */
function nonEmptyLabel(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Classify device-flow fetch failures: transient network errors (EOF,
 * refused, timeout, DNS) keep polling per GitHub's device-flow guidance;
 * TLS/certificate failures are environmental and reported as a clear
 * message instead of the raw Bun fetch text ("unknown certificate
 * verification error" means nothing to users).
 */
function classifyNetworkError(err: unknown): "transient" | "fatal" {
	const msg = err instanceof Error ? err.message : String(err);
	if (/certificate|SSL|TLS|handshake/i.test(msg)) return "fatal";
	return "transient";
}
function friendlyNetworkError(err: unknown): string {
	const msg = err instanceof Error ? err.message : String(err);
	if (/certificate|SSL|TLS|handshake/i.test(msg)) {
		return "无法验证 GitHub 的 TLS 证书——请检查系统代理/VPN 或网络拦截";
	}
	if (/ENOTFOUND|getaddrinfo|DNS/i.test(msg)) return "无法解析 GitHub 域名——请检查网络连接";
	if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|EOF|fetch failed|network|Unable to connect/i.test(msg)) {
		return "连接 GitHub 失败（网络中断或代理拦截）——请检查网络后重试";
	}
	return msg;
}

/** Extension → MIME for the GUI file preview (fallback application/octet-stream). */
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

const BUILTIN_MODEL_ROLES = new Set([
	"default",
	"smol",
	"slow",
	"vision",
	"plan",
	"designer",
	"commit",
	"tiny",
	"task",
	"advisor",
]);

/** True for the canonical built-in role ids (priority patterns exist). */
function isBuiltinRole(role: string): boolean {
	return BUILTIN_MODEL_ROLES.has(role);
}

/**
 * Wire-safe model detail row (TUI model-browser parity): identity plus the
 * detail lines the browser shows — context window, output budget, per-M
 * cost, reasoning flag, vision support, and the thinking efforts the model
 * actually exposes (drives the GUI thinking selector's exact ladder).
 */
function modelDetailRow(model: {
	id: string;
	name?: string;
	provider?: string;
	contextWindow?: number | null;
	maxTokens?: number | null;
	cost?: { input?: number; output?: number };
	reasoning?: boolean;
	input?: string[];
}): {
	id: string;
	name: string;
	provider: string;
	contextWindow: number | null;
	maxTokens: number | null;
	costInput: number;
	costOutput: number;
	reasoning: boolean;
	vision: boolean;
	efforts: string[];
} {
	return {
		id: model.id,
		name: model.name ?? model.id,
		provider: model.provider ?? "",
		contextWindow: model.contextWindow ?? null,
		maxTokens: model.maxTokens ?? null,
		costInput: model.cost?.input ?? 0,
		costOutput: model.cost?.output ?? 0,
		reasoning: model.reasoning === true,
		vision: Array.isArray(model.input) ? model.input.includes("image") : false,
		efforts: getSupportedEfforts(model as never).map(e => String(e)),
	};
}

/**
 * Display label for one stored credential (TUI /logout parity): email or
 * account id for OAuth rows, with the org appended when it differs so two
 * subscriptions on one email stay distinguishable; API-key rows fall back
 * to "API key #id".
 */
function storedCredentialLabel(row: StoredAuthCredential): string {
	const credential = row.credential;
	if (credential.type !== "oauth") return `API key #${row.id}`;
	const base =
		nonEmptyLabel(credential.email) ??
		nonEmptyLabel(credential.accountId) ??
		nonEmptyLabel(credential.projectId) ??
		nonEmptyLabel(credential.enterpriseUrl) ??
		`OAuth credential #${row.id}`;
	const org = nonEmptyLabel(credential.orgName) ?? nonEmptyLabel(credential.orgId);
	return org && org !== base ? `${base} (${org})` : base;
}

/**
 * Shared JSON-RPC line dispatcher: parse → dispatch → respond, then replay
 * resume catch-up deltas. Used by the unix-socket and WebSocket transports.
 */
async function handleRpcLine(server: DaemonServer, line: string, conn: DaemonConnection): Promise<void> {
	let req: RpcRequest;
	try {
		req = JSON.parse(line) as RpcRequest;
	} catch {
		conn.send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
		return;
	}
	try {
		const result = await server.handle(req.method, req.params, conn);
		conn.send({ jsonrpc: "2.0", id: req.id, result });
		// Resume catch-up deltas must follow the snapshot-bearing response.
		await server.catchupIfNeeded(req.method, req.params, conn);
	} catch (err) {
		conn.send({
			jsonrpc: "2.0",
			id: req.id,
			error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
		});
	}
}

// ── Server bootstrap ────────────────────────────────────────────────────────

/**
 * True once the background SDK prewarm (startDaemon) has finished loading
 * the lazy `../sdk` module graph. The GUI holds its boot splash on
 * system.prewarmStatus until this flips, so the first session.create /
 * session.resume never pays the multi-second import cost (splash covers
 * the prewarm window — 偷偷预热).
 */
let sdkPrewarmed = false;

export async function startDaemon(
	options: DaemonOptions = {},
): Promise<{ socketPath: string; wsPort?: number; close: () => Promise<void> }> {
	const socketPath = options.socketPath ?? DEFAULT_SOCKET;
	await fs.promises.mkdir(path.dirname(socketPath), { recursive: true });
	try {
		await fs.promises.unlink(socketPath);
	} catch {
		// no stale socket
	}

	const host = new DaemonSessionHost(options);
	const server = new DaemonServer(host);

	// Prewarm the lazy SDK module graph in the background so the FIRST
	// session.create / session.resume does not pay the multi-second import
	// cost (measured ~4s: provider registry, tool registry, catalog,
	// extensions). The daemon intentionally keeps startup cheap (createAgentSession
	// is a lazy import), so the cost is shifted here — after daemon boot the
	// first GUI-initiated session op is already warm. Bun's module cache makes
	// the later `await import("../sdk")` in createSession resolve instantly.
	// The GUI holds its boot splash until system.prewarmStatus reports ready
	// (waitForSdkPrewarm in app.tsx), so the user never hits the un-warmed
	// window even right after the daemon is spawned.
	void import("../sdk")
		.then(() => {
			sdkPrewarmed = true;
			logger.debug("sdk prewarmed for daemon session ops");
		})
		.catch(err => {
			logger.warn("sdk prewarm failed (first session op will pay the import cost)", {
				error: err instanceof Error ? err.message : String(err),
			});
		});

	// Process-global freeze state rides to every subscribed GUI (daemon-wide
	// pause overlay stays in sync across clients regardless of which one
	// toggled it); per-session pause rides the session stream separately.
	const unsubscribePause = agentPauseGate.onChange(paused => {
		server.broadcastGlobalPause(paused, agentPauseGate.pausedAt ?? null);
	});
	const sockets = new Set<net.Socket>();
	let connCounter = 0;

	// Optional browser-reachable transport: ws://127.0.0.1:wsPort (JSON-RPC
	// over WebSocket text frames). Browsers cannot speak unix sockets, so the
	// GUI connects here; the unix socket stays the local CLI path.
	let wsHandle: DaemonWsHandle | null = null;
	if (options.wsPort !== undefined) {
		try {
			wsHandle = await startDaemonWs({
				port: options.wsPort,
				onMessage: (conn, text) => void handleRpcLine(server, text, conn),
				onClose: connId => host.disconnect(connId),
			});
		} catch (err) {
			host.dispose();
			throw err;
		}
	}

	const netServer = net.createServer(socket => {
		const conn: DaemonConnection = {
			id: `c${++connCounter}`,
			send: message => {
				if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
			},
		};
		sockets.add(socket);
		let buffer = "";

		socket.on("data", chunk => {
			buffer += chunk.toString("utf8");
			if (buffer.length > MAX_REQUEST_BYTES) {
				conn.send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } });
				buffer = "";
				return;
			}
			for (;;) {
				const idx = buffer.indexOf("\n");
				if (idx === -1) break;
				const line = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 1);
				if (!line.trim()) continue;
				void handleRpcLine(server, line, conn);
			}
		});

		socket.on("error", () => {
			/* socket-level errors: connection dies, nothing to report */
		});
		socket.on("close", () => {
			sockets.delete(socket);
			host.disconnect(conn.id);
		});
	});

	// Persist the bound WS port so desktop shells can discover a running
	// daemon without probing ports (opencode model: GUI auto-connects,
	// manual URL entry is only the fallback).
	const portFile = path.join(path.dirname(socketPath), "ws.port");
	if (wsHandle) {
		try {
			await fs.promises.writeFile(portFile, String(wsHandle.port), "utf8");
		} catch {
			// non-fatal: discovery just falls back to probing
		}
	}

	await new Promise<void>((resolve, reject) => {
		// net.createServer's returned type lacks .once in the current Bun
		// type set — narrow to the EventEmitter surface it actually is.
		const srv = netServer as unknown as NodeJS.EventEmitter;
		srv.once("error", reject);
		netServer.listen(socketPath, resolve);
	});

	return {
		socketPath,
		wsPort: wsHandle?.port,
		close: async () => {
			try {
				await fs.promises.unlink(portFile);
			} catch {
				// already gone
			}
			if (wsHandle) await wsHandle.close();
			unsubscribePause();
			for (const socket of sockets) socket.destroy();
			host.dispose();
			await new Promise<void>(resolve => netServer.close(() => resolve()));
			try {
				await fs.promises.unlink(socketPath);
			} catch {
				// already gone
			}
		},
	};
}
