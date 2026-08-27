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

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { EXTENSION_SLOT_DECLARATION } from "@musepi/collab-proto/extension-slots";
import { getDashboardStats } from "@musepi/musepi-stats";
import { AgentBusyError, AgentPauseGate, agentPauseGate } from "@musepi/pi-agent-core";
import { effectiveReserveTokens, resolveThresholdTokens } from "@musepi/pi-agent-core/compaction";
import type { AuthStorage, DisabledCredentialSummary, UsageReport } from "@musepi/pi-ai";
import { resolveUsedFraction } from "@musepi/pi-ai";
import { getOAuthProviders } from "@musepi/pi-ai/oauth";
import { PROVIDER_REGISTRY } from "@musepi/pi-ai/registry";
import {
	validateAnthropicCompatibleApiKey,
	validateOpenAICompatibleApiKey,
} from "@musepi/pi-ai/registry/api-key-validation";
import { resolveModelCapabilities } from "@musepi/pi-catalog/identity";
import { getSupportedEfforts } from "@musepi/pi-catalog/model-thinking";
import { type GeneratedProvider, getBundledModels, getBundledProviders } from "@musepi/pi-catalog/models";
import { DesktopSession, FileType, type GlobMatch, getWorkProfile, listWorkspace } from "@musepi/pi-natives";
import { $env, getAgentDir, getConfigRootDir, getSessionsDir, logger, prompt, VERSION } from "@musepi/pi-utils";
import type { AgentEvent, SessionEntry, SessionHeader, SessionState, WireMessage } from "@musepi/pi-wire";
import type { SessionStreamEvent } from "@musepi/sdk";
import { MaterializedView, messageKey, type Static, type sessionSnapshot } from "@musepi/sdk";
import { YAML } from "bun";
import { MANAGED_SKILLS_PROVIDER_ID } from "../autolearn/managed-skills";
import { reset as resetCapabilities } from "../capability";
import {
	ChannelCommandHandler,
	type ChannelKind,
	ChannelRegistry,
	DiscordChannel,
	FeishuChannel,
	HuaweiTodayChannel,
	TelegramChannel,
	WechatChannel,
} from "../channels";
import { BUILTIN_PLUGINS, loadChannelPlugins } from "../channels/plugins";
import { CollabHost } from "../collab/host";
import { LocalShareManager } from "../collab/local-share";
import type { WorkspaceSessionInfo } from "../collab/protocol";
import type { CollabToolHandle } from "../tools/collab";
import { isWireAgentEvent, toWireAgentEvent } from "../collab/wire-guard";
import { findConfigFile } from "../config";
import type { ModelRegistry } from "../config/model-registry";
import { resolveProviderModelReference } from "../config/model-resolver";
import type { PromptTemplate } from "../config/prompt-templates";
import { isSensitiveSettingPath, type Settings } from "../config/settings";
import type { SettingPath } from "../config/settings-schema";
// TUI /debug selector parity (desktop adaptation): the same pure helpers the
// TUI debug menu uses, exposed as debug.* RPCs so the GUI can render its own
// diagnostics panel. Only TUI-free modules are imported here (report-bundle,
// system-info, profiler, remote-debugger, raw-sse-buffer — no pi-tui).
import { type CpuProfile, generateHeapSnapshotData, type ProfilerSession, startCpuProfile } from "../debug/profiler";
import { getRemoteDebugger, startRemoteDebuggerServer } from "../debug/remote-debugger";
import { clearArtifactCache, createReportBundle, getArtifactCacheStats, getLogText } from "../debug/report-bundle";
import { collectSystemInfo, formatSystemInfo } from "../debug/system-info";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../discovery/helpers";
import type { CustomTool } from "../extensibility/custom-tools/types";
import { buildSkillPromptMessage, parseSkillInvocation, type Skill } from "../extensibility/skills";
import { type FileSlashCommand, loadSlashCommands } from "../extensibility/slash-commands";
import { FileIndexService } from "../file-index";
import type { MCPManager } from "../mcp";
import { MCP_CONNECTION_STATUS_EVENT_CHANNEL, type McpConnectionStatusEvent } from "../mcp/startup-events";
import { computeContextBreakdown } from "../modes/utils/context-usage";
import { resolveApprovedPlan, resolvePlanTitle } from "../plan-mode/approved-plan";
import { listPlanFiles, readPlanFile, writePlanFile } from "../plan-mode/plan-files";
import guidedGoalInterviewPrompt from "../prompts/goals/guided-goal-interview.md" with { type: "text" };
import planModeApprovedPrompt from "../prompts/system/plan-mode-approved.md" with { type: "text" };
import idleRecapPrompt from "../prompts/system/recap-user.md" with { type: "text" };
import type { CompactMode } from "../session/compact-modes";
import {
	createForeignSessionStore,
	foreignSessionSourceName,
	foreignSessionSources,
	persistForeignSession,
} from "../session/foreign-session-import";
import type { ForeignSessionInfo, ForeignSessionSource } from "../session/foreign-session-store";
import { SKILL_PROMPT_MESSAGE_TYPE } from "../session/messages";
import type { SessionInfo, SessionStatus } from "../session/session-listing";
import type { SnapcompactSavingsEstimate } from "../session/snapcompact-inline";
import { executeAcpBuiltinSlashCommand } from "../slash-commands/acp-builtins";
import { lookupBuiltinSlashCommand } from "../slash-commands/builtin-registry";
import { parseSlashCommand } from "../slash-commands/helpers/parse";
import { resolvePromptInput } from "../system-prompt";
import { refreshAgentDiscovery } from "../task";
import type { ConfiguredThinkingLevel } from "../thinking";
import { previewLine, TRUNCATE_LENGTHS } from "../tools/render-utils";
import { nextActionableTask, type TodoPhase } from "../tools/todo";
import { ToolError } from "../tools/tool-errors";
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
import { createExtensionManagerTools } from "./extension-lifecycle-tools";
import { createExtensionRuntimeTools, RuntimeToolRegistry } from "./extension-runtime-tools";
import { createWorkspaceDir, deleteWorkspaceEntry, renameWorkspaceEntry, writeWorkspaceFile } from "./fs-ops.js";
import { pauseSidecarPath, readPauseSidecar, writePauseSidecar } from "./pause-sidecar";
import { addRemoteHost, browseRemoteDir, connectRemoteHost, disconnectRemoteHost, listRemoteHosts } from "./remote";
import {
	collectStoredAccounts,
	collectUnreportedAccounts,
	computeReloginDeadlines,
	isActionableDisable,
	selectReportableAccounts,
} from "./usage-shared";

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
import type { ExtensionNotificationMessage, ExtensionSetting, ExtensionUIContext } from "../extensibility/extensions/types";
import type { AgentSession } from "../session/agent-session";
import type { StoredAuthCredential } from "../session/auth-storage";
import { USER_INTERRUPT_LABEL } from "../session/messages";
import {
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
} from "../task/types";
import { EventBus } from "../utils/event-bus";
import { installWindowsSpawnGuard } from "../utils/windows-spawn-guard";
import { openPath } from "../utils/open";
import { type ApprovalBridge, createApprovalBridge, type PendingApproval, type PendingAsk } from "./approval-bridge";
import { type BatchedEvent, EventBatcher } from "./event-batcher";
import { AppendJournal } from "./journal";
import { type MaterializedRow, ViewStore, viewStorePath } from "./view-store";
import { type DaemonWsHandle, startDaemonWs } from "./ws-transport";
import { type DaemonWebHandle, startDaemonWeb } from "./static-web";
import { getFxRates } from "./fx-rates";

export interface DaemonOptions {
	socketPath?: string;
	/** Optional WebSocket port (browser-reachable JSON-RPC transport). */
	wsPort?: number;
	/** Optional loopback HTTP port serving the renderer bundle (desktop-web
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
const SOCKET_DIR = process.env.MUSEPI_DAEMON_DIR || path.join(os.tmpdir(), "musepi-daemon");

/** One skill entry served by skills.list (scan + enablement state). */
interface SkillListItem {
	name: string;
	description: string;
	filePath: string;
	source: string;
	hide: boolean;
	/** Virtual skills declared by extensions (registerSkill) carry their
	 *  markdown body here instead of a file (filePath === ""). */
	content?: string;
	_source?: { provider: string; providerName: string; path: string; level: "user" | "project" | "native" };
}

/** Unified extension entry (extension control center, TUI parity). */
type Extension = import("../extensibility/extensions-center/types").Extension;

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
/** Mobile pair-code lifetime (10 min). */
const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
/** Mobile pair endpoint port — resolves pair codes only (LAN). */
const PAIR_PORT = 8301;
/**
 * Live-session LRU cap: the GUI switch keeps every visited session live
 * (idle-close only after IDLE_TIMEOUT_MS), so a long session-switching
 * session would accumulate full agent runtimes (journal + materialized
 * view + agent loop) with no bound. When the live map exceeds the cap the
 * scanner closes the oldest IDLE sessions — never a working/compacting
 * one — and they stay listed + resumable as snapshot-only history
 * (activate() re-attaches on open).
 */
const MAX_LIVE_SESSIONS = 8;

/**
 * Tail-window the initial snapshot: the GUI opens a
 * session showing the LATEST messages and pages older history up as the
 * user scrolls (session.history) — the full transcript is never shipped
 * (or held) up front. `tail` rides on the returned snapshot: hasMore =
 * older history exists, beforeId = cursor for session.history (the
 * oldest entry in the tail).
 */
const TAIL_ENTRIES = 200;
interface TailInfo {
	hasMore: boolean;
	beforeId: string | null;
}
function tailSnapshot<T extends { entries?: readonly unknown[] }>(snap: T): T & { tail: TailInfo } {
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
const IDLE_SCAN_INTERVAL_MS = 60 * 1000;
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
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

interface RpcRequest {
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
class SessionScopedEventBus extends EventBus {
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

interface LiveSession {
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
	/** 会话预设(mode)id,取自 SDK 会话 header(Modes v1;create 写入,activate 读回)。 */
	modeId?: string;
	/** Incrementing event sequence for the stream contract. */
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
interface CachedSessionDiscovery {
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
function discoverySettingsFingerprint(settings: Settings): string {
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
	setOnExtensionNotification(
		handler: (channel: string, message: ExtensionNotificationMessage) => void,
	): void {
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
	/** Agent turn finished (agent_end) — DaemonServer wires task-completion
	 *  channel pushes here. */
	onAgentEnd: ((live: LiveSession) => void) | null = null;
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
		/** 会话预设(mode)id:v1 创建时应用(白名单/提示词/settings;docs/modes-plan.md)。 */
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
		const result = await createAgentSession({
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
			...(await desktopSessionPromptInputs(cwd)),
			...(params.modelPattern ? { modelPattern: params.modelPattern } : {}),
			...(params.thinkingLevel ? { thinkingLevel: params.thinkingLevel } : {}),
			...(params.modeId ? { modeId: params.modeId } : {}),
		});
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
		const result = await createAgentSession({
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
			...(await desktopSessionPromptInputs(resumeCwd)),
		});
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
					cursor: viewEntries.length,
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
			modeId: agentSession.sessionManager?.getHeader()?.modeId ?? undefined,
			seq: viewFinal.cursor,
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
		live.idleTimer = setTimeout(() => this.close(sessionId), IDLE_TIMEOUT_MS);
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
				this.onAgentEnd?.(live);
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
				void live.journal
					.shouldCompact()
					.then(needed => {
						if (needed && live.journal)
							return live.journal.compact(live.view.cursor, live.view.snapshot());
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
		this.#dynamicRegistries.delete(sessionId);
		live.dispose();
	}

	#scanIdle(): void {
		const now = Date.now();
		for (const [id, live] of this.#sessions) {
			if (now - live.lastActivity > IDLE_TIMEOUT_MS) this.close(id);
		}
		// LRU cap: close the oldest idle sessions past MAX_LIVE_SESSIONS.
		// lastActivity is touched on resume/send, so a session the user just
		// switched away from ages naturally while active ones stay live.
		if (this.#sessions.size > MAX_LIVE_SESSIONS) {
			const excess = this.#sessions.size - MAX_LIVE_SESSIONS;
			const candidates = [...this.#sessions.entries()]
				.filter(([, live]) => !live.agentSession?.isStreaming && !live.agentSession?.isCompacting)
				.sort((a, b) => a[1].lastActivity - b[1].lastActivity);
			for (const [id] of candidates.slice(0, excess)) this.close(id);
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
			return snap;
		}
		// History path: no running session — serve the persisted materialized
		// snapshot, degrading to a journal replay when the cache is absent.
		// Archived sessions are by definition idle: a stored isStreaming=true
		// (daemon shut down mid-stream) must never make the GUI show a phantom
		// working turn with an un-stoppable stop button.
		const archivedPause = await readPauseSidecar(sessionId, JOURNAL_DIR);
		const idleHistory = (view: MaterializedView): Static<typeof sessionSnapshot> => {
			const snap = view.snapshot();
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
function renderDebugTranscript(entries: unknown[]): string {
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
function extractEntryText(entry: { content?: unknown; text?: unknown }): string {
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

// ── Method dispatch ─────────────────────────────────────────────────────────

export class DaemonServer {
	readonly #host: DaemonSessionHost;
	/** Served compat renderer origin (set by startDaemon after startDaemonWeb
	 *  binds; null when --web-port is absent or the dist is missing). The
	 *  desktop-shell extension reports it so the GUI shell knows where the
	 *  runtime-served content lives. */
	#webUrl: string | null = null;

	setWebUrl(url: string | null): void {
		this.#webUrl = url;
	}

	getWebUrl(): string | null {
		return this.#webUrl;
	}

	/** Daemon socket path (set by startDaemon; used for the web.port
	 *  discovery file that sits beside daemon.sock). */
	#socketPath: string = "";

	setSocketPath(p: string): void {
		this.#socketPath = p;
	}
	/** Connections registered via events.subscribe — receive global (non-
	 *  session) daemon events such as extensions.changed (HMR). */
	readonly #globalEventTargets = new Set<DaemonConnection>();
	#globalEventSeq = 0;
	/** Speech-model downloads currently running (keyed by model tier key).
	 *  Guards against two windows (or a double-click race) starting parallel
	 *  fetches into the same cache directory. */
	readonly #sttDownloads = new Map<string, Promise<void>>();

	/** Drop a connection from the global-event targets (called on close —
	 *  the host's disconnect handles the session subscription side). */
	dropGlobalEventTarget(connectionId: string): void {
		for (const conn of this.#globalEventTargets) {
			if (conn.id === connectionId) {
				this.#globalEventTargets.delete(conn);
				break;
			}
		}
	}
	/** Scheduled tasks (cron): loaded from ~/.musepi/crons.json; a 30s
	 *  scanner runs due tasks in fresh sessions (kimi cron parity). */
	#cronTasks: CronTask[] = [];
	#cronRuns: CronRun[] = [];
	#cronTimer: ReturnType<typeof setInterval> | null = null;
	#cronStarting = new Set<string>();

	/** In-flight CPU profilers started by debug.profileStart (TUI /debug
	 *  performance-report parity: profile spans two RPC calls so the GUI can
	 *  hold "reproduce, then stop" between them). */
	#debugProfilers = new Map<number, ProfilerSession>();
	#nextDebugProfilerId = 1;

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
		host.setCollabToolProvider(() => this.#collabToolHandle());
		host.setOnExtensionNotification((channel, message) => {
			this.#broadcastExtensionNotification(channel, message);
		});
		this.#host = host;
		this.#cronTasks = loadCronTasks();
		this.#cronRuns = loadCronRuns();
		this.#cronTimer = setInterval(() => this.#cronScan(), 30_000);
		this.#cronTimer.unref?.();
		this.#startExtensionWatcher();
		// Bot/notification channels (CollabDialog "use bot channel" + task
		// completion pushes). Persisted config lives in the daemon dir.
		const handler = new ChannelCommandHandler(
			{
				listSessions: async () => {
					const rows: { id: string; title: string }[] = [];
					for (const id of this.#host.sessions()) {
						const live = this.#host.get(id);
						const snap = live?.view.snapshot();
						rows.push({
							id,
							title: snap?.header?.title ?? snap?.state.sessionName ?? "",
						});
					}
					return rows;
				},
				startSession: async prompt => {
					const { sessionId } = await this.#host.createSession({});
					if (prompt) await this.#sendToSession(sessionId, prompt);
					return sessionId;
				},
				stopSession: id => Promise.resolve(this.#host.close(id)),
				currentSessionId: () => {
					const it = this.#host.sessions();
					const first = it.next();
					return first.done ? null : first.value;
				},
				sendPrompt: (sessionId, text, images) => this.#sendToSession(sessionId, text, images),
			},
			(kind, from, text) => this.#channels.send(kind as ChannelKind, { to: from, text }),
		);
		this.#channels = new ChannelRegistry({
			configPath: path.join(SOCKET_DIR, "channels.json"),
			host: handler,
			factories: {
				"huawei-today": () => new HuaweiTodayChannel(),
				discord: () => new DiscordChannel(),
				wechat: () => new WechatChannel(),
				telegram: () => new TelegramChannel(),
				feishu: () => new FeishuChannel("feishu"),
				lark: () => new FeishuChannel("lark"),
			},
		});
		// agent_end → task-completion pushes (huawei today-screen).
		host.onAgentEnd = live => void this.#pushTaskCompletion(live).catch(() => {});
		void this.#channels.startAll().catch(() => {});
		// Hot-pluggable channel plugins: scan ~/.musepi/agent/channels/*.ts
		// and register any discovered channel modules (game-mod style).
		this.#channelPluginDir = path.join(getAgentDir(), "channels");
		void this.#loadChannelPlugins().catch(() => {});
	}

	/** Active GUI collab share (ZCode remote-control dialog). */
	#collab: { host: CollabHost; transport: LocalShareManager } | null = null;

	/** Mobile pair codes: 6-digit code → the shared webLink + expiry. The
	 *  GUI displays the code; the mobile app resolves it against the LAN
	 *  pair endpoint (pair.resolve) to obtain the full collab link without
	 *  typing it. Pruned lazily on generate/resolve. */
	#pairCodes = new Map<string, { webLink: string; expiresAt: number }>();
	/** LAN pair endpoint (ws://0.0.0.0:8301) — resolves pair codes only. */
	#pairWs: DaemonWsHandle | null = null;

	/** Bot/notification channels (wechat/discord/huawei-today…). */
	#channels: ChannelRegistry;
	/** Directory for hot-pluggable channel plugins (game-mod style). */
	#channelPluginDir = "";

	/** Load directory plugins and register them (hot-plug on reload). */
	async #loadChannelPlugins(): Promise<void> {
		if (!this.#channelPluginDir) return;
		const found = await loadChannelPlugins(this.#channelPluginDir);
		const known = new Set(this.#channels.kinds());
		for (const { plugin, origin } of found) {
			if (known.has(plugin.kind)) continue; // builtin wins
			this.#channels.register(plugin.kind, () => plugin.create({ host: this.#channels.host }));
			logger.info(`channel plugin registered: ${plugin.kind} (${origin})`);
		}
	}

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

	/** Lazily start the LAN pair endpoint (pair.resolve only). Bound to
	 *  0.0.0.0 so the mobile app can fetch the full collab link from a
	 *  6-digit code; it carries no other RPC surface. */
	async #ensurePairServer(): Promise<void> {
		if (this.#pairWs) return;
		try {
			this.#pairWs = await startDaemonWs({
				port: PAIR_PORT,
				host: "0.0.0.0",
				onMessage: (conn, text) => {
					let req: { method?: unknown; params?: { code?: unknown } };
					try {
						req = JSON.parse(text) as { method?: unknown; params?: { code?: unknown } };
					} catch {
						conn.send({ error: { message: "invalid json" } });
						return;
					}
					if (req.method !== "pair.resolve") {
						conn.send({ error: { message: "unsupported method" } });
						return;
					}
					const code = typeof req.params?.code === "string" ? req.params.code : "";
					const entry = this.#pairCodes.get(code);
					if (!entry || entry.expiresAt < Date.now()) {
						this.#pairCodes.delete(code);
						conn.send({ error: { message: "invalid or expired pair code" } });
						return;
					}
					conn.send({ result: { webLink: entry.webLink } });
				},
				onClose: () => {},
			});
		} catch (err) {
			logger.warn("pair endpoint unavailable", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	#prunePairCodes(): void {
		const now = Date.now();
		for (const [code, entry] of this.#pairCodes) {
			if (entry.expiresAt < now) this.#pairCodes.delete(code);
		}
	}
	/**
	 * Agent `collab` tool handle: a thin shell over the daemon RPC surface.
	 * The collab.* RPC cases never write to the connection, so a dummy conn
	 * is safe — this keeps the tool and the GUI share panel on the exact
	 * same code path.
	 */
	#collabToolHandle(): CollabToolHandle {
		const dummyConn: DaemonConnection = { id: "collab-tool", send: () => {} };
		return {
			start: async opts => {
				const mode =
					opts.mode === "tunnel" ? "tunnel" : opts.mode === "workspace" ? "workspace" : "session";
				const result = await this.handle(
					"collab.start",
					{ mode, ...(opts.sessionId ? { sessionId: opts.sessionId } : {}) },
					dummyConn,
				);
				return result as { link?: string; webLink?: string; viewLink?: string };
			},
			stop: async () => (await this.handle("collab.stop", {}, dummyConn)) as { ok: boolean },
			status: async () =>
				(await this.handle("collab.status", {}, dummyConn)) as {
					hosting: boolean;
					link?: string;
					webLink?: string;
					viewLink?: string;
				},
			generatePair: async () =>
				(await this.handle("collab.pair.generate", {}, dummyConn)) as {
					code: string;
					expiresInSeconds: number;
					lanPort: number;
				},
		};
	}

	/** Send a user message to a session (reactivating history sessions),
	 *  mirroring the session.send RPC path. `images` are base64 attachments
	 *  forwarded from IM channels (wechat/discord). */
	async #sendToSession(sessionId: string, text: string, images?: { data: string; mimeType: string }[]): Promise<void> {
		const live = this.#host.get(sessionId) ?? (await this.#host.activate(sessionId));
		const content =
			images && images.length > 0
				? [
						...(text ? [{ type: "text" as const, text }] : []),
						...images.map(img => ({ type: "image" as const, data: img.data, mimeType: img.mimeType })),
					]
				: text;
		if (live.autoTitle) {
			const textPart = typeof content === "string" ? content : (content.find(c => c.type === "text")?.text ?? "");
			if (textPart) live.agentSession.maybeStartTitleGeneration(textPart);
		}
		await live.agentSession.sendUserMessage(content);
	}

	/** Push a task-completion summary to connected push channels (huawei
	 *  today-screen). Fire-and-forget; failures only log. */
	async #pushTaskCompletion(live: LiveSession): Promise<void> {
		const snap = live.view.snapshot();
		const title = snap.header?.title ?? snap.state.sessionName ?? "MusePi task";
		const text = snap.header?.model ? `Model: ${snap.header.model}` : "";
		for (const kind of ["huawei-today"] as const) {
			await this.#channels
				.send(kind, {
					taskName: title,
					text,
					markdown: `**${title}** completed`,
					taskResult: "completed",
				})
				.catch(err => {
					logger.warn(`channel push failed (${kind})`, {
						error: err instanceof Error ? err.message : String(err),
					});
				});
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

	/** TTL cache of the full installed-plugin inventory (settings → plugins
	 *  tab, enabled + disabled). */
	#pluginPackagesCache: {
		at: number;
		plugins: {
			name: string;
			version: string;
			path: string;
			scope: "user" | "project";
			enabled: boolean;
			description: string | null;
			tools: number;
			commands: number;
			handlers: number;
		}[];
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

	#extensionWatcherStarted = false;
	#extensionWatcherTimer: Timer | null = null;

	/** HMR: watch extension source/config directories; on change invalidate
	 *  the extension scan + component compile/load caches and broadcast
	 *  `extensions.changed` to events.subscribe clients so the GUI refreshes
	 *  slots/panels immediately instead of waiting for the next poll.
	 *  Session-scoped tools/handlers of already-loaded extensions pick up
	 *  the change on the next load (v1 scope). */
	#startExtensionWatcher(): void {
		if (this.#extensionWatcherStarted) return;
		this.#extensionWatcherStarted = true;
		const roots = [path.join(getAgentDir(), "extensions"), path.join(this.#host.cwd(), ".musepi", "extensions")];
		for (const root of roots) {
			try {
				fs.watch(root, { recursive: true }, () => this.#scheduleExtensionReload());
			} catch {
				// Root absent/unwatchable — the discovery scan still picks up
				// changes when its TTL expires.
			}
		}
	}

	#scheduleExtensionReload(): void {
		if (this.#extensionWatcherTimer) return;
		this.#extensionWatcherTimer = setTimeout(() => {
			this.#extensionWatcherTimer = null;
			this.#extensionsCache = null;
			this.#pluginsCache = null;
			// 扩展声明的技能经 #getSkills 合并:扩展源变更时一并失效,
			// 否则虚拟技能列表最多滞后 10s TTL。
			this.#skillsCache = null;
			void import("./extension-artifact-compiler").then(m => m.invalidateExtensionCaches());
			this.#broadcastExtensionsChanged();
			// P5 HMR v2: session-scoped hot reload of loaded extensions whose
			// entry changed on disk. The watcher callback filename is
			// unreliable (empty/short names on Windows recursive watch), so
			// the per-entry mtime comparison decides what changed.
			this.#reloadChangedSessionExtensions();
		}, 500);
	}

	/** 广播 extensions.changed(extensions.list 数据变更后调用):GUI 的
	 *  单例注册表监听此事件即时重拉 —— mutation RPC 清缓存后必须广播,
	 *  否则 UI 要等下一个轮询周期(10s)才看到翻转。 */
	#broadcastExtensionsChanged(): void {
		const seq = ++this.#globalEventSeq;
		for (const conn of this.#globalEventTargets) {
			this.#host.emitEvent(conn, {
				kind: "event",
				seq,
				payload: { type: "extensions.changed", at: Date.now() },
			});
		}
	}

	/** 广播 extensions.notification(扩展 registerNotificationChannel 推送):
	 *  转发到 events.subscribe 的 GUI 客户端。频道消息带 channel + 完整
	 *  message(text/title/kind),GUI 渲染为通知。 */
	#broadcastExtensionNotification(
		channel: string,
		message: ExtensionNotificationMessage,
	): void {
		const seq = ++this.#globalEventSeq;
		const payload = { type: "extensions.notification" as const, channel, message, at: Date.now() };
		for (const conn of this.#globalEventTargets) {
			try {
				this.#host.emitEvent(conn, { kind: "event", seq, payload });
			} catch {
				this.#globalEventTargets.delete(conn);
			}
		}
	}

	/** 预设目录(决策 #5):env MUSEPI_MODES_DIR 可覆盖(隔离测试),默认 <home>/.musepi/modes。 */
	#modesDir(): string {
		return $env.MUSEPI_MODES_DIR ?? path.join(os.homedir(), ".musepi", "modes");
	}

	/** 广播 modes.changed(设置页/输入框 chip 即时刷新;与 extensions.changed 同 seq 机制)。 */
	#broadcastModesChanged(): void {
		const seq = ++this.#globalEventSeq;
		for (const conn of this.#globalEventTargets) {
			this.#host.emitEvent(conn, {
				kind: "event",
				seq,
				payload: { type: "modes.changed", at: Date.now() },
			});
		}
	}
	/** 广播 models.changed(models.add/models.remove 后 GUI 模型选择器即时
	 *  重拉 —— 会话内的选择器常驻挂载,没有这个事件它永远停在旧列表)。 */
	#broadcastModelsChanged(): void {
		const seq = ++this.#globalEventSeq;
		for (const conn of this.#globalEventTargets) {
			this.#host.emitEvent(conn, {
				kind: "event",
				seq,
				payload: { type: "models.changed", at: Date.now() },
			});
		}
	}

	/**
	 * P5 HMR v2: for every live session, compare the entry mtimes recorded at
	 * load time against the filesystem and hot-reload entries that changed;
	 * notify the session's subscribers afterwards (`extensions.reloaded`).
	 * Busy sessions park the reload and perform it at their next idle
	 * `agent_end` (AgentSession busy gate); idle sessions reload immediately.
	 */
	#reloadChangedSessionExtensions(): void {
		for (const live of this.#host.allSessions()) {
			const session = live.agentSession;
			const entryMtimes = session.getExtensionEntryMtimes();
			if (entryMtimes.size === 0) continue;
			const changed: string[] = [];
			for (const [resolvedPath, recordedMtime] of entryMtimes) {
				try {
					if (fs.statSync(resolvedPath).mtimeMs > recordedMtime) changed.push(resolvedPath);
				} catch {
					// Entry deleted/renamed — leave the loaded instance as-is.
				}
			}
			if (changed.length === 0) continue;
			void this.#reloadSessionExtensions(live, changed);
		}
	}

	async #reloadSessionExtensions(live: LiveSession, entryPaths: string[]): Promise<void> {
		for (const entryPath of entryPaths) {
			const result = await live.agentSession.reloadExtension(entryPath);
			for (const send of live.subscribers.values()) {
				try {
					send({
						kind: "event",
						seq: ++live.seq,
						payload: {
							type: "extensions.reloaded",
							extensionPath: entryPath,
							removedTools: result.removedTools,
							errors: result.errors,
							deferred: result.deferred,
							at: Date.now(),
						},
					});
				} catch {
					// subscriber socket died; removed on close
				}
			}
		}
	}

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
			const { loadAllExtensions } = await import("../extensibility/extensions-center/state-manager");
			let settings = this.#host.settings();
			if (!settings) {
				await this.#host.ensureRegistry();
				settings = this.#host.settings();
			}
			const disabledIds = (settings?.get("disabledExtensions") ?? []) as string[];
			// omp 生态智能兼容:显式启用集(默认空的隐藏设置键)优先于优先级去重。
			// getRaw:forceEnabledExtensions 不在 schema(隐藏设置键),走原始读取。
			const forceIds = (settings?.getRaw("forceEnabledExtensions") ?? []) as string[];
			this.#extensionsCache = {
				at: Date.now(),
				extensions: await loadAllExtensions(this.#host.cwd(), disabledIds, forceIds),
			};
		}
		return this.#extensionsCache.extensions;
	}

	/**
	 * P0-② 挂载校验:mode 引用的每个扩展
	 * 独立加载(不注册到任何会话)验证加载错误 + 槽位组件可编译。
	 * schema/环/悬空/扩展存在性由 validateMode/resolveMode 负责,这里只做
	 * "真实挂载"层面的检查——standingKeyFor 同款语义:不建 agent 跑完整
	 * 挂载,失败四类精确报错。
	 */
	async #validateModeMounting(def: { extensions?: string[] }, errors: string[]): Promise<void> {
		const extensions = def.extensions ?? [];
		if (extensions.length === 0) return;
		const cwd = this.#host.cwd();
		const { loadExtensions } = await import("../extensibility/extensions/loader");
		const { validateExtensionComponents } = await import("./extension-artifact-compiler");
		const known = await this.#getExtensions();
		for (const id of extensions) {
			const entry = known.find(e => e.id === id);
			if (!entry) continue; // 未找到已由 validateMode 报
			const result = await loadExtensions([entry.path], cwd);
			if (result.errors.length > 0) {
				for (const err of result.errors) errors.push(`扩展 "${id}" 加载失败: ${err.error}`);
				continue;
			}
			const ext = result.extensions[0];
			if (!ext) {
				errors.push(`扩展 "${id}" 加载后为空`);
				continue;
			}
			const bad = await validateExtensionComponents(ext);
			for (const c of bad) errors.push(`扩展 "${id}" 组件 "${c.moduleUrl}" 编译失败: ${c.error}`);
		}
	}

	/** TTL-refreshed skills scan shared by skills.list and commands.list. */
	async #getSkills(): Promise<SkillListItem[]> {
		if (!this.#skillsCache || Date.now() - this.#skillsCache.at > 10_000) {
			const { discoverSkills } = await import("../sdk");
			const { skills, warnings } = await discoverSkills(this.#host.cwd());
			const scanned = skills.map(s => ({
				name: s.name,
				description: s.description,
				filePath: s.filePath,
				source: s.source,
				hide: s.hide === true,
				_source: s._source,
			}));
			// 扩展声明的虚拟技能(registerSkill):与文件扫描技能合并展示。
			// 无 backing 文件(filePath=""),
			// content 随行携带供 skills.read 直接返回;扩展卸载/禁用后
			// 自动消失(collectExtensionSkills 按 active 过滤)。
			const { collectExtensionSkills } = await import("./extension-artifact-compiler");
			const extSkills = await collectExtensionSkills(
				(await this.#getExtensions()).map(e => ({ kind: e.kind, state: e.state, path: e.path })),
				this.#host.cwd(),
			);
			const virtual = extSkills.map(s => ({
				name: s.name,
				description: s.description,
				filePath: "",
				source: "extension",
				hide: s.hide === true,
				content: s.content,
				_source: {
					provider: "extension",
					providerName: s.extensionPath,
					path: s.extensionPath,
					level: "user" as const,
				},
			}));
			this.#skillsCache = {
				at: Date.now(),
				skills: [...scanned, ...virtual],
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
				this.#host.emitEvent(conn, { kind: "global-pause-state", seq, payload: { paused, pausedAt } });
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

		// Resolve provider from manifest seam > settings.raw > default "auto".
		const { getTerminalProvider, resolveTerminalProvider } = await import("./terminal-provider.ts");
		const settings = await this.#settingsForRpc().catch(() => null);
		const manifestProvider = await (async () => {
			try {
				const { getSessionState } = await import("../assembly/index.ts");
				return getSessionState().manifest?.seams.terminal?.provider ?? null;
			} catch {
				return null;
			}
		})();
		const provider = getTerminalProvider(resolveTerminalProvider(settings ?? { getRaw: () => undefined } as never, manifestProvider));

		// Wrap the provider handle to emit daemon events.
		const handle = await provider.open(realCwd, cols, rows, shell, args, env);
		const entry = {
			async write(msg: unknown): Promise<void> {
				const m = msg as { method?: string; params?: Record<string, unknown> };
				if (m.method === "input") handle.write(String(m.params?.data ?? ""));
				else if (m.method === "resize") handle.resize(Number(m.params?.cols) || cols, Number(m.params?.rows) || rows);
				else if (m.method === "close") handle.dispose();
			},
			dispose(): void { handle.dispose(); },
		};
		handle.onData(d =>
			this.#host.emitEvent(conn, { kind: "terminal-output", seq: ++this.#eventSeq, payload: { id, data: d } }),
		);
		handle.onExit((code) => {
			this.#host.emitEvent(conn, {
				kind: "terminal-exit",
				seq: ++this.#eventSeq,
				payload: { id, code: code ?? 0 },
			});
		});
		this.#terminals.set(id, entry);
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

	/** Resolved settings for debug report bundles (TUI #getResolvedSettings
	 *  parity — the daemon has no TUI context, so the AgentSession carries
	 *  the same fields). */
	#debugSessionSettings(live: LiveSession): Record<string, unknown> {
		const session = live.agentSession;
		return {
			model: session.model?.id,
			thinkingLevel: session.thinkingLevel,
			planModeEnabled: session.getPlanModeState?.()?.enabled === true,
		};
	}

	/** Raw provider SSE diagnostics for a live session (empty → omitted from
	 *  report bundles, matching the TUI's conditional rawSseText). */
	#debugRawSseText(live: LiveSession): string | undefined {
		const text = live.agentSession.rawSseDebugBuffer?.toRawText() ?? "";
		return text.trim().length > 0 ? text : undefined;
	}

	async handle(method: string, params: unknown, conn: DaemonConnection): Promise<unknown> {
		switch (method) {
			case "system.ping": {
				// Liveness probe for the GUI's app-level keepalive (browsers
				// cannot send WS ping frames; the renderer pings this RPC to
				// detect sockets Electron tears down on system sleep).
				return { pong: Date.now() };
			}
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
					engine: musepiVersion ? `MusePi ${musepiVersion}` : `MusePi ${VERSION}`,
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
				const { parseChangelog, resolveStartupChangelogForDisplay, selectStartupChangelog } = await import(
					"../utils/changelog"
				);
				const currentVersion = process.env.MUSEPI_VERSION ?? VERSION;
				const p0 = (params as { force?: boolean; locale?: string } | undefined) ?? {};
				const force = p0.force === true;
				const locale = p0.locale === "en-US" ? "en-US" : "zh-CN";
				if (force) {
					const entries = await parseChangelog(undefined);
					const sel = selectStartupChangelog(entries, "0.0.0", currentVersion, locale);
					return sel ? { markdown: sel.markdown, latestVersion: sel.latestVersion } : null;
				}
				const settings = await this.#settingsForRpc();
				const mode = String(settings.get("startup.changelogMode") ?? "summary") as
					| "summary"
					| "expanded"
					| "hidden";
				const changelog = await resolveStartupChangelogForDisplay({
					mode,
					currentVersion,
					agentDir: getAgentDir(),
					locale,
				});
				return changelog
					? {
							markdown: changelog.markdown,
							latestVersion: changelog.latestVersion,
							locale,
						}
					: null;
			}
			case "updates.check": {
				// Version probe (Electron updater.cjs parity — the same
				// update-manifest.json asset on the latest GitHub release,
				// resolved via the /releases/latest/download redirect).
				// Respects startup.checkUpdate; network failure or
				// up-to-date resolve to null so the GUI never nags.
				const settings = await this.#settingsForRpc();
				if (!settings.get("startup.checkUpdate")) {
					return { latest: null };
				}
				try {
					const res = await fetch(
						"https://github.com/MuseLinn/MusePi/releases/latest/download/update-manifest.json",
						{ signal: AbortSignal.timeout(8_000) },
					);
					if (!res.ok) return { latest: null, notes: null };
					const data = (await res.json()) as {
						version?: unknown;
						notes?: { zh?: string; en?: string };
					};
					const latest = typeof data.version === "string" ? data.version : undefined;
					const currentVersion = process.env.MUSEPI_VERSION ?? VERSION;
					// Bilingual release notes (update-manifest.json): the GUI
					// picks a language by locale; daemon passes them through.
					const notes = data.notes && typeof data.notes === "object" ? data.notes : null;
					return {
						latest: latest && latest !== currentVersion ? latest : null,
						notes,
					};
				} catch {
					return { latest: null, notes: null };
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
			case "system.getAutostart": {
				// Desktop daemon launch-at-login (Windows Run key; macOS
				// LaunchAgents; Linux XDG autostart). openchamber parity —
				// but the DAEMON self-registers (independent of Electron),
				// so the setting survives GUI-less operation.
				return getAutostartState();
			}
			case "system.setAutostart": {
				const p = (params ?? {}) as { enabled?: boolean };
				const enabled = p.enabled === true;
				await setAutostartState(enabled);
				return { enabled };
			}
			case "session.create": {
				// modeId(modelPattern/thinkingLevel)透传 host.createSession ——
				// GUI welcome 预设 chip 的选择在创建时一次应用(modes v1/v2)。
				const p = (params ?? {}) as {
					cwd?: string;
					title?: string;
					forkOf?: string;
					modeId?: string;
					modelPattern?: string;
					thinkingLevel?: ConfiguredThinkingLevel;
				};
				return this.#host.createSession(p);
			}
			case "session.list": {
				const cronIds = this.#cronSessionIds();
				return (await this.#host.knownSessions()).map(r => {
					const live = this.#host.get(r.sessionId);
					return {
						id: r.sessionId,
						parentId: r.parentId,
						kind: "session",
						timestamp: new Date(r.createdAt).toISOString(),
						updatedAt: new Date(r.updatedAt).toISOString(),
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
						// Lifecycle status (TUI session-list parity): derived from
						// the session file tail (complete/interrupted/aborted/
						// error/pending) — lets the GUI color unfinished history.
						status: r.status ?? undefined,
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
					timestamp: new Date(r.createdAt).toISOString(),
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
				let usage: {
					totalTokens: number;
					totalCost: number;
					topModels: { name: string; cost: number }[];
					plans?: { provider: string; label: string }[];
					accounts?: {
						provider: string;
						plan?: string;
						windows: {
							label: string;
							windowLabel?: string;
							accounts: { label: string; used: number; limit?: number; fraction: number; resetsIn?: number }[];
						}[];
					}[];
				} | null = null;
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
					// /usage-aligned subscription summary: per provider, per
					// limit-window (5h/7d/...), per CREDENTIAL (scope.accountId)
					// — same bucketing the TUI/GUI /usage render. Each account
					// contributes its most-burned fraction per window (the
					// binding meter). Needs a live session's report pool.
					const liveIds = Array.from(this.#host.sessions());
					if (liveIds.length > 0) {
						const live = this.#host.get(liveIds[0]);
						const reports = live?.agentSession ? ((await live.agentSession.fetchUsageReports()) ?? []) : [];
						const plans = reports
							.filter(r => typeof r.metadata?.planType === "string")
							.map(r => ({ provider: r.provider, label: String(r.metadata!.planType) }));
						if (plans.length > 0) usage.plans = plans;
						const accounts = reports.map((r, ri) => {
							const windows = new Map<
								string,
								{
									label: string;
									windowLabel?: string;
									accounts: Map<
										string,
										{ label: string; used: number; limit?: number; fraction: number; resetsIn?: number }
									>;
								}
							>();
							for (const limit of r.limits ?? []) {
								const windowId = limit.window?.id ?? limit.scope?.windowId ?? "default";
								const windowLabel = limit.window?.label ?? windowId;
								const key = `${limit.label}|${windowId}`;
								const win = windows.get(key) ?? { label: limit.label, windowLabel, accounts: new Map() };
								const acctId = limit.scope?.accountId ?? `acct-${ri}`;
								const acct = win.accounts.get(acctId) ?? {
									label:
										typeof r.metadata?.email === "string" && r.metadata.email
											? r.metadata.email
											: typeof acctId === "string" && acctId.startsWith("acct-")
												? `account ${ri + 1}`
												: acctId,
									used: 0,
									fraction: 0,
								};
								const fraction = resolveUsedFraction(limit) ?? 0;
								if (fraction > acct.fraction) {
									acct.fraction = fraction;
									acct.used = limit.amount?.used ?? acct.used;
									acct.limit = limit.amount?.limit ?? acct.limit;
									if (limit.window?.resetsAt !== undefined && limit.window.resetsAt > Date.now()) {
										acct.resetsIn = limit.window.resetsAt - Date.now();
									}
								}
								win.accounts.set(acctId, acct);
								windows.set(key, win);
							}
							return {
								provider: r.provider,
								...(typeof r.metadata?.planType === "string" ? { plan: String(r.metadata.planType) } : {}),
								windows: [...windows.values()].map(w => ({
									label: w.label,
									...(w.windowLabel ? { windowLabel: w.windowLabel } : {}),
									accounts: [...w.accounts.values()].slice(0, 4),
								})),
							};
						});
						if (accounts.some(a => a.windows.some(w => w.accounts.length > 0))) usage.accounts = accounts;
					}
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
							updatedAt?: string;
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
							timestamp: new Date(r.createdAt).toISOString(),
							// Last-activity time (openchamber `time.updated` parity):
							// the sidebar sorts the session tree by this, so a
							// resumed/continued session rises without reordering
							// forks away from their parents.
							updatedAt: new Date(r.updatedAt).toISOString(),
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
				// Hydrate the stream-only visuals on (re)subscribe: running tool
				// calls + owned subagent progress never replay from the
				// snapshot, so a client switching back to a working session
				// would render a blank composer dock / swarm card until the
				// next live frame happens to arrive.
				const live = this.#host.get(p.sessionId);
				return {
					stream: conn.id,
					initial: {
						...tailSnapshot(await this.#host.snapshot(p.sessionId)),
						...(live
							? {
									activeTools: [...live.activeToolCalls.values()],
									agentsProgress: [...live.subagentProgress.values()],
								}
							: {}),
					},
				};
			}
			case "session.getSystemPrompt": {
				// Modes v1 E2E/诊断:读会话当前 systemPrompt(composer 注入后)。只读,不激活。
				const p = (params ?? {}) as { sessionId: string };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				return { systemPrompt: live.agentSession.systemPrompt };
			}
			case "session.snapshot": {
				// Read-only snapshot of any session WITHOUT subscribing or
				// activating it — used by secondary surfaces (pet panel content
				// preview) that need one shot of entries but must not attach the
				// connection's live stream to an extra session (that would bleed
				// its events into the GUI's single-store routing).
				const p = (params ?? {}) as { sessionId: string };
				if (!p.sessionId) throw new Error("sessionId required");
				return tailSnapshot(await this.#host.snapshot(p.sessionId));
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
				// Usage-stats sync (CLI `musepi stats` parity): incrementally
				// scan every session file (mtime/offset skip) into the shared
				// SQLite stats db. GUI settings → 数据与统计 → 使用统计.
				const { syncAllSessions } = await import("@musepi/musepi-stats");
				return await syncAllSessions();
			}
			case "stats.dashboard": {
				// Aggregated usage dashboard (model/folder/time-series/cost).
				const { getDashboardStats } = await import("@musepi/musepi-stats");
				const { range } = (params ?? {}) as { range?: string };
				return await getDashboardStats(typeof range === "string" && range ? range : null);
			}
			case "stats.tools": {
				// Tool-usage dashboard (calls per tool, by model).
				const { getToolDashboardStats } = await import("@musepi/musepi-stats");
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
			case "plugins.packages": {
				// Full installed-plugin inventory (enabled + disabled) for the
				// settings → plugins tab. Session-independent; TTL-cached so
				// the list doesn't re-walk node_modules on each tab switch.
				if (!this.#pluginPackagesCache || Date.now() - this.#pluginPackagesCache.at > 10_000) {
					const { getAllPlugins } = await import("../extensibility/plugins/loader");
					const installed = await getAllPlugins(this.#host.cwd());
					this.#pluginPackagesCache = {
						at: Date.now(),
						plugins: installed.map(p => ({
							name: p.name,
							version: p.version,
							path: p.path,
							scope: p.scope,
							enabled: p.enabled,
							description: p.manifest.description ?? null,
							tools: p.manifest.tools ? 1 : 0,
							commands: Array.isArray(p.manifest.commands) ? p.manifest.commands.length : p.manifest.commands ? 1 : 0,
							handlers: typeof p.manifest.hooks === "string" ? 1 : p.manifest.hooks ? Object.keys(p.manifest.hooks).length : 0,
						})),
					};
				}
				return this.#pluginPackagesCache;
			}
			case "plugins.setEnabled": {
				// Enable/disable an installed plugin (settings → plugins tab
				// toggle). Mirrors the TUI /plugins enable|disable command;
				// busts the TTL cache so the next list reflects the change.
				const { PluginManager } = await import("../extensibility/plugins/manager");
				const p = (params ?? {}) as { name: string; enabled: boolean };
				if (!p.name) throw new Error("plugins.setEnabled: name required");
				const manager = new PluginManager(this.#host.cwd());
				await manager.setPluginEnabled(p.name, Boolean(p.enabled));
				this.#pluginPackagesCache = null;
				this.#pluginsCache = null;
				return { ok: true, enabled: Boolean(p.enabled) };
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
				// musepi-managed skills (auto-learn) and extension-declared
				// virtual skills — the GUI mirrors this guard.
				const p = (params ?? {}) as { name: string };
				const skills = await this.#getSkills();
				const skill = skills.find(s => s.name === p.name);
				if (!skill) throw new Error(`unknown skill: ${p.name}`);
				const src = skill._source;
				if (
					skill.filePath === "" ||
					src?.level !== "user" ||
					src.provider === MANAGED_SKILLS_PROVIDER_ID ||
					src.provider === "native" ||
					src.provider === "extension"
				) {
					throw new Error("only user-level file skills can be deleted");
				}
				const { rm } = await import("node:fs/promises");
				await rm(skill.filePath, { force: true });
				this.#skillsCache = null;
				// extensions.list 也聚合 skill 项:清扩展缓存 + 广播,让
				// GUI 单例注册表立即刷新(消费端不再本地乐观过滤)。
				this.#extensionsCache = null;
				this.#broadcastExtensionsChanged();
				return { ok: true };
			}
			case "skills.read": {
				// SKILL.md source for the skill detail pane (OpenCode parity).
				const p = (params ?? {}) as { name: string };
				const skills = await this.#getSkills();
				const skill = skills.find(s => s.name === p.name);
				if (!skill) throw new Error(`unknown skill: ${p.name}`);
				// 扩展声明的虚拟技能:无 backing 文件,content 随行携带。
				if (skill.filePath === "" && skill.content !== undefined) {
					const content = skill.content;
					return {
						name: skill.name,
						filePath: "",
						content: content.length > 64 * 1024 ? `${content.slice(0, 64 * 1024)}\n… (truncated)` : content,
					};
				}
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
				// Builtin style extension state mirrors display.taskCardStyle
				// (the setting is the source of truth; setEnabled writes it).
				let s = this.#host.settings();
				if (!s) {
					// Shell mode/enabled live in settings; bootstrap the shared
					// instance so the desktop-shell entry reports them even
					// before any session exists (fresh daemon + compat page).
					await this.#host.ensureRegistry();
					s = this.#host.settings();
				}
				const rawStyle = s?.getRaw("display.taskCardStyle");
				const styleSetting: "swarm" | "classic" = rawStyle === "classic" ? "classic" : "swarm";
				// Desktop-shell config (dsh-desktop parity): the compat page /
				// GUI shell read enabled + mode + served origin from the
				// registry response (raw is stripped by the response mapping).
				const shellEnabled = s?.getRaw("shell.enabled");
				const shellMode = s?.getRaw("shell.mode");
				const shellCfg = {
					enabled: shellEnabled !== false,
					mode:
						shellMode === "extended" || shellMode === "enhanced" ? shellMode : "compatibility",
					webUrl: this.#webUrl,
				};
				for (const ext of extensions) {
					if (ext.id === "style:task-card-swarm") {
						ext.state = styleSetting === "classic" ? "disabled" : "active";
						ext.disabledReason = styleSetting === "classic" ? "item-disabled" : undefined;
					}
					// Desktop shell mirrors shell.enabled (setEnabled writes it);
					// disabled -> the GUI loads its local bundle instead of the
					// runtime-served renderer.
					if (ext.id === "desktop-shell:shell") {
						ext.state = shellCfg.enabled ? "active" : "disabled";
						ext.disabledReason = shellCfg.enabled ? undefined : "item-disabled";
					}
				}
				const { buildProviderTabs } = await import("../extensibility/extensions-center/state-manager");
				const tabs = buildProviderTabs(extensions);
				const { getAllProvidersInfo } = await import("../capability");
				const providers = getAllProvidersInfo().map(p => ({
					id: p.id,
					displayName: p.displayName,
					enabled: p.enabled,
				}));
				// Renderer-side slot components (ui-slots analogue): compiled
				// from active extension-module entries, cached 10s with the
				// extension scan. The GUI mounts them by slot id.
				const { collectSlotComponents, collectToolViews, collectStatusBarSegments } = await import("./extension-artifact-compiler");
				const components = await collectSlotComponents(
					extensions.map(e => ({ kind: e.kind, state: e.state, path: e.path })),
					this.#host.cwd(),
				);
				// Renderer-side per-tool views (registerToolView): the
				// transcript dispatches by tool name, replacing the built-in renderer.
				const toolViews = await collectToolViews(
					extensions.map(e => ({ kind: e.kind, state: e.state, path: e.path })),
					this.#host.cwd(),
				);
				// Status-bar segments (registerStatusBarSegment): the GUI status bar
				// merges these after its built-ins, ordered by `order`.
				const statusBarSegments = await collectStatusBarSegments(
					extensions.map(e => ({ kind: e.kind, state: e.state, path: e.path })),
					this.#host.cwd(),
				);
				return {
					extensions: extensions.map(({ raw: _raw, ...rest }) => rest),
					tabs,
					providers,
					components,
					toolViews,
					statusBarSegments,
					// Desktop-shell config (dsh-desktop parity): enabled/mode/
					// webUrl read by the compat page + GUI shell.
					shell: shellCfg,
					// 槽位契约单一权威(collab-proto):GUI 据此诊断未挂载槽位。
					slots: {
						exact: [...EXTENSION_SLOT_DECLARATION.exact],
						prefixes: [...EXTENSION_SLOT_DECLARATION.prefixes],
					},
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
				// center agree (issue #3827). The builtin style extension
				// (task-card-swarm) maps to display.taskCardStyle instead —
				// the setting IS the source of truth for render style.
				const p = (params ?? {}) as { id: string; enabled: boolean; mode?: string };
				let settings = this.#host.settings();
				if (!settings) {
					await this.#host.ensureRegistry();
					settings = this.#host.settings();
				}
				if (!settings) throw new Error("settings unavailable");
				if (p.id === "style:task-card-swarm") {
					// Extension-owned key (registered by the task-card style
					// extension — not in the static SettingPath union).
					settings.set(
						"display.taskCardStyle" as Parameters<Settings["set"]>[0],
						(p.enabled ? "swarm" : "classic") as never,
					);
					await settings.flush();
					this.#extensionsCache = null;
					this.#broadcastExtensionsChanged();
					return { ok: true };
				}
				if (p.id === "desktop-shell:shell") {
					// Desktop shell toggle: enabled -> the GUI shell loads the
					// runtime-served renderer; disabled -> local bundle. The
					// setting drives the extension's mirrored state, and the
					// web.port discovery file is written/deleted so the shell
					// sees the change without an RPC round-trip. An optional
					// `mode` param (compatibility/extended/enhanced) switches
					// the shell mode atomically.
					if (typeof p.mode === "string") {
						const mode: string = p.mode;
						if (mode !== "compatibility" && mode !== "extended" && mode !== "enhanced") {
							throw new Error(`invalid shell mode: ${mode}`);
						}
						settings.set("shell.mode" as Parameters<Settings["set"]>[0], mode as never);
					}
					settings.set("shell.enabled" as Parameters<Settings["set"]>[0], p.enabled as never);
					await settings.flush();
					const webPortFile = path.join(path.dirname(this.#socketPath || DEFAULT_SOCKET), "web.port");
					if (p.enabled && this.#webUrl) {
						const port = new URL(this.#webUrl).port;
						if (port) {
							try {
								await fs.promises.writeFile(webPortFile, port, "utf8");
							} catch {
								// non-fatal
							}
						}
					} else {
						try {
							await fs.promises.unlink(webPortFile);
						} catch {
							// already gone
						}
					}
					this.#extensionsCache = null;
					this.#broadcastExtensionsChanged();
					return { ok: true };
				}
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
				this.#broadcastExtensionsChanged();
				return { ok: true };
			}
			case "extensions.setForceEnabled": {
				// omp 生态智能兼容:显式启用同名冲突项(默认被高优先级 shadow)。
				// 与 disabledExtensions 正交 —— 写入 forceEnabledExtensions;
				// 感知层(agent/用户)分析 shadowedBy 详情后决定启用。
				const p = (params ?? {}) as { id: string; enabled: boolean };
				let settings = this.#host.settings();
				if (!settings) {
					await this.#host.ensureRegistry();
					settings = this.#host.settings();
				}
				if (!settings) throw new Error("settings unavailable");
				const force = [...((settings.getRaw("forceEnabledExtensions") ?? []) as string[])];
				const i = force.indexOf(p.id);
				if (p.enabled && i < 0) force.push(p.id);
				if (!p.enabled && i >= 0) force.splice(i, 1);
				settings.set("forceEnabledExtensions" as Parameters<Settings["set"]>[0], force as never);
				await settings.flush();
				this.#extensionsCache = null;
				this.#pluginsCache = null;
				this.#broadcastExtensionsChanged();
				return { ok: true };
			}
			case "events.subscribe": {
				// Global (non-session) daemon events: extensions.changed
				// (HMR — extension source/config edits invalidate caches and
				// the renderer refreshes slots/panels immediately instead of
				// waiting for the next poll).
				this.#globalEventTargets.add(conn);
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
				this.#broadcastExtensionsChanged();
				return { ok: true };
			}
			case "ext.call": {
				// 扩展贡献的 daemon 侧 JSON-RPC(registerRpc):GUI 槽位组件
				// 经此回调自己的 daemon 侧逻辑。仅限 active extension-module
				// 条目 —— 与
				// collectSlotComponents 同源过滤,未知扩展/方法抛 JSON-RPC
				// 错误给调用方。
				const p = (params ?? {}) as { extensionId?: string; method?: string; params?: unknown; sessionId?: string };
				if (typeof p.extensionId !== "string" || p.extensionId.length === 0) {
					throw new Error("ext.call: extensionId required");
				}
				if (typeof p.method !== "string" || p.method.length === 0) {
					throw new Error("ext.call: method required");
				}
				const extensions = await this.#getExtensions();
				const entry = extensions.find(
					e => e.kind === "extension-module" && e.state === "active" && e.path === p.extensionId,
				);
				if (!entry) throw new Error(`extension not active: ${p.extensionId}`);
				const { invokeExtensionRpc } = await import("./extension-artifact-compiler");
				return await invokeExtensionRpc(entry.path, this.#host.cwd(), p.method, p.params ?? {}, {
					cwd: this.#host.cwd(),
					sessionId: p.sessionId,
				});
			}
			case "modes.list": {
				// 预设中心数据源(docs/modes-plan.md §7):摘要列表,含继承链与
				// 结构信息;扩展 id 存在性校验在 save/validate 层做。
				const { listModeIds, loadModeFile, ensureModeTemplates, BUILTIN_MODE_TEMPLATES } = await import(
					"../presets/resolve"
				);
				const { t } = await import("../i18n/index.js");
				const dir = this.#modesDir();
				ensureModeTemplates(dir);
				const ids = listModeIds(dir);
				const modes: Array<{
					id: string;
					builtin: boolean;
					label?: string;
					description?: string;
					extends: string[];
					extensions?: string[];
					hasPrompt: boolean;
					promptComplete: boolean;
					settingsKeys: string[];
					source?: "extension";
				}> = ids.map(id => {
					const def = loadModeFile(dir, id);
					// 内置模板(work/chat/design/creator)显示名走 i18n(BUILT_IN_PRESET_KEYS
					// 对齐);用户自定义用文件 label。
					const builtinName = t(`preset ${id} name` as never);
					const builtinDesc = t(`preset ${id} description` as never);
					const isBuiltinLabel = !builtinName.startsWith("preset ");
					return {
						id,
						builtin: id in BUILTIN_MODE_TEMPLATES,
						label: isBuiltinLabel ? builtinName : (def?.label ?? id),
						description: isBuiltinLabel ? builtinDesc : def?.description,
						extends: def?.extends ?? [],
						extensions: def?.extensions,
						hasPrompt: (def?.prompt?.length ?? 0) > 0,
						promptComplete: def?.promptComplete === true,
						settingsKeys: Object.keys(def?.settings ?? {}),
					};
				});
				// Modes v2 §5.5:扩展声明预设(registerMode)合并进列表 ——
				// 文件 id 冲突时文件优先(用户数据层压扩展代码层),与
				// resolve 的 extraModes 兜底同一优先级规则。
				const { collectExtensionModes } = await import("./extension-artifact-compiler");
				const fileIds = new Set(ids);
				for (const em of await collectExtensionModes(await this.#getExtensions(), this.#host.cwd())) {
					if (fileIds.has(em.id)) continue;
					fileIds.add(em.id);
					modes.push(em);
				}
				return { modes, modesDir: dir };
			}
			case "modes.get": {
				// 单预设完整定义(设置页编辑器用):modes.list 是摘要,编辑页
				// 按需拉完整(含 prompt 区块数组/settings 覆盖)。
				const { loadModeFile, ensureModeTemplates } = await import("../presets/resolve");
				const p = (params ?? {}) as { id: string };
				const dir = this.#modesDir();
				ensureModeTemplates(dir);
				const def = loadModeFile(dir, p.id);
				if (!def) throw new Error(`Unknown mode: ${p.id}`);
				return def;
			}
			case "modes.save": {
				// 保存 = 校验(结构 + 环/悬空 + 扩展存在性)→ 写文件 → 广播。
				const {
					loadModeFile,
					resolveMode,
					validateMode,
					MODE_ID_PATTERN,
					modeFilePath,
					ensureModeTemplates,
					BUILTIN_MODE_TEMPLATES,
				} = await import("../presets/resolve");
				const p = (params ?? {}) as {
					id: string;
					label?: string;
					description?: string;
					extends?: string[];
					extensions?: string[];
					prompt?: unknown[];
					promptComplete?: boolean;
					runtimeContext?: boolean;
					settings?: Record<string, unknown>;
				};
				if (!MODE_ID_PATTERN.test(p.id)) throw new Error(`invalid mode id: ${p.id}`);
				// 内置预设(work/chat/design/creator)不可被保存覆盖(
				// system preset 对齐:shipped 预设属于部署,authoring 拒绝写)。
				// 与 modes.delete 同一 guard;手改磁盘文件仍允许(文件级自由)。
				if (p.id in BUILTIN_MODE_TEMPLATES) {
					throw new Error(`built-in preset "${p.id}" cannot be overwritten — copy it to a new id instead`);
				}
				const dir = this.#modesDir();
				ensureModeTemplates(dir);
				const knownExtensions = (await this.#getExtensions()).map(e => e.id);
				const def = {
					id: p.id,
					label: p.label,
					description: p.description,
					extends: p.extends,
					extensions: p.extensions,
					prompt: p.prompt as never,
					promptComplete: p.promptComplete,
					runtimeContext: p.runtimeContext,
					settings: p.settings,
				};
				const errors = validateMode(def as never, { knownExtensions });
				if (errors.length > 0) throw new Error(`mode validation failed:\n${errors.join("\n")}`);
				// 环/悬空引用经 resolveMode 验证(knownExtensions 同样参与)。
				// 新建时文件尚不存在 —— 顶层 id 用内存 def(否则 load 命中
				// undefined 报"未定义的预设"),继承链其余 id 仍走文件。
				resolveMode(p.id, mid => (mid === p.id ? (def as never) : loadModeFile(dir, mid)), {
					knownExtensions,
				});
				const file = modeFilePath(dir, p.id);
				fs.writeFileSync(file, `${JSON.stringify(def, null, 2)}\n`, "utf8");
				this.#broadcastModesChanged();
				return { ok: true };
			}
			case "modes.delete": {
				const { listModeIds, loadModeFile, modeFilePath, MODE_ID_PATTERN, BUILTIN_MODE_TEMPLATES } = await import(
					"../presets/resolve"
				);
				const p = (params ?? {}) as { id: string };
				if (!MODE_ID_PATTERN.test(p.id)) throw new Error(`invalid mode id: ${p.id}`);
				// 内置预设(work/chat/design/creator)不可删。
				if (p.id in BUILTIN_MODE_TEMPLATES) throw new Error(`built-in preset "${p.id}" cannot be deleted`);
				const dir = this.#modesDir();
				const referencing = listModeIds(dir).filter(
					other => other !== p.id && (loadModeFile(dir, other)?.extends ?? []).includes(p.id),
				);
				if (referencing.length > 0) {
					throw new Error(`mode "${p.id}" is referenced by: ${referencing.join(", ")}`);
				}
				try {
					fs.rmSync(modeFilePath(dir, p.id));
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				this.#broadcastModesChanged();
				return { ok: true };
			}
			case "modes.validate": {
				const { loadModeFile, resolveMode, validateMode, MODE_ID_PATTERN } = await import("../presets/resolve");
				const p = (params ?? {}) as { id: string };
				if (!MODE_ID_PATTERN.test(p.id)) return { valid: false, errors: [`invalid mode id: ${p.id}`] };
				const dir = this.#modesDir();
				const knownExtensions = (await this.#getExtensions()).map(e => e.id);
				const errors: string[] = [];
				try {
					const def = loadModeFile(dir, p.id);
					if (!def) errors.push(`mode "${p.id}" not found`);
					else {
						errors.push(...validateMode(def as never, { knownExtensions }));
						resolveMode(p.id, mid => loadModeFile(dir, mid), { knownExtensions });
						// P0-② 挂载校验:白名单扩展
						// 实际加载 + 槽位组件编译。不建会话(standingKeyFor 即
						// "真实挂载但不建 agent")。
						await this.#validateModeMounting(def as never, errors);
					}
				} catch (error) {
					errors.push(String((error as Error).message));
				}
				return errors.length > 0 ? { valid: false, errors } : { valid: true };
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
			case "widget.data": {
				// Daemon-side data-source proxy (docs/board-dashboard.md §4
				// 数据源代理): widgets never fetch the network directly — the
				// daemon fetches each feed once per TTL and caches it
				// in-process. First feed: FX rates (open.er-api.com, base CNY).
				// Returns normalized { rates, base, updatedAt } or a typed
				// { error } (soft error — mirrors the git.*/notes.* result
				// error convention rather than throwing into JSON-RPC).
				const p = (params ?? {}) as { feed?: unknown; base?: unknown };
				const feed = typeof p.feed === "string" ? p.feed : "";
				if (feed !== "fx-rates") return { error: `widget.data: unknown feed "${feed}"` };
				const base =
					typeof p.base === "string" && /^[A-Za-z]{3}$/.test(p.base) ? p.base.toUpperCase() : "CNY";
				const rates = await getFxRates(base);
				if (rates === null) return { error: "widget.data: FX feed unavailable" };
				return { rates, base, updatedAt: Date.now() };
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
					windowsHide: true,
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
					const proc = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe", windowsHide: true, });
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
						windowsHide: true,
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
				const proc = Bun.spawn({ cmd: ["git", "add", "--", ...paths], cwd, stdout: "pipe", stderr: "pipe", windowsHide: true, });
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
					windowsHide: true,
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
						windowsHide: true,
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
					windowsHide: true,
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
					windowsHide: true,
				});
				const list = Bun.spawnSync({
					cmd: ["git", "for-each-ref", "refs/heads", "--format=%(refname:short)"],
					cwd,
					stdout: "pipe",
					stderr: "pipe",
					windowsHide: true,
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
					windowsHide: true,
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
					windowsHide: true,
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
					const proc = Bun.spawn({ cmd: [gh, ...args], stdout: "pipe", stderr: "pipe", env, windowsHide: true, });
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
						windowsHide: true,
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
					windowsHide: true,
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
			case "session.history": {
				// Bounded paging over the materialized entries
				// (session.history parity): the GUI folds a long session's
				// oldest region into a marker and pages it back in with this
				// cursor. beforeId = the oldest entry the client still holds;
				// returns up to maxMessages entries BEFORE it (oldest→newest)
				// plus how many older entries remain — nothing is ever
				// dropped, the fold is purely a client-side window.
				const p = (params ?? {}) as { sessionId: string; beforeId?: string; maxMessages?: number };
				const max = Math.min(Math.max(Number.isFinite(p.maxMessages) ? (p.maxMessages ?? 500) : 500, 1), 1000);
				const snap = (await this.#host.snapshot(p.sessionId)) as { entries?: unknown[] } | null;
				const entries = Array.isArray(snap?.entries) ? snap.entries : [];
				let start = entries.length;
				if (p.beforeId) {
					const idx = entries.findIndex(e => (e as { id?: unknown } | null)?.id === p.beforeId);
					if (idx !== -1) start = idx;
				}
				const from = Math.max(0, start - max);
				return {
					entries: entries.slice(from, start),
					hasMore: from > 0,
					remaining: from,
				};
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
				return {
					stream: live ? conn.id : null,
					snapshot: tailSnapshot(snapshot),
					compactedThrough: compacted,
				};
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
				// Idle-closed sessions lose their subscribers when the daemon
				// drops the live entry. Re-subscribe this connection before the
				// agent turn starts so the resulting events reach the GUI; a
				// reactivated session has no in-flight events, so there is no
				// catch-up gap to fill here.
				await this.#host.subscribe(p.sessionId, conn);
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
				// Fire-and-forget: prompt()'s promise only settles at end-of-turn
				// (minutes for a long run), while the GUI client enforces a hard
				// 15s RPC timeout — awaiting the turn here always surfaced a false
				// "request timeout: session.send" banner while the agent kept
				// working. Turn progress and errors already flow to clients via
				// the session event stream; log background failures instead.
				void live.agentSession.sendUserMessage(content, options).catch(err => {
					logger.warn("session.send background delivery failed", {
						sessionId: p.sessionId,
						error: err instanceof Error ? err.message : String(err),
					});
				});
				return { accepted: true };
			}
			case "session.branchAt": {
				// Non-destructive branch (TUI navigateTree /tree parity): move
				// the session's leaf IN PLACE — the target node stays on the
				// current branch, so the old leaf and its subtree remain
				// reachable as a sibling branch. User messages re-answer (leaf
				// = parent, text backfilled for the composer); assistant/tool
				// nodes land the leaf on the node to continue from there.
				// Never truncates, and unlike forkAt never creates a new
				// session file — it's the same session tree with a new leaf
				// position.
				const bp = (params ?? {}) as { sessionId: string; messageId: string };
				if (!bp.messageId) throw new Error("messageId required");
				const blive = this.#host.get(bp.sessionId);
				if (!blive) throw new Error("branchAt requires a live session");
				// Resolve the view key ("role:timestamp") to the SDK entry id
				// (same message-key matching as forkAt).
				const bentries = (
					blive.agentSession as unknown as {
						sessionManager: { getEntries(): SessionEntry[] };
					}
				).sessionManager.getEntries();
				const bviewKey = bp.messageId;
				let bsdkId = bentries.find(e => e.id === bviewKey)?.id;
				if (!bsdkId) {
					const bsep = bviewKey.indexOf(":");
					if (bsep > 0) {
						const brole = bviewKey.slice(0, bsep);
						const bkey = bviewKey.slice(bsep + 1);
						const bhit = bentries.find(e => {
							if (e.type !== "message") return false;
							const m = e.message as { role?: string; timestamp?: number | string; toolCallId?: string };
							if (m.role !== brole) return false;
							return brole === "toolResult" ? m.toolCallId === bkey : String(m.timestamp) === bkey;
						});
						bsdkId = bhit?.id;
					}
				}
				if (!bsdkId) throw new Error(`Unknown message: ${bp.messageId}`);
				const bresult = await (
					blive.agentSession as unknown as {
						navigateTree(
							id: string,
							opts?: Record<string, unknown>,
						): Promise<{ cancelled?: boolean; editorText?: string; editorImages?: unknown[] }>;
					}
				).navigateTree(bsdkId, {});
				if (bresult.cancelled) return { ok: false };
				const bsm = blive.agentSession.sessionManager as unknown as {
					getLeafEntry(): { message: WireMessage } | undefined;
				};
				const bleafEntry = bsm.getLeafEntry();
				const bleafKey =
					bleafEntry ? messageKey(bleafEntry.message as WireMessage) : null;
				return {
					ok: true,
					leafId: bleafKey,
					editorText: bresult.editorText ?? null,
					editorImages: bresult.editorImages ?? [],
				};
			}
			case "session.btwBranch": {
				// GUI /btw promote (TUI branchFromBtw parity — openchamber
				// BtwPanel promote parity): an ephemeral side-question answer
				// becomes its own BRANCHED session. The daemon mirrors the
				// current live session into a new session file and appends the
				// question + answer as its first user/assistant pair; the
				// original session is untouched. Session maintenance guards
				// (streaming/bash/compact) live inside branchFromBtw.
				const bp = (params ?? {}) as { sessionId: string; question: string; replyText: string };
				if (!bp.question) throw new Error("question required");
				const blive = this.#host.get(bp.sessionId);
				if (!blive) throw new Error("btwBranch requires a live session");
				const bsm = (blive.agentSession as unknown as {
					sessionManager: { getLeafId(): string | null };
				}).sessionManager;
				const leafId = bsm.getLeafId();
				if (!leafId) throw new Error("btwBranch requires a branchable leaf");
				// Reconstruct the minimum AssistantMessage the boundary op
				// re-parents into the new session (same shape the TUI passes:
				// a text-only assistant reply).
				const assistantMessage = {
					id: `btw-${Date.now()}`,
					role: "assistant",
					content: [{ type: "text", text: bp.replyText }],
				} as unknown as import("@musepi/pi-ai").AssistantMessage;
				const bresult = await (
					blive.agentSession as unknown as {
						branchFromBtw(
							question: string,
							assistantMessage: import("@musepi/pi-ai").AssistantMessage,
							leafId: string,
							sessionId: string,
						): Promise<{ cancelled: boolean; sessionFile: string | undefined }>;
					}
				).branchFromBtw(bp.question, assistantMessage, leafId, bp.sessionId);
				if (bresult.cancelled) return { ok: false };
				// createBranchedSession REPLACES the live session's id (new
				// sessionFile + new id — TUI parity: the current view IS the new
				// session). Rekey the host entry so later RPCs under the new id
				// resolve; the GUI navigates to it (same as forkAt).
				const bnewId = (blive.agentSession as unknown as {
					sessionManager: { getSessionId(): string };
				}).sessionManager.getSessionId();
				if (bnewId && bnewId !== bp.sessionId) {
					this.#host.rekeySession(bp.sessionId, bnewId);
				}
				return { ok: true, sessionId: bnewId ?? null, sessionFile: bresult.sessionFile ?? null };
			}
			case "session.forkAt": {
				// Non-destructive fork (GUI 分叉): copy the parent session's
				// transcript truncated at the target message into a new
				// session file (new id, parentSession header). The parent is
				// untouched. Works for live and history sessions.
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
				// The SDK file is `[title slot]` + `[session header]` + entries.
				// The title slot (type "title") holds the display title; it is
				// NOT the session header. DO NOT assume lines[0] is the header —
				// a stale parse produced forks whose header was type "title" and
				// whose body still contained the parent's header, so
				// loadSessionFile picked the parent's id and activation threw
				// `Unknown session` (fork send was unusable). Scan for the
				// actual session record (type "session", string id).
				let headerIdx = -1;
				let header: Record<string, unknown> = {};
				for (let i = 0; i < Math.min(lines.length, 8); i++) {
					const line = lines[i];
					if (!line?.trim()) continue;
					try {
						const rec = JSON.parse(line) as { type?: unknown; id?: unknown };
						if (rec.type === "session" && typeof rec.id === "string") {
							headerIdx = i;
							header = rec as Record<string, unknown>;
							break;
						}
					} catch {
						// malformed early line — skip
					}
				}
				if (headerIdx < 0) throw new Error(`Unreadable session file: ${file}`);
				// Title slot lines (before the header) are preserved so the
				// fork keeps the parent's display title in the session list.
				const titleSlot = lines.slice(0, headerIdx).join("\n");
				let keep = 0;
				let found = false;
				for (let i = headerIdx + 1; i < lines.length; i++) {
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
				// Body = entries after the header, up to and including the
				// target message (or before it, per includeTarget).
				// Exclude the header line itself — it was already copied into
				// the new file's header, and including it would make
				// loadSessionFile find the parent's id as the fork's header.
				const body = lines
					.slice(headerIdx + 1, keep + 1)
					.filter(l => l?.trim())
					.join("\n");
				const head = titleSlot ? titleSlot + "\n" : "";
				await fs.promises.writeFile(newFile, `${head}${JSON.stringify(newHeader)}\n${body}${body ? "\n" : ""}`);
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
				const p = (params ?? {}) as { sessionId?: string; mode?: "session" | "workspace" | "tunnel" };
				const mode = p.mode === "workspace" ? "workspace" : p.mode === "tunnel" ? "tunnel" : "session";
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
						// dsh-mobile-remote parity: remote guests manage the
						// workspace (new/delete/rename sessions) over the
						// collab RPC — write-token gated in the host.
						createWorkspaceSession: async () => {
							// New sessions land in the focused session's cwd,
							// else the first workspace session's, else the
							// daemon's own default.
							const cwd =
								focus?.agentSession?.sessionManager?.getCwd() ??
								(await this.#host.listWorkspaceSessions()).find(s => s.cwd)?.cwd ??
								undefined;
							const created = await this.#host.createSession({ cwd });
							return created.sessionId;
						},
						deleteWorkspaceSession: async (sessionId: string) => {
							await this.#host.deleteSession(sessionId);
						},
						renameWorkspaceSession: async (sessionId: string, title: string) => {
							const live = this.#host.get(sessionId) ?? (await this.#host.activate(sessionId).catch(() => null));
							if (!live) {
								throw new Error(`Cannot rename session ${sessionId} (not resumable)`);
							}
							await live.agentSession.sessionManager.setSessionName(title, "user");
						},
						abortWorkspaceSession: async (sessionId: string) => {
							const live = this.#host.get(sessionId) ?? (await this.#host.activate(sessionId).catch(() => null));
							if (!live) {
								throw new Error(`Cannot abort session ${sessionId} (not resumable)`);
							}
							await live.agentSession.abort({ reason: "user interrupt" });
						},
					},
				};
				const transport = new LocalShareManager({ port: undefined, onStatus: () => {} });
				// Tunnel mode with no sessionId shares the workspace (like
				// workspace mode); with a sessionId it shares that session.
				const collabMode: "session" | "workspace" =
					mode === "workspace" || (mode === "tunnel" && !p.sessionId) ? "workspace" : "session";
				const collabHost = new CollabHost(stubCtx as never, collabMode);
				// Tunnel shares the same loopback relay as the desktop-web dist;
				// the public URL is https/wss-same-origin, so webUrl for the
				// browser deep link is the tunnel URL itself.
				const urls = mode === "tunnel" ? await transport.startTunnel() : await transport.startLan();
				await collabHost.start(urls.joinUrl, mode === "tunnel" ? urls.joinUrl : urls.webUrl, urls.webJoinUrl);
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
				this.#pairCodes.clear();
				if (this.#pairWs) {
					await this.#pairWs.close().catch(() => {});
					this.#pairWs = null;
				}
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
			case "collab.pair.generate": {
				// 6-digit pair code for the mobile app. The GUI shows it next
				// to the QR; the app resolves it against the LAN pair endpoint
				// (pair.resolve) to fetch the full collab link.
				if (!this.#collab) throw new Error("start sharing first (collab.start)");
				const webLink = this.#collab.host.webLink;
				if (!webLink) throw new Error("no collab link yet — refresh the share");
				this.#prunePairCodes();
				let code = "";
				do {
					code = String(Math.floor(100000 + Math.random() * 900000));
				} while (this.#pairCodes.has(code));
				const expiresAt = Date.now() + PAIR_CODE_TTL_MS;
				this.#pairCodes.set(code, { webLink, expiresAt });
				await this.#ensurePairServer();
				return { code, expiresInSeconds: PAIR_CODE_TTL_MS / 1000, lanPort: PAIR_PORT };
			}
			case "channels.list": {
				return this.#channels.list();
			}
			case "channels.configure": {
				const p = (params ?? {}) as { kind: string; config?: Record<string, unknown> };
				this.#channels.configure(p.kind as ChannelKind, p.config ?? {});
				return { ok: true };
			}
			case "channels.start": {
				const p = (params ?? {}) as { kind: string };
				return this.#channels.start(p.kind as ChannelKind);
			}
			case "channels.stop": {
				const p = (params ?? {}) as { kind: string };
				return this.#channels.stop(p.kind as ChannelKind);
			}
			case "channels.plugins": {
				return BUILTIN_PLUGINS.map(p => ({ ...p, registered: true })).concat(
					(await loadChannelPlugins(this.#channelPluginDir)).map(({ plugin, origin }) => ({
						kind: plugin.kind,
						label: plugin.label,
						description: plugin.description,
						origin,
						registered: this.#channels.kinds().includes(plugin.kind),
					})),
				);
			}
			case "channels.reloadPlugins": {
				// Hot-plug: rescan the plugin directory; new files register,
				// removed files unregister (running adapters stop first).
				await this.#loadChannelPlugins();
				return { ok: true };
			}
			case "import.agents": {
				// List importable agent sources without touching their session
				// stores (import.agents → pick agent → import.sources scan →
				// import.session). The picker must be able to render the agent
				// list without scanning anything on entry.
				return foreignSessionSources().map(source => ({
					source,
					name: foreignSessionSourceName(source),
				}));
			}
			case "import.sources": {
				// Enumerate foreign agent sessions with a bounded listing
				// (import.agents → pick agent → import.sources scan →
				// import.session). Only the requested sources are scanned —
				// the UI scans on explicit button click, not on entry.
				const p = (params ?? {}) as { sources?: string[] };
				const all = foreignSessionSources();
				const want: ForeignSessionSource[] =
					Array.isArray(p.sources) && p.sources.length > 0 ? (p.sources as ForeignSessionSource[]) : all;
				for (const source of want) {
					if (!all.includes(source)) throw new Error(`unknown import source: ${source}`);
				}
				const sources = await Promise.all(
					want.map(async source => {
						let sessions: ForeignSessionInfo[] = [];
						try {
							const store = createForeignSessionStore(source);
							sessions = (await store.list()).slice(0, 100);
						} catch {
							sessions = [];
						}
						return {
							source,
							name: foreignSessionSourceName(source),
							count: sessions.length,
							sessions: sessions.map(s => ({
								id: s.id,
								title: s.title ?? "",
								cwd: s.cwd,
								created: s.created.toISOString(),
								modified: s.modified.toISOString(),
								messageCount: s.messageCount ?? 0,
								firstMessage: s.firstMessage ?? "",
							})),
						};
					}),
				);
				return sources.filter(s => s.count > 0);
			}
			case "import.session": {
				const p = (params ?? {}) as { source: string; id: string; cwd?: string };
				const source = p.source as ForeignSessionSource;
				if (!foreignSessionSources().includes(source)) throw new Error(`unknown import source: ${source}`);
				const store = createForeignSessionStore(source);
				const sessions = await store.list();
				const match = sessions.find(s => s.id === p.id) ?? sessions.find(s => s.path === p.id);
				if (!match) throw new Error(`session not found in ${source}: ${p.id}`);
				const imported = await persistForeignSession(store, match, {
					fallbackCwd: p.cwd ?? this.#host.cwd() ?? undefined,
					suppressBreadcrumb: true,
				});
				const sessionFile = imported.getSessionFile();
				await imported.close();
				if (!sessionFile) throw new Error("failed to persist imported session");
				return { ok: true, sessionFile, source, sourceId: match.id };
			}
			case "migrate.dirs": {
				// Data-migration tab: surface the directories a backup must cover.
				return { agentDir: getAgentDir(), daemonDir: SOCKET_DIR };
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
				return { ok: true };
			}
			case "session.abort": {
				// TUI Esc parity: stop the running agent turn in a live
				// session. Desktop GUI Composer stop calls this.
				const p = (params ?? {}) as { sessionId: string };
				const live = this.#host.get(p.sessionId) ?? (await this.#host.activate(p.sessionId).catch(() => null));
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				await live.agentSession.abort({ reason: "user interrupt" });
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
					// Same bare id can be served by several providers (opencode-go
					// vs opencode-zen both offering deepseek-v4-flash) — the
					// provider qualifier picks the exact one. The resolver is
					// case-insensitive and handles alias/variant forms; it returns
					// undefined on no match, so a stale provider throws below
					// instead of silently landing on another provider's model.
					const models = live.agentSession.getAvailableModels();
					const model = p.model.provider
						? resolveProviderModelReference(p.model.provider, p.model.id, models)
						: models.find(m => m.id === p.model.id);
					if (!model) throw new Error(`Unknown model: ${p.model.id}`);
					// Pure generation endpoints (agnes-image-*, gpt-image-*, dall-e,
					// flux, / agnes-video-*, veo, sora, …) respond to
					// /v1/images/generations or /v1/videos, not the chat/messages
					// loop — selecting one as the session model just yields a 400
					// ("… is an image model. Use /v1/images/generations."). Reject
					// here so a non-GUI caller can't bypass the selector filter.
					// Multimodal *understanding* models (vision/video input) must
					// still pass: those set image/video flags, not imageGen/videoGen.
					const caps = resolveModelCapabilities(model.id, model.input);
					if (caps.imageGen || caps.videoGen) {
						throw new Error(
							`Model ${model.id} is a ${caps.imageGen ? "image" : "video"} generation endpoint, not a chat model`,
						);
					}
					await live.agentSession.setModelTemporary(model);
					return { ok: true };
				}
				// History session: persist the choice on the snapshot header — it
				// applies when the session is next continued (resume picks it up).
				// Provider qualifier must win: opencode-go and b-ai both serve
				// "deepseek-v4-flash-vision-exp", so a bare-id find would persist
				// whichever provider lists first and the resumed session would
				// silently switch providers. Only fall back to bare id when the
				// caller sent no provider.
				const registry = await this.#host.ensureRegistry();
				const available = registry?.getAvailable() ?? [];
				const model = p.model.provider
					? resolveProviderModelReference(p.model.provider, p.model.id, available)
					: available.find(m => m.id === p.model.id);
				if (!model) throw new Error(`Unknown model: ${p.model.id}`);
				// Same generation-endpoint gate as the live-session branch above
				// (history header persistence must not pin an image/video generator).
				const caps = resolveModelCapabilities(model.id, model.input);
				if (caps.imageGen || caps.videoGen) {
					throw new Error(
						`Model ${model.id} is a ${caps.imageGen ? "image" : "video"} generation endpoint, not a chat model`,
					);
				}
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
			case "session.setMode": {
				// Modes v2(§6.2/§7):会话中热切换预设。live 会话走
				// AgentSession.setMode(忙会话 → deferred,pending 在 agent_end
				// 补做);成功后把 modeId 写进会话头,历史会话直接持久化。
				// modeId: null = 清除预设。
				const p = (params ?? {}) as { sessionId: string; modeId?: string | null };
				const live = this.#host.get(p.sessionId);
				if (live) {
					const result = await live.agentSession.setMode(p.modeId ?? null, { hot: true });
					if (!result.ok) throw new Error(result.error ?? "mode switch failed");
					if (!result.deferred && !this.#host.persistHeaderPatch(p.sessionId, { modeId: p.modeId ?? null })) {
						logger.warn("session.setMode: failed to persist modeId to session header", {
							sessionId: p.sessionId,
						});
					}
					return { ok: true, deferred: result.deferred === true };
				}
				// History session: persist — applies when the session is next continued.
				if (!this.#host.persistHeaderPatch(p.sessionId, { modeId: p.modeId ?? null })) {
					throw new Error(`Unknown session: ${p.sessionId}`);
				}
				return { ok: true, persisted: true };
			}
			case "stt.modelStatus": {
				// GUI voice page: which speech models are already on disk, so
				// the panel can show "ready" vs "needs download" per option.
				// `downloads` lists tiers mid-fetch so a freshly-mounted window
				// renders its progress row immediately, not after the next tick.
				const { isSttModelCached } = await import("../stt/downloader");
				const { STT_MODELS } = await import("../stt/models");
				const models = await Promise.all(
					STT_MODELS.map(async m => ({ key: m.key, label: m.label, cached: await isSttModelCached(m.key) })),
				);
				return { models, downloads: [...this.#sttDownloads.keys()] };
			}
			case "stt.modelDownload": {
				// Kick off a speech-model download WITHOUT awaiting it: the
				// RPC client times out at 15s but Whisper tiers are GB-scale,
				// so the request must return immediately. Progress AND both
				// terminal outcomes (stt.downloadDone / stt.downloadError)
				// ride the global event stream — same channel as
				// extensions.changed — so every open window stays in sync.
				const p = (params ?? {}) as { modelKey?: string };
				if (!p.modelKey) throw new Error("modelKey required");
				const { isSttModelKey } = await import("../stt/models");
				// Reject unknown keys explicitly: resolveSttModelSpec silently
				// falls back to the default tier, which would download a
				// GB-scale model the user never asked for.
				if (!isSttModelKey(p.modelKey)) throw new Error(`unknown speech model: ${p.modelKey}`);
				const modelKey = p.modelKey;
				// Idempotent re-trigger: a second window (or a double-click
				// race) must reuse the running fetch, not start a parallel one
				// into the same cache directory. Reserve the slot SYNCHRONOUSLY
				// so a second RPC racing the dynamic import below can't slip
				// past the guard; it is replaced by the real promise right after.
				if (this.#sttDownloads.has(modelKey)) return { ok: true, alreadyRunning: true };
				this.#sttDownloads.set(modelKey, Promise.resolve());
				try {
					const { downloadSttModel } = await import("../stt/downloader");
					const emitSttEvent = (payload: Record<string, unknown>): void => {
						const seq = ++this.#globalEventSeq;
						for (const conn of this.#globalEventTargets) {
							this.#host.emitEvent(conn, { kind: "event", seq, payload });
						}
					};
					// Exactly one run per key lives in #sttDownloads at a time,
					// so the finally can drop it unconditionally.
					const run = (async (): Promise<void> => {
						try {
							await downloadSttModel(modelKey, progress => {
								emitSttEvent({
									type: "stt.downloadProgress",
									modelKey,
									percent: progress.percent,
									loaded: progress.loaded,
									total: progress.total,
									label: progress.label,
								});
							});
							emitSttEvent({ type: "stt.downloadDone", modelKey });
						} catch (err) {
							emitSttEvent({
								type: "stt.downloadError",
								modelKey,
								message: err instanceof Error ? err.message : String(err),
							});
						} finally {
							this.#sttDownloads.delete(modelKey);
						}
					})();
					this.#sttDownloads.set(modelKey, run);
				} catch (err) {
					// Setup failed (import/dispatch): release the reservation.
					this.#sttDownloads.delete(modelKey);
					throw err;
				}
				return { ok: true };
			}
			case "stt.transcribe": {
				// TUI-parity speech-to-text: same asr-client + local worker
				// (sherpa-ONNX) the TUI uses — not Google's web service.
				const p = (params ?? {}) as { audio: number[]; modelKey?: string; language?: string };
				if (!Array.isArray(p.audio) || p.audio.length === 0) throw new Error("audio required (16kHz mono floats)");
				const { sttClient } = await import("../stt/asr-client");
				const { resolveSttModelSpec } = await import("../stt/models");
				// Default follows the user's config (`stt.modelName`, TUI parity)
				// instead of a hardcoded tier — the GUI mic otherwise silently
				// uses a different model than the settings panel shows.
				const { settings: appSettings } = await import("../config/settings");
				const modelKey = p.modelKey
					? resolveSttModelSpec(p.modelKey).key
					: resolveSttModelSpec(appSettings.get("stt.modelName") as string | undefined).key;
				const text = await sttClient.transcribe(modelKey, Float32Array.from(p.audio), {
					...(p.language ? { language: p.language } : {}),
				});
				return { text };
			}
			case "tts.synthesize": {
				// TUI-parity speech synthesis: Kokoro-82M local model via the
				// same tts-client worker the TUI uses.
				const p = (params ?? {}) as { text: string; modelKey?: string; voice?: string };
				if (!p.text?.trim()) throw new Error("text required");
				const { ttsClient } = await import("../tts/tts-client");
				const { DEFAULT_TTS_LOCAL_MODEL_KEY } = await import("../tts/models");
				// Default follows the user's config (`tts.localModel`, TUI
				// parity) instead of the hardcoded model key.
				const { settings: appSettings } = await import("../config/settings");
				const configured = appSettings.get("tts.localModel") as string | undefined;
				const modelKey = p.modelKey ?? (configured || DEFAULT_TTS_LOCAL_MODEL_KEY);
				const audio = await ttsClient.synthesize(modelKey as never, p.text, {
					...(p.voice ? { voice: p.voice } : {}),
				});
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
			case "agents.transcript": {
				// Desktop parity with the collab host's fetch-transcript frame:
				// incremental read of a subagent's persisted session file, from
				// a byte cursor. Returns { text, newSize, error? } — the GUI
				// trajectory panel polls with the returned cursor (terminal
				// `error` stops polling; `null` on missing file).
				const { AgentRegistry } = await import("../registry/agent-registry");
				const p = (params ?? {}) as { agentId?: unknown; fromByte?: unknown };
				const agentId = typeof p.agentId === "string" ? p.agentId : "";
				const fromByte = typeof p.fromByte === "number" && Number.isFinite(p.fromByte) ? p.fromByte : 0;
				if (!agentId) throw new Error("agents.transcript: missing agentId");
				const file = AgentRegistry.global().get(agentId)?.sessionFile;
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
						// Trim to the last complete JSONL line so no line or
						// UTF-8 char is split mid-read.
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
				const excludeFromContext = p.excludeFromContext === true || p.command.startsWith("!!");
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
					// The level auto RESOLVED to for the current turn (undefined
					// until the daemon classifies; TUI status-line parity — the
					// GUI chip shows "auto" pending, then the concrete effort).
					resolved: live.agentSession.autoResolvedThinkingLevel(),
					// The current model's exact effort ladder (TUI parity: the
					// selector offers off/auto + getSupportedEfforts(model), not
					// a fixed seven-rung ladder).
					efforts: model ? getSupportedEfforts(model as never).map(e => String(e)) : [],
					model: model ? { id: model.id, name: model.name, provider: model.provider } : null,
				};
			}
			case "autoresearch.status": {
				// Desktop adaptation of the TUI autoresearch extension: the
				// experiment dashboard is a TUI widget + overlay — the GUI
				// gets the same data (active session + run history) as an
				// RPC so it can render its own panel. Reads the same SQLite
				// storage the extension writes (per-cwd,
				// ~/.musepi/autoresearch — the storage module is authoritative;
				// OMP_AUTORESEARCH_DB_DIR overrides the base).
				const p = (params ?? {}) as { cwd?: string };
				const arCwd = p.cwd ?? this.#host.cwd();
				try {
					const { openAutoresearchStorageIfExists } = await import("../autoresearch/storage");
					const storage = await openAutoresearchStorageIfExists(arCwd);
					if (!storage) return { active: null, runs: [] };
					// Branch is intentionally null here: matching any active
					// session is the desktop-parity behavior (the TUI resolves
					// the branch from git; the GUI panel shows the branch the
					// storage recorded on the session row).
					const session = storage.getActiveSessionForBranch(null);
					if (!session) return { active: null, runs: [] };
					const runs = storage.listRuns(session.id);
					return {
						active: {
							branch: session.branch,
							goal: session.goal,
							primaryMetric: session.primaryMetric,
							metricUnit: session.metricUnit,
							direction: session.direction,
							preferredCommand: session.preferredCommand,
							currentSegment: session.currentSegment,
							maxIterations: session.maxIterations,
							notes: session.notes,
							createdAt: session.createdAt,
						},
						runs: runs.map(r => ({
							segment: r.segment,
							command: r.command,
							status: r.status ?? null,
							startedAt: r.startedAt,
							durationMs: r.durationMs,
							exitCode: r.exitCode,
							timedOut: r.timedOut,
							metric: r.parsedPrimary,
							metrics: r.parsedMetrics,
						})),
					};
				} catch {
					return { active: null, runs: [] };
				}
			}
			// ── debug.* — TUI /debug selector parity (desktop adaptation) ──
			// The TUI's /debug opens an interactive diagnostics menu (report
			// bundles, logs, system info, profilers, remote inspector, …).
			// The GUI gets the same actions as RPCs and renders its own
			// DebugToolsPanel. Terminal-bound entries (terminal state, protocol
			// probe) have no daemon equivalent and stay GUI-side disabled.
			case "debug.systemInfo": {
				const info = await collectSystemInfo();
				return { text: formatSystemInfo(info) };
			}
			case "debug.logs": {
				return { text: await getLogText() };
			}
			case "debug.workProfile": {
				// Work-scheduling flamegraph (getWorkProfile) — the SVG is
				// returned for inline rendering (TUI writes it to /tmp + opens
				// the browser; the GUI renders the same SVG in the panel).
				const profile = getWorkProfile(30);
				return { svg: profile.svg ?? null, sampleCount: profile.sampleCount };
			}
			case "debug.remoteDebugger": {
				// JavaScriptCore remote inspector — one-way, no stop (TUI parity).
				const existing = getRemoteDebugger();
				const info = existing ?? (await startRemoteDebuggerServer());
				return { host: info.host, port: info.port, alreadyRunning: existing !== null };
			}
			case "debug.cacheStats": {
				const stats = await getArtifactCacheStats(getSessionsDir());
				return {
					count: stats.count,
					totalSize: stats.totalSize,
					oldestDate: stats.oldestDate ? stats.oldestDate.getTime() : null,
				};
			}
			case "debug.clearCache": {
				// Destructive (removes artifacts older than 30 days) — the GUI
				// confirms before calling, mirroring the TUI's hook confirm.
				const result = await clearArtifactCache(getSessionsDir(), 30);
				return { removed: result.removed };
			}
			case "debug.openArtifacts": {
				const p = (params ?? {}) as { sessionId: string; open?: boolean };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				const sessionFile = live.agentSession.sessionFile;
				if (!sessionFile) return { path: null, reason: "no-session-file" };
				// Session file ends in ".jsonl"; the artifacts dir is its stem.
				const artifactsDir = sessionFile.slice(0, -".jsonl".length);
				try {
					const st = await fs.promises.stat(artifactsDir);
					if (!st.isDirectory()) return { path: null, reason: "no-artifacts" };
				} catch {
					return { path: null, reason: "no-artifacts" };
				}
				if (p.open !== false) openPath(artifactsDir);
				return { path: artifactsDir };
			}
			case "debug.dumpReport": {
				const p = (params ?? {}) as { sessionId: string };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				const sessionFile = live.agentSession.sessionFile;
				if (!sessionFile) throw new Error("Session is not persisted");
				const result = await createReportBundle({
					sessionFile,
					settings: this.#debugSessionSettings(live),
					rawSseText: this.#debugRawSseText(live),
				});
				return { path: result.path, files: result.files };
			}
			case "debug.memoryReport": {
				const p = (params ?? {}) as { sessionId: string };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				const sessionFile = live.agentSession.sessionFile;
				if (!sessionFile) throw new Error("Session is not persisted");
				const result = await createReportBundle({
					sessionFile,
					settings: this.#debugSessionSettings(live),
					rawSseText: this.#debugRawSseText(live),
					heapSnapshot: generateHeapSnapshotData(),
				});
				return { path: result.path, files: result.files };
			}
			case "debug.profileStart": {
				const session = await startCpuProfile();
				const id = this.#nextDebugProfilerId++;
				this.#debugProfilers.set(id, session);
				return { profilerId: id };
			}
			case "debug.profileStop": {
				const p = (params ?? {}) as { profilerId: number; sessionId: string };
				const profiler = this.#debugProfilers.get(p.profilerId);
				if (!profiler) throw new Error(`Unknown profiler: ${p.profilerId}`);
				this.#debugProfilers.delete(p.profilerId);
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				const sessionFile = live.agentSession.sessionFile;
				if (!sessionFile) throw new Error("Session is not persisted");
				const cpuProfile: CpuProfile = await profiler.stop();
				const result = await createReportBundle({
					sessionFile,
					settings: this.#debugSessionSettings(live),
					rawSseText: this.#debugRawSseText(live),
					cpuProfile,
					workProfile: getWorkProfile(30),
				});
				return { path: result.path, files: result.files, summary: cpuProfile.markdown };
			}
			case "debug.rawSse": {
				const p = (params ?? {}) as { sessionId: string };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				const buffer = live.agentSession.rawSseDebugBuffer;
				const snapshot = buffer?.snapshot();
				return {
					text: buffer?.toRawText() ?? "",
					totalEvents: snapshot?.totalEvents ?? 0,
					droppedChars: snapshot?.droppedChars ?? 0,
				};
			}
			case "debug.transcript": {
				const p = (params ?? {}) as { sessionId: string; open?: boolean };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				const snap = (await this.#host.snapshot(p.sessionId)) as { entries?: unknown[] } | null;
				const rendered = renderDebugTranscript(snap?.entries ?? []);
				if (!rendered) throw new Error("No messages to dump yet");
				const tmpPath = path.join(
					os.tmpdir(),
					`musepi-debug-transcript-${Date.now()}-${randomUUID().slice(0, 8)}.txt`,
				);
				await fs.promises.writeFile(tmpPath, `${rendered}\n`);
				if (p.open !== false) openPath(tmpPath);
				return { path: tmpPath, chars: rendered.length };
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
				// Full category breakdown (TUI /context panel parity) for the
				// GUI's native /context dialog — the ring only needs the
				// aggregate, but the breakdown is already computed server-side.
				const breakdown =
					live.agentSession.getContextBreakdown({ contextWindow: usage.contextWindow }) ?? undefined;
				const m = live.agentSession.model;
				// Provider-qualified reference ("provider/id"): the model selector
				// highlights by exact row, so a bare id would match the FIRST
				// same-id model (opencode-go vs b-ai deepseek-v4-flash-vision-exp)
				// and the check would light the wrong provider's row.
				const modelRef = m ? (m.provider ? `${m.provider}/${m.id}` : m.id) : undefined;
				// Autocompact buffer + free tokens (TUI /context panel parity):
				// the buffer is the reserve the compaction strategy keeps below
				// the threshold; free is what's left after used + buffer.
				const cw = usage.contextWindow;
				const used = breakdown?.usedTokens ?? usage.tokens;
				let autoCompactBufferTokens = 0;
				let freeTokens = 0;
				if (cw > 0) {
					const comp = live.agentSession.settings.getGroup("compaction") as
						| { enabled?: boolean; strategy?: string }
						| undefined;
					if (comp?.enabled && comp.strategy !== "off") {
						const threshold = resolveThresholdTokens(cw, comp as Parameters<typeof resolveThresholdTokens>[1]);
						autoCompactBufferTokens = Math.max(0, cw - threshold);
					} else if (comp?.enabled) {
						autoCompactBufferTokens = effectiveReserveTokens(
							cw,
							comp as Parameters<typeof effectiveReserveTokens>[1],
						);
					}
					autoCompactBufferTokens = Math.min(autoCompactBufferTokens, Math.max(0, cw - used));
					freeTokens = Math.max(0, cw - used - autoCompactBufferTokens);
				}
				return snapcompact || breakdown || modelRef || autoCompactBufferTokens > 0
					? {
							...usage,
							...(modelRef ? { model: modelRef } : {}),
							...(snapcompact ? { snapcompact } : {}),
							...(breakdown ? { breakdown } : {}),
							autoCompactBufferTokens,
							freeTokens,
						}
					: usage;
			}
			case "session.modes": {
				// Goal / plan mode + todo progress (TUI /goal /plan parity):
				// live AgentSession state exposed for the GUI badges and the
				// todo progress bar.
				const p = (params ?? {}) as { sessionId: string };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				const base = modesOf(live.agentSession);
				// 会话模式开关(TUI /fast /computer /vision /prewalk parity):
				// 只读快照,写入走 session.setFastMode 等。
				const mc = live.agentSession as unknown as {
					isFastModeEnabled?(): boolean;
					isFastModeActive?(): boolean;
					inspectImageState?(): { mode: string; active: boolean; model?: string };
					getPrewalkState?(): { enabled: boolean; target?: { id: string }; thinkingLevel?: string } | undefined;
					getEnabledToolNames?(): string[];
				};
				const computerEnabled =
					(mc.getEnabledToolNames?.() ?? []).includes("computer") ||
					this.#host.settings()?.getRaw("computer.enabled") === true;
				return {
					...base,
					fastModeEnabled: mc.isFastModeEnabled?.() ?? false,
					fastModeActive: mc.isFastModeActive?.() ?? false,
					computerEnabled,
					vision: mc.inspectImageState?.() ?? { mode: "auto", active: false },
					prewalk: mc.getPrewalkState?.() ?? { enabled: false },
				};
			}
			case "session.jobs": {
				// 后台任务 HUD(TUI /jobs parity):AsyncJobSnapshot 结构化输出
				// (running/recent/delivery),GUI 面板轮询渲染。
				const p = (params ?? {}) as { sessionId: string; recentLimit?: number };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				return (
					live.agentSession.getAsyncJobSnapshot({ recentLimit: p.recentLimit ?? 8 }) ?? {
						running: [],
						recent: [],
						// Must match AsyncJobDeliveryState — the GUI reads
						// delivery.pendingJobIds.length, and a missing field here
						// crashes (ErrorBoundary) the jobs pane for sessions
						// without an async job manager.
						delivery: { queued: 0, delivering: false, pendingJobIds: [] },
					}
				);
			}
			case "session.jobsCancel": {
				// 取消一个后台任务(TUI /jobs parity)。
				const p = (params ?? {}) as { sessionId: string; jobId: string };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				const manager = live.agentSession.asyncJobManager;
				if (!manager) throw new Error("async jobs unavailable in this session");
				return { cancelled: manager.cancel(p.jobId) };
			}
			case "session.setFastMode": {
				// TUI /fast parity:优先服务层级开关(持久化 tier.* 设置)。
				const p = (params ?? {}) as { sessionId: string; enabled: boolean };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				const enabled = live.agentSession.setFastMode(p.enabled);
				return {
					enabled,
					active:
						(live.agentSession as unknown as { isFastModeActive?(): boolean }).isFastModeActive?.() ?? enabled,
				};
			}
			case "session.setComputerEnabled": {
				// TUI /computer parity:会话内启用/禁用 computer 工具。
				const p = (params ?? {}) as { sessionId: string; enabled: boolean };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				await live.agentSession.setComputerToolEnabled(p.enabled);
				return { enabled: p.enabled };
			}
			case "computer.capabilities": {
				// macOS 权限检测(屏幕录制/辅助功能/输入):返回 DesktopCapabilities。
				// 不依赖特定会话;native 会话单例懒加载(worker 线程常驻,避免
				// 每次 RPC 新建泄漏线程)。未启动时 listDisplays 触发初始化。
				return await getDesktopCapabilities();
			}
			case "session.setVisionMode": {
				// TUI /vision parity:会话内覆盖 inspect_image 委托模式。
				const p = (params ?? {}) as { sessionId: string; mode: "auto" | "on" | "off" };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				if (!["auto", "on", "off"].includes(p.mode)) throw new Error(`invalid vision mode: ${p.mode}`);
				await live.agentSession.setInspectImageMode(p.mode);
				return live.agentSession.inspectImageState();
			}
			case "session.armPrewalk": {
				// TUI /prewalk parity:武装快速模型预检(下次编辑前)。
				const p = (params ?? {}) as { sessionId: string; model?: string; thinkingLevel?: string };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				const settings = this.#host.settings();
				if (!settings) throw new Error("settings unavailable");
				const { expandRoleAlias, getModelMatchPreferences, resolveCliModel } = await import(
					"../config/model-resolver"
				);
				const rolePattern = expandRoleAlias(p.model ?? "@smol", settings);
				const resolved = resolveCliModel({
					cliModel: rolePattern,
					modelRegistry: live.agentSession.modelRegistry,
					preferences: getModelMatchPreferences(settings),
				});
				if (resolved.error || !resolved.model) {
					throw new Error(resolved.error ?? `Model "${rolePattern}" not found`);
				}
				if (!live.agentSession.modelRegistry.hasConfiguredAuth(resolved.model)) {
					throw new Error(`No API key for ${resolved.model.provider}/${resolved.model.id}`);
				}
				const armed = live.agentSession.armPrewalk(resolved.model, p.thinkingLevel as never);
				return {
					armed,
					model: `${resolved.model.provider}/${resolved.model.id}`,
					prewalk: live.agentSession.getPrewalkState?.() ?? { enabled: armed },
				};
			}
			case "session.advisor": {
				// TUI /advisor status parity:Advisor 运行时统计快照。
				const p = (params ?? {}) as { sessionId: string };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				const a = live.agentSession as unknown as {
					isAdvisorEnabled?(): boolean;
					getAdvisorStats?(): unknown;
					getAdvisorStatusOverview?(): { configured: boolean; advisors: { name: string; status: string }[] };
				};
				return {
					enabled: a.isAdvisorEnabled?.() ?? false,
					stats: a.getAdvisorStats?.() ?? null,
					overview: a.getAdvisorStatusOverview?.() ?? { configured: false, advisors: [] },
				};
			}
			case "session.setAdvisorEnabled": {
				// TUI /advisor on|off parity。
				const p = (params ?? {}) as { sessionId: string; enabled: boolean };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				const a = live.agentSession as unknown as { setAdvisorEnabled?(enabled: boolean): boolean };
				if (!a.setAdvisorEnabled) throw new Error("advisor unavailable in this session");
				return { enabled: a.setAdvisorEnabled(p.enabled) };
			}
			case "memory.status": {
				// TUI /memory status parity:MemoryBackendStatus 结构化输出。
				const settings = this.#host.settings();
				if (!settings) throw new Error("settings unavailable");
				const { resolveMemoryBackend } = await import("../memory-backend/resolve");
				const backend = await resolveMemoryBackend(settings);
				const status = backend.status
					? await backend.status({ agentDir: getAgentDir(), cwd: this.#host.cwd() })
					: { backend: backend.id, active: false, writable: false, searchable: false };
				return { id: backend.id, status };
			}
			case "memory.view": {
				// TUI /memory view parity:developer-instructions markdown。
				const settings = this.#host.settings();
				if (!settings) throw new Error("settings unavailable");
				const { resolveMemoryBackend } = await import("../memory-backend/resolve");
				const backend = await resolveMemoryBackend(settings);
				const text = await backend.buildDeveloperInstructions(getAgentDir(), settings);
				return { text: text ?? "(no instructions)" };
			}
			case "memory.stats": {
				// TUI /memory stats parity:markdown 统计。
				const settings = this.#host.settings();
				if (!settings) throw new Error("settings unavailable");
				const { resolveMemoryBackend } = await import("../memory-backend/resolve");
				const backend = await resolveMemoryBackend(settings);
				return { text: (await backend.stats?.(getAgentDir(), this.#host.cwd())) ?? "(no stats)" };
			}
			case "memory.diagnose": {
				// TUI /memory diagnose parity:markdown 诊断。
				const settings = this.#host.settings();
				if (!settings) throw new Error("settings unavailable");
				const { resolveMemoryBackend } = await import("../memory-backend/resolve");
				const backend = await resolveMemoryBackend(settings);
				return { text: (await backend.diagnose?.(getAgentDir(), this.#host.cwd())) ?? "(no diagnostics)" };
			}
			case "memory.clear": {
				// TUI /memory clear parity:清空后端持久状态。
				const settings = this.#host.settings();
				if (!settings) throw new Error("settings unavailable");
				const { resolveMemoryBackend } = await import("../memory-backend/resolve");
				const backend = await resolveMemoryBackend(settings);
				await backend.clear(getAgentDir(), this.#host.cwd());
				return { ok: true };
			}
			case "memory.enqueue": {
				// TUI /memory enqueue parity:立即强制合并/固化。
				const settings = this.#host.settings();
				if (!settings) throw new Error("settings unavailable");
				const { resolveMemoryBackend } = await import("../memory-backend/resolve");
				const backend = await resolveMemoryBackend(settings);
				await backend.enqueue(getAgentDir(), this.#host.cwd());
				return { ok: true };
			}
			case "session.shake": {
				// TUI /shake parity:剥离工具结果/大块/图片释放上下文。
				const p = (params ?? {}) as { sessionId: string; mode?: "elide" | "images" };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				const mode = p.mode === "images" ? "images" : "elide";
				return await live.agentSession.shake(mode);
			}
			case "session.fresh": {
				// TUI /fresh parity:重置 provider 流状态。
				const p = (params ?? {}) as { sessionId: string };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				return live.agentSession.freshSession() ?? { closedProviderSessions: 0 };
			}
			case "session.resetContext": {
				// TUI /clear parity:原地清空会话上下文(保留会话)。
				const p = (params ?? {}) as { sessionId: string };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				return (await live.agentSession.resetSessionContext()) ?? { droppedCount: 0 };
			}
			case "session.setGoal": {
				// Set or replace the goal with an objective; without one, close
				// an active goal. Opening goal mode without an objective is not
				// supported here — a goal needs a target (the GUI's one-tap
				// "armed" path sends the next message's text as the objective
				// instead of toggling an empty goal).
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
				} else if (current?.enabled) {
					live.agentSession.setGoalModeState?.(undefined);
				}
				return modesOf(live.agentSession);
			}
			case "session.goal": {
				// Full goal lifecycle (TUI /goal parity): show details,
				// pause/resume/drop, budget mutation, and the guided-goal
				// interview (/guided-goal). The GUI exposes these from the
				// goal chip / attach menu instead of the terminal's
				// subcommand + selector menus.
				const p = (params ?? {}) as {
					sessionId: string;
					op: "show" | "pause" | "resume" | "drop" | "budget" | "guided";
					objective?: string | null;
					budget?: string | null;
				};
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				const g = live.agentSession;
				// The goal tool is only active while goal mode is: entering
				// (incl. the guided interview) adds it to the toolset, leaving
				// (pause/drop) restores the pre-goal set.
				const setGoalTools = async (enabled: boolean): Promise<void> => {
					const previous = g.getEnabledToolNames().filter(name => name !== "goal");
					await g.setActiveToolsByName(enabled ? [...new Set([...previous, "goal"])] : previous);
				};
				switch (p.op) {
					case "show": {
						const state = g.getGoalModeState();
						return state?.goal ? { enabled: state.enabled === true, ...state.goal } : null;
					}
					case "pause": {
						if (!g.getGoalModeState()?.enabled) throw new Error("No active goal to pause.");
						await g.goalRuntime.pauseGoal();
						await setGoalTools(false);
						return modesOf(g);
					}
					case "resume": {
						const state = await g.goalRuntime.resumeGoal();
						await setGoalTools(true);
						g.setGoalModeState(state);
						return modesOf(g);
					}
					case "drop": {
						await g.goalRuntime.dropGoal();
						await setGoalTools(false);
						g.setGoalModeState(undefined);
						return modesOf(g);
					}
					case "budget": {
						if (!g.getGoalModeState()?.enabled) throw new Error("No active goal.");
						const trimmed = (p.budget ?? "").trim().toLowerCase();
						let next: number | undefined;
						if (trimmed !== "off") {
							const parsed = Number.parseInt(trimmed, 10);
							if (!Number.isInteger(parsed) || parsed <= 0) {
								throw new Error("Goal budget must be a positive integer or `off`.");
							}
							next = parsed;
						}
						await g.goalRuntime.onBudgetMutated(next);
						return modesOf(g);
					}
					case "guided": {
						// TUI /guided-goal parity: a hidden kickoff starts a
						// normal conversation in which the agent interviews the
						// user, then calls the `goal create` tool to finish.
						if (g.getGoalModeState()?.enabled) {
							throw new Error("Goal mode is already active.");
						}
						const paused = g.getGoalModeState();
						if (paused?.goal?.status === "paused") {
							throw new Error("Resume the current goal first, or drop it before starting a new one.");
						}
						await setGoalTools(true);
						const kickoff = prompt.render(guidedGoalInterviewPrompt, {
							initial: p.objective?.trim() || undefined,
						});
						try {
							if (g.isStreaming) {
								await g.followUp(kickoff, undefined, { synthetic: true });
							} else {
								await g.prompt(kickoff, { synthetic: true });
							}
						} catch (error) {
							// AgentBusyError during the race between the streaming
							// check and prompt(): queue instead of failing.
							if (!(error instanceof AgentBusyError)) throw error;
							await g.followUp(kickoff, undefined, { synthetic: true });
						}
						return { ok: true };
					}
				}
				break;
			}
			case "session.setPlan": {
				// Toggle plan mode (read-only proposal flow, TUI /plan parity).
				const p = (params ?? {}) as { sessionId: string; enabled?: boolean };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				const g = live.agentSession;
				const on = p.enabled ?? !(g.getPlanModeState?.()?.enabled === true);
				if (on) {
					g.setPlanModeState?.({ enabled: true, planFilePath: "" });
					// Install the plan-proposal handler (xd://propose parity):
					// the agent writes the plan file, then submits its title;
					// the handler validates the plan and waits for the GUI's
					// approve/refine (session.plan) — without it the proposal
					// device reports "No plan is awaiting approval" and plan
					// mode strands. Mirrors InteractiveMode/ACP for the parts
					// the agent sees (same PlanApprovalDetails shape).
					const sessionManager = g.sessionManager;
					const cwd = sessionManager.getCwd();
					const localProtocolOptions = {
						artifactsDir: sessionManager.getArtifactsDir(),
						getSessionId: () => sessionManager.getSessionId(),
					};
					g.setPlanProposalHandler(async (title: string) => {
						const state = g.getPlanModeState();
						if (!state?.enabled) throw new ToolError("Plan mode is not active.");
						const { planFilePath, title: resolvedTitle } = await resolveApprovedPlan({
							suppliedTitle: title,
							statePlanFilePath: state.planFilePath,
							readPlan: url => readPlanFile(url, { localProtocolOptions, cwd }),
							listPlanFiles: () => listPlanFiles({ localProtocolOptions }),
						});
						// Promote the reviewed path into plan-mode state so a
						// later approve/refine targets the plan just proposed.
						if (state.planFilePath !== planFilePath) {
							g.setPlanModeState({ ...state, planFilePath });
						}
						return {
							content: [
								{
									type: "text" as const,
									text: `Plan submitted for approval: ${resolvedTitle}. Waiting for the operator to approve or refine it.`,
								},
							],
							details: { planFilePath, title: resolvedTitle, planExists: true },
						};
					});
				} else {
					g.setPlanProposalHandler(null);
					g.setPlanModeState?.(undefined);
				}
				return modesOf(live.agentSession);
			}
			case "session.plan": {
				// Plan review lifecycle (TUI plan-approval overlay parity): show
				// the plan file + title, approve (exit plan mode + dispatch the
				// approved-plan directive), or refine (feed feedback back into
				// the planning conversation). The terminal's in-overlay section
				// edits/annotations are chat-side in the GUI — the plan file is
				// read-only here, and Refine re-prompts the model with the
				// feedback text.
				const p = (params ?? {}) as {
					sessionId: string;
					op: "show" | "approve" | "refine" | "save";
					feedback?: string | null;
					content?: string | null;
					/** TUI "Approve and compact context" parity: distill the
					 *  planning transcript before the approved-prompt dispatch. */
					compact?: boolean;
				};
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				const g = live.agentSession;
				const sessionManager = g.sessionManager;
				const cwd = sessionManager.getCwd();
				const localProtocolOptions = {
					artifactsDir: sessionManager.getArtifactsDir(),
					getSessionId: () => sessionManager.getSessionId(),
				};
				const currentPlanPath = async (): Promise<string | undefined> => {
					const state = g.getPlanModeState();
					if (state?.planFilePath) return state.planFilePath;
					return (await listPlanFiles({ localProtocolOptions }))[0];
				};
				switch (p.op) {
					case "show": {
						const enabled = g.getPlanModeState()?.enabled === true;
						const planFilePath = enabled ? await currentPlanPath() : undefined;
						if (!enabled || !planFilePath) {
							return { enabled, planFilePath: null, content: null, title: null };
						}
						const content = await readPlanFile(planFilePath, { localProtocolOptions, cwd });
						const { title } = resolvePlanTitle({ planContent: content ?? "", planFilePath });
						return { enabled, planFilePath, content, title };
					}
					case "approve": {
						if (!g.getPlanModeState()?.enabled) throw new Error("Plan mode is not active.");
						const planFilePath = await currentPlanPath();
						if (!planFilePath) throw new Error("No plan file to approve.");
						const content = await readPlanFile(planFilePath, { localProtocolOptions, cwd });
						if (content === null) throw new Error(`Plan file not found at ${planFilePath}`);
						const { title } = resolvePlanTitle({ planContent: content, planFilePath });
						g.setPlanProposalHandler(null);
						g.setPlanModeState?.(undefined);
						g.markPlanReferenceSent();
						if (p.compact === true) {
							// Distill the planning conversation first (TUI
							// compactBeforeExecute parity): the approved prompt then
							// lands as a fresh cache anchor on the compacted context.
							await g.compact(undefined, {});
						}
						// Context preserved (the TUI's default is a fresh session;
						// the daemon keeps the planning conversation so the agent
						// still sees its own discussion — the approved prompt
						// declares the plan file authoritative either way).
						const approvePrompt = prompt.render(planModeApprovedPrompt, {
							planFilePath,
							contextPreserved: true,
						});
						if (g.isStreaming) {
							await g.followUp(approvePrompt, undefined, { synthetic: true });
						} else {
							try {
								await g.prompt(approvePrompt, { synthetic: true });
							} catch (error) {
								if (!(error instanceof AgentBusyError)) throw error;
								await g.followUp(approvePrompt, undefined, { synthetic: true });
							}
						}
						return { ok: true, title };
					}
					case "refine": {
						const feedback = p.feedback?.trim();
						if (!feedback) throw new Error("Refine feedback is empty.");
						await g.followUp(feedback, undefined, { synthetic: true });
						return { ok: true };
					}
					case "save": {
						// In-place plan edit (TUI overlay-edit parity): write the
						// edited content back to the current plan file so the
						// approved plan reflects GUI-side changes.
						const content = (p.content ?? "").trim();
						if (!content) throw new Error("Plan content is empty.");
						const planFilePath = await currentPlanPath();
						if (!planFilePath) throw new Error("No plan file to save.");
						await writePlanFile(planFilePath, `${content}\n`, { localProtocolOptions, cwd });
						return { ok: true, planFilePath };
					}
				}
				break;
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
								this.#host.emitEvent(conn, {
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
								this.#host.emitEvent(conn, {
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
								this.#host.emitEvent(conn, {
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
			case "models.discover": {
				// Interrogate one DRAFT endpoint for the models it advertises —
				// the GUI's "fetch available models" button. Nothing is stored:
				// the request carries the endpoint, protocol, and one-shot
				// credential the form currently shows, and the reply is
				// candidates a surface may offer for adoption. Failures are the
				// user's next move (a wrong endpoint, a rejected key, a protocol
				// with no readable listing all end at hand-entry), so they
				// surface as the RPC error message instead of a stored state.
				const p = (params ?? {}) as {
					baseUrl?: string;
					api?: string;
					apiKey?: string;
					provider?: string;
				};
				if (!p.baseUrl || p.baseUrl.length === 0) {
					throw new Error("baseUrl is required to fetch models");
				}
				const { discoverDraftModels } = await import("../config/model-discovery");
				const models = await discoverDraftModels({
					provider: p.provider ?? "custom",
					api: p.api ?? "openai-completions",
					baseUrl: p.baseUrl,
					...(p.apiKey && p.apiKey.length > 0 ? { apiKey: p.apiKey } : {}),
				});
				return { models };
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
				// Extension-contributed settings (registerSetting) are also
				// readable — they're not in SETTINGS_SCHEMA, so hasUi() would
				// otherwise skip them.
				const extKeys = new Set(this.#host.extensionSettings().keys());
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
					if (!legacy && !hasUiMeta && !extKeys.has(key)) continue;
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
					out[key] = extKeys.has(key) ? settings.getRaw(key) : settings.get(key as Parameters<Settings["get"]>[0]);
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
					const resolved: Record<string, { id: string; name: string; efforts: string[] } | null> = {};
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
						// The role model's exact thinking ladder (TUI model-hub
						// parity): the role row's level select offers inherit/off
						// plus these rungs — NOT a fixed seven-rung list, since
						// different models support different efforts.
						resolved[role] = r.model
							? {
									id: r.model.id,
									name: r.model.name,
									efforts: r.model.thinking ? getSupportedEfforts(r.model as never).map(e => String(e)) : [],
								}
							: null;
					}
					out.resolvedRoleModels = resolved;
				}
				if (keys.includes("modelRoleSources")) {
					// openchamber-style provenance echo: which layer actually
					// supplies each role (full merge precedence: runtime →
					// overlay → project → global → default). The GUI badges the
					// role cards' scope toggle with it so a write never lands in
					// an unexpected layer.
					const roleNames = new Set([
						...Object.keys((settings.get("modelRoles") as Record<string, string> | undefined) ?? {}),
						...((out.knownRoleIds as string[] | undefined) ?? []),
					]);
					const sources: Record<string, string> = {};
					for (const role of roleNames) {
						sources[role] = settings.getModelRoleProvenance(role);
					}
					out.modelRoleSources = sources;
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
					[
						"modelRoles",
						"cycleOrder",
						"modelTags",
						"modelProviderOrder",
						"sideChannelModel",
						"busyEnter",
					].includes(p.key) ||
					p.key.startsWith("lsp.") ||
					p.key === "read.toolResultPreview";
				const extKeys = new Set(this.#host.extensionSettings().keys());
				if (
					!legacy &&
					!(p.key in SETTINGS_SCHEMA && hasUi(p.key as Parameters<typeof hasUi>[0])) &&
					!extKeys.has(p.key)
				) {
					throw new Error(`read-only setting: ${p.key}`);
				}
				// Credentials: an empty/absent value keeps the stored one
				// (settings.get never echoes credentials back).
				if (p.key in SETTINGS_SCHEMA && isCredential(p.key as Parameters<typeof isCredential>[0])) {
					if (p.value === "" || p.value === null || p.value === undefined) {
						return { ok: true };
					}
				}
				// Extension-owned keys: honor the extension's write-time guard
				// (ExtensionSetting.validate,
				// analogue) — a refused write surfaces as an RPC error so the
				// GUI/TUI shows the reason instead of persisting bad input.
				if (extKeys.has(p.key)) {
					const error = this.#host.extensionSettings().get(p.key)?.setting.validate?.(p.value);
					if (error) throw new Error(`invalid value for ${p.key}: ${error}`);
				}
				// Scope-aware role writes (TUI model-hub parity): when
				// modelRoleStorage=project, the roles panel can target the
				// project layer (.musepi/config.yml). `modelRoles` honors
				// scope; cycleOrder and everything else stay global (the
				// TUI persists the cycle order globally too).
				const scope = (p as { scope?: "global" | "project" }).scope;
				if (scope === "project" && p.key === "modelRoles") {
					if (!this.#host.cwd()) throw new Error("no project open — project-scope roles need a workspace");
					for (const [role, value] of Object.entries(p.value as Record<string, string>)) {
						settings.setProjectModelRole(role, value);
					}
				} else {
					settings.set(p.key as Parameters<Settings["set"]>[0], p.value as never);
				}
				await settings.flush();
				return { ok: true };
			}
			case "settings.projectOverrides": {
				// Project-override ledger (GUI "项目覆盖" section): every key
				// the current project layer actually owns, with its raw
				// project value, the effective merged value and the global
				// fallback — plus a delete action so one click reverts a key
				// to the inherited layer. Read-only when no workspace is open.
				const p = (params ?? {}) as { action?: "list" | "delete"; path?: string };
				let settings = this.#host.settings();
				if (!settings) {
					await this.#host.ensureRegistry();
					settings = this.#host.settings();
				}
				if (!settings) throw new Error("settings unavailable");
				if (!this.#host.cwd()) return { overrides: [] };

				if (p.action === "delete" && p.path) {
					const segments = p.path.split(".");
					// Currently only modelRoles.<role> leaves are writable in
					// the project layer (setProjectModelRole is the sole
					// project-write API); anything else is read-only here.
					if (segments.length === 2 && segments[0] === "modelRoles") {
						settings.clearProjectModelRole(segments[1]);
						await settings.flush();
					} else {
						throw new Error(`project override ${p.path} is not deletable from the panel`);
					}
					return { ok: true };
				}

				// Redact at the source: capability discovery (e.g.
				// .claude/settings.json) and hand-edited project config.yml can
				// carry secrets the schema never sees, so path-shape filtering
				// is the only guard — never echo those values to any client.
				// The count only covers REAL overrides (project value differs
				// from the inherited global value).
				const globalFlat = settings.getGlobalLayerFlat();
				const overrides = settings
					.getProjectOverrideEntries()
					.filter(e => !isSensitiveSettingPath(e.path))
					.map(entry => ({
						path: entry.path,
						projectValue: entry.value,
						effectiveValue: entry.effective,
						globalValue: globalFlat[entry.path],
					}));
				return { cwd: this.#host.cwd(), overrides };
			}
			case "settings.schema": {
				// UI metadata for the settings panel (TUI parity): every
				// setting with ui metadata on the requested tabs, so the GUI
				// renders from the single source of truth instead of a
				// hardcoded copy that drifts.
				const p = (params ?? {}) as { tabs?: string[] };
				const { getEnumValues, SETTINGS_SCHEMA, SETTING_TABS } = await import("../config/settings-schema");
				// Extension-contributed settings (registerSetting, e.g. the
				// swarm style extension's display.taskCardStyle) live in the
				// host-level cache — merged so the panel shows them without
				// requiring a live session.
				const extSettings = this.#host.extensionSettings();
				// P1 设置 tab 开放:白名单 = SETTING_TABS ∪ 扩展声明 tab
				// (registerSetting 的 ui.tab)。扩展 tab 名仍受"客户端不能
				// 发明任意 tab"约束——只有真实注册过的 tab 才返回,typo 丢弃。
				// 扩展设置走各自声明的 ui.tab(插入现有 tab,不设聚合 tab)。
				const extTabs = new Set<string>();
				for (const { setting } of extSettings.values()) extTabs.add(setting.ui.tab);
				const requested = p.tabs && p.tabs.length > 0 ? p.tabs : ["memory", "files"];
				const tabs = requested.filter(tab => (SETTING_TABS as readonly string[]).includes(tab) || extTabs.has(tab));
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
					// Merge extension-contributed settings for this tab (they
					// win over nothing — keys are extension-owned namespaces).
					for (const [key, { setting, extensionPath }] of extSettings) {
						if (setting.ui.tab !== tab) continue;
						if (items.some(item => (item as { key: string }).key === key)) continue;
						items.push({
							key,
							type: setting.type,
							default: setting.default,
							ui: setting.ui,
							extensionId: extensionPath,
						});
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
				// Pull a queued user message back into the editor (TUI Alt+Up
				// dequeue parity): the GUI "取回" action. With group+text it
				// pops THAT message (per-item 取回 in the queue panel);
				// without, the newest one (legacy single-action behavior).
				const p = (params ?? {}) as { sessionId: string; group?: "steering" | "followUp"; text?: string };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				const agent = live.agentSession as unknown as {
					popLastQueuedMessage():
						| { text: string; images?: { type: string; data: string; mimeType: string }[] }
						| undefined;
					popQueuedMessage(
						group: "steering" | "followUp",
						text: string,
					): { text: string; images?: { type: string; data: string; mimeType: string }[] } | undefined;
				};
				const popped =
					p.group && typeof p.text === "string"
						? agent.popQueuedMessage(p.group === "followUp" ? "followUp" : "steering", p.text)
						: agent.popLastQueuedMessage();
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
			case "session.queuedSend": {
				// 立即发出指定排队消息 (TUI 引导消息回车即发 parity): the GUI's
				// per-item "send now" button pulls the matched message out of the
				// steering/follow-up queue and re-injects it as an immediate steer.
				const p = (params ?? {}) as { sessionId: string; group?: "steering" | "followUp"; text?: string };
				if (typeof p.sessionId !== "string" || typeof p.text !== "string" || !p.text) {
					throw new Error("sessionId and text required");
				}
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				const agent = live.agentSession as unknown as {
					sendQueuedMessage(group: "steering" | "followUp", text: string): Promise<boolean>;
				};
				const sent = await agent.sendQueuedMessage(p.group === "followUp" ? "followUp" : "steering", p.text);
				if (!sent) throw new Error("Queued message not found");
				return { sent: true };
			}
			case "notes.list": {
				// Project notes (right-panel 项目知识, openchamber v1.19 parity):
				// one markdown file per note under agentDir/notes/<cwdHash>/,
				// never touching the user's project. The legacy single-blob
				// note (<slug>.md) migrates into the per-project dir on first
				// list, then the old file is removed.
				const p = (params ?? {}) as { cwd?: string };
				const cwd = p.cwd?.trim() || this.#host.cwd();
				const slug = await hashProjectPath(cwd);
				const dir = path.join(getAgentDir(), "notes", slug);
				// Legacy migration: old single-note file → first note.
				const legacy = path.join(getAgentDir(), "notes", `${slug}.md`);
				try {
					const legacyText = await fs.promises.readFile(legacy, "utf8");
					if (legacyText.trim()) {
						await fs.promises.mkdir(dir, { recursive: true });
						const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
						await fs.promises.writeFile(path.join(dir, `${stamp}-note.md`), legacyText, "utf8");
					}
					await fs.promises.rm(legacy, { force: true });
				} catch {
					// no legacy file
				}
				let files: string[] = [];
				try {
					files = (await fs.promises.readdir(dir)).filter(f => f.endsWith(".md"));
				} catch {
					// no notes yet
				}
				const notes = [];
				for (const f of files.sort()) {
					const id = f.slice(0, -3);
					let createdAt = f.slice(0, 15);
					let updatedAt = createdAt;
					try {
						const st = await fs.promises.stat(path.join(dir, f));
						updatedAt = st.mtime.toISOString().replace(/[:.]/g, "-").slice(0, 19);
						if (createdAt.length < 14) createdAt = st.mtime.toISOString().slice(0, 10);
					} catch {
						// keep filename date
					}
					const body = await fs.promises.readFile(path.join(dir, f), "utf8");
					notes.push({ id, body, createdAt, updatedAt });
				}
				return { notes: notes.reverse() };
			}
			case "notes.create": {
				// Create one note. A blank body is a rejected write, not a
				// delete (openchamber v1.19 invariant).
				const p = (params ?? {}) as { cwd?: string; body?: string };
				const cwd = p.cwd?.trim() || this.#host.cwd();
				const body = (p.body ?? "").trim();
				if (!body) return { error: "blank note body" };
				const slug = await hashProjectPath(cwd);
				const dir = path.join(getAgentDir(), "notes", slug);
				await fs.promises.mkdir(dir, { recursive: true });
				const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
				const id = `${stamp}-note`;
				await fs.promises.writeFile(path.join(dir, `${id}.md`), body, "utf8");
				return { id, createdAt: stamp };
			}
			case "notes.update": {
				const p = (params ?? {}) as { cwd?: string; id?: string; body?: string };
				const cwd = p.cwd?.trim() || this.#host.cwd();
				if (!p.id || /[^a-zA-Z0-9-]/.test(p.id)) return { error: "invalid note id" };
				const body = p.body ?? "";
				if (!body.trim()) return { error: "blank note body" };
				const slug = await hashProjectPath(cwd);
				const file = path.join(getAgentDir(), "notes", slug, `${p.id}.md`);
				try {
					await fs.promises.writeFile(file, body, "utf8");
					return { ok: true };
				} catch {
					return { error: "note not found" };
				}
			}
			case "notes.delete": {
				const p = (params ?? {}) as { cwd?: string; id?: string };
				const cwd = p.cwd?.trim() || this.#host.cwd();
				if (!p.id || /[^a-zA-Z0-9-]/.test(p.id)) return { error: "invalid note id" };
				const slug = await hashProjectPath(cwd);
				try {
					await fs.promises.unlink(path.join(getAgentDir(), "notes", slug, `${p.id}.md`));
					return { ok: true };
				} catch {
					return { error: "note not found" };
				}
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
			case "models.catalog": {
				// Full bundled catalog grouped by provider (TUI model-hub
				// sidebar parity): every known provider plus its static models,
				// with per-provider availability (auth configured or keyless).
				// The GUI role-config rail renders registered vs unregistered
				// providers from this one call — no per-session scan involved.
				const registry = await this.#host.ensureRegistry();
				if (!registry) return [];
				const all = registry.getAll();
				const available = new Set(registry.getAvailable().map(model => model.provider));
				const registryNames = new Map(PROVIDER_REGISTRY.map(def => [def.id, def.name]));
				const byProvider = new Map<
					string,
					{ provider: string; name: string; available: boolean; models: { id: string; name: string }[] }
				>();
				for (const model of all) {
					let group = byProvider.get(model.provider);
					if (!group) {
						group = {
							provider: model.provider,
							name: registryNames.get(model.provider) ?? model.provider,
							available: available.has(model.provider),
							models: [],
						};
						byProvider.set(model.provider, group);
					}
					group.models.push({ id: model.id, name: model.name ?? model.id });
				}
				return [...byProvider.values()]
					.sort((a, b) => a.name.localeCompare(b.name))
					.map(group => ({ ...group, modelCount: group.models.length }));
			}
			case "models.detail": {
				// One model's detail row (cost/context/efforts) by id, without a
				// live session — the welcome composer's thinking selector reads
				// the current model's ladder from here.
				const p = (params ?? {}) as { id: string };
				if (!p.id) throw new Error("model id required");
				const registry = await this.#host.ensureRegistry();
				if (!registry) return null;
				const available = registry.getAvailable();
				// Accept both bare ids ("deepseek-v4-flash") and provider-qualified
				// selectors ("opencode-go/deepseek-v4-flash" — the modelRoles
				// default format the welcome composer preselects from). The old
				// exact-id match never resolved the prefixed form, so the empty
				// state collapsed the thinking ladder to off/auto while the
				// session selector (session.thinkingInfo) showed the real rungs.
				const slash = p.id.indexOf("/");
				const model =
					slash > 0
						? (resolveProviderModelReference(p.id.slice(0, slash), p.id.slice(slash + 1), available) ??
							available.find(m => m.id === p.id))
						: available.find(m => m.id === p.id);
				return model ? modelDetailRow(model) : null;
			}
			case "models.add": {
				// Append an OpenAI-compatible custom provider to models.yml
				// (the same config the TUI `/login` + custom-model docs target),
				// then reload the registry so the model is selectable at once.
				//
				// Editing an existing provider reuses this RPC: models.yml rows
				// are merged by provider name, so passing the same name with
				// updated per-model capability fields (input/contextWindow/
				// maxTokens) rewrites those rows in place. The GUI edit dialog
				// round-trips models.listCustom → form → models.add.
				const p = (params ?? {}) as {
					provider: {
						name: string;
						baseUrl?: string;
						apiKey?: string;
						api?: string;
						models: {
							id: string;
							name?: string;
							compactionModel?: string;
							input?: string[] | null;
							contextWindow?: number | null;
							maxTokens?: number | null;
						}[];
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
				// Merge model rows by id: new ids are appended, existing ids get
				// their editable capability fields (input/contextWindow/maxTokens)
				// and name overwritten from the payload. An explicit `null`
				// capability removes the override (restore-to-auto: the model
				// falls back to bundled / models.dev / id-inferred capabilities);
				// an absent field keeps the stored value, so a zoom-level-only
				// edit does not blank other fields.
				const existing = Array.isArray(entry.models) ? (entry.models as Record<string, unknown>[]) : [];
				const byId = new Map(existing.map(m => [m.id as string, m]));
				for (const m of p.provider.models) {
					const row: Record<string, unknown> = { ...(byId.get(m.id) ?? {}), id: m.id };
					if (m.name) row.name = m.name;
					if (m.compactionModel) row.compactionModel = m.compactionModel;
					if (m.input === null) delete row.input;
					else if (Array.isArray(m.input) && m.input.length > 0) row.input = m.input;
					if (m.contextWindow === null) delete row.contextWindow;
					else if (m.contextWindow !== undefined && m.contextWindow !== null) row.contextWindow = m.contextWindow;
					if (m.maxTokens === null) delete row.maxTokens;
					else if (m.maxTokens !== undefined && m.maxTokens !== null) row.maxTokens = m.maxTokens;
					byId.set(m.id, row);
				}
				entry.models = [...byId.values()];
				providers[p.provider.name] = entry;
				fs.mkdirSync(path.dirname(filePath), { recursive: true });
				fs.writeFileSync(filePath, YAML.stringify({ providers }, null, 2));
				// mtime changed → registry reloads the custom models on refresh().
				await registry.refresh();
				this.#broadcastModelsChanged();
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
				this.#broadcastModelsChanged();
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
			case "session.askAnswer": {
				// Answer a pending ask card (TUI ask parity): select mode takes
				// one option label, input mode the custom text; null cancels.
				const p = (params ?? {}) as { sessionId: string; requestId: string; answer: string | null };
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				if (!live.approvals.resolveAsk(p.requestId, p.answer ?? null))
					throw new Error(`Unknown ask request: ${p.requestId}`);
				return { ok: true };
			}
			case "usage.reports": {
				// Provider subscription quota (TUI /usage parity): the live
				// session's fetchUsageReports — the same data the ACP-mode
				// `_omp/usage` RPC serves. The GUI composer's context-usage
				// popover shows it next to the token breakdown.
				//
				// /usage is NOT model-bound (unlike /context): the data is
				// every account across every provider, so the RPC also serves
				// session-less — the empty-state composer fetches the same
				// global view without a live session. Only the ● active-account
				// marker needs the session, so it is omitted on the global path.
				const p = (params ?? {}) as { sessionId?: string };
				const live = p.sessionId ? this.#host.get(p.sessionId) : undefined;
				if (p.sessionId && !live) throw new Error("No active session");
				// TUI /usage parity coverage: the report pool plus every gap the
				// text panel shows — ○ accounts with no usage data, ✗ disabled
				// credential tombstones, ⚠ OAuth re-login deadlines. Attribution
				// and selection are shared with the TUI (daemon/usage-shared.ts)
				// so the two surfaces can't drift apart.
				const gapContext = async (storage: AuthStorage, reports: UsageReport[]) => {
					const accounts = selectReportableAccounts(
						collectStoredAccounts(storage),
						provider => storage.usageProviderFor(provider) !== undefined,
					);
					// Best-effort revalidate (TUI runUsageCommand parity): a
					// just-logged-in credential must not render as a stale
					// duplicate from the disk cache.
					try {
						await storage.revalidateCredentials();
					} catch {
						// Stale identities beat no output.
					}
					let disabledCredentials: DisabledCredentialSummary[] = [];
					try {
						disabledCredentials = (await storage.listDisabledCredentials()).filter(summary =>
							isActionableDisable(summary, accounts),
						);
					} catch {
						// Usage output must not fail because tombstone listing did.
					}
					return {
						unreportedAccounts: collectUnreportedAccounts(reports, accounts),
						disabledCredentials,
						reloginDeadlines: computeReloginDeadlines(accounts, Date.now()),
					};
				};
				if (!live) {
					// Session-less path (empty-state composer): bootstrap the
					// daemon-level registry like models.list / auth.list do and
					// fetch from its auth storage. The antigravity sandbox
					// special-case is session-settings-driven, so it stays on
					// the session path.
					const registry = await this.#host.ensureRegistry();
					if (!registry) throw new Error("No model registry yet");
					const reports =
						(await registry.authStorage.fetchUsageReports({
							baseUrlResolver: provider => registry.getProviderBaseUrl?.(provider),
						})) ?? [];
					const gaps = await gapContext(registry.authStorage, reports);
					return { reports, ...gaps };
				}
				const reports = (await live.agentSession.fetchUsageReports()) ?? [];
				const gaps = await gapContext(live.agentSession.modelRegistry.authStorage, reports);
				// TUI /usage parity: resolve the credential this session is
				// actually using so the GUI can mark the active account (●)
				// the way the TUI panel does.
				const provider = live.agentSession.model?.provider;
				let activeAccount: { provider: string; accountId?: string; email?: string } | undefined;
				if (provider) {
					const identity = live.agentSession.modelRegistry.authStorage.getOAuthAccountIdentity(
						provider,
						live.agentSession.sessionId,
					);
					if (identity) {
						activeAccount = {
							provider,
							...(identity.accountId ? { accountId: identity.accountId } : {}),
							...(identity.email ? { email: identity.email } : {}),
						};
					}
				}
				return { reports, ...gaps, ...(activeAccount ? { activeAccount } : {}) };
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
	text: boolean;
	vision: boolean;
	video: boolean;
	imageGen: boolean;
	videoGen: boolean;
	efforts: string[];
} {
	const capabilities = resolveModelCapabilities(model.id, model.input);
	return {
		id: model.id,
		name: model.name ?? model.id,
		provider: model.provider ?? "",
		contextWindow: model.contextWindow ?? null,
		maxTokens: model.maxTokens ?? null,
		costInput: model.cost?.input ?? 0,
		costOutput: model.cost?.output ?? 0,
		reasoning: model.reasoning === true,
		text: capabilities.text,
		vision: capabilities.image,
		video: capabilities.video,
		imageGen: capabilities.imageGen,
		videoGen: capabilities.videoGen,
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

/** Resolve the renderer dist dir the compat HTTP server serves. Env
 *  MUSEPI_RENDERER_DIST overrides; defaults to the workspace sibling
 *  desktop-web/dist (dev layout). A missing dist is non-fatal —
 *  startDaemonWeb throws and the shell falls back to its local bundle. */
function rendererDistDir(): string {
	const fromEnv = process.env.MUSEPI_RENDERER_DIST;
	if (fromEnv) return fromEnv;
	return path.resolve(import.meta.dir, "../../../desktop-web", "dist");
}

export async function startDaemon(
	options: DaemonOptions = {},
): Promise<{ socketPath: string; wsPort?: number; webUrl?: string; close: () => Promise<void> }> {
	// Windows: every Bun.spawn child (git/gh/shell/powershell) opens a new
	// console window unless windowsHide is set. Patch the globals once so no
	// spawn site (current or future) can leak a terminal popup from the
	// GUI-hosted daemon.
	installWindowsSpawnGuard();
	// A daemon must outlive stray async rejections (e.g. a provider stream
	// tearing down while a session is disposed mid-turn): Bun's default
	// handler prints and exits with code 1. Log with the stack instead so a
	// single teardown race cannot take the whole GUI backend down.
	process.on("unhandledRejection", (reason: unknown) => {
		logger.error("Unhandled rejection in daemon", { reason: String(reason) });
	});
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
		// A remote token opts the daemon into listening on all interfaces
		// with mandatory bearer auth — the remote-instance switcher's
		// security gate. Without it the WS stays loopback-only (local GUI).
		const remote = options.remoteToken
			? { host: "0.0.0.0" as const, authToken: options.remoteToken }
			: undefined;
		try {
			wsHandle = await startDaemonWs({
				port: options.wsPort,
				...(remote ?? {}),
				onMessage: (conn, text) => void handleRpcLine(server, text, conn),
				onClose: connId => {
					host.disconnect(connId);
					server.dropGlobalEventTarget(connId);
				},
			});
		} catch (err) {
			host.dispose();
			throw err;
		}
	}

	// Loopback HTTP static renderer — the "runtime serves the web renderer"
	// half of the dsh-desktop-compat chain: the Electron compat shell
	// loadURLs this origin and overlays the desktop frame over the served
	// content. Optional (webPort); a missing renderer dist is non-fatal —
	// the shell falls back to its local bundle.
	let webHandle: DaemonWebHandle | null = null;
	if (options.webPort !== undefined) {
		try {
			webHandle = await startDaemonWeb({
				port: options.webPort,
				distDir: rendererDistDir(),
				wsPort: wsHandle?.port,
				token: options.remoteToken,
			});
		} catch (err) {
			logger.warn(`compat renderer unavailable (fall back to local bundle): ${String(err)}`);
		}
	}
	// The desktop-shell extension reports the served origin so the GUI shell
	// (and any extension center) sees where the runtime-served content lives.
	server.setWebUrl(webHandle?.url ?? null);
	server.setSocketPath(socketPath);

	const netServer = net.createServer(socket => {
		const conn: DaemonConnection = {
			id: `c${++connCounter}`,
			send: message => {
				if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
			},
			writableLength: () => socket.writableLength,
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
			server.dropGlobalEventTarget(conn.id);
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
	// Persist the served compat-renderer origin (web.port) so the desktop
	// shell discovers the runtime-served content without an RPC round-trip —
	// same model as ws.port. Absent = the shell loads its local bundle.
	const webPortFile = path.join(path.dirname(socketPath), "web.port");
	if (webHandle) {
		try {
			await fs.promises.writeFile(webPortFile, String(webHandle.port), "utf8");
		} catch {
			// non-fatal: the shell falls back to the local bundle
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
		webUrl: webHandle?.url,
		close: async () => {
			try {
				await fs.promises.unlink(portFile);
			} catch {
				// already gone
			}
			try {
				await fs.promises.unlink(webPortFile);
			} catch {
				// already gone
			}
			if (wsHandle) await wsHandle.close();
			if (webHandle) await webHandle.close();
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


// ── Launch-at-login (daemon self-registration, openchamber parity) ────────
// The daemon is independent of the Electron GUI, so Electron's
// setLoginItemSettings cannot cover it. We register the DAEMON command
// itself in the OS autostart slot:
//   win32   — HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run
//   darwin  — ~/Library/LaunchAgents/dev.musepi.daemon.plist
//   linux   — ~/.config/autostart/musepi-daemon.desktop
// GUI-less operation: the daemon stays up after login and the GUI connects
// on demand (open-design sidecar model). The check reads the actual slot so
// external edits are reflected.

const AUTOSTART_RUN_KEY =
	"Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\Run";

/** Resolve the daemon binary path for autostart registration. Returns empty
 *  when the binary cannot be found (dev mode — autostart only makes sense
 *  for packaged installs). */
function resolveDaemonBinary(): string {
	// Packaged: look for the daemon binary relative to this script's
	// location. The server is at <root>/packages/coding-agent/src/daemon/.
	// The packaged binary is at <root>/packages/gui/vendor/daemon/musepi.exe
	// (or the asar-unpacked equivalent).
	const candidates = [
		path.join(__dirname, "..", "..", "..", "..", "..", "vendor", "daemon", "musepi.exe"),
		path.join(__dirname, "..", "..", "..", "..", "..", "vendor", "daemon", "musepi"),
		// Electron asar-unpacked path (packaged app)
		path.join((process as { resourcesPath?: string }).resourcesPath ?? "", "app.asar.unpacked", "vendor", "daemon", "musepi.exe"),
		path.join((process as { resourcesPath?: string }).resourcesPath ?? "", "app.asar.unpacked", "vendor", "daemon", "musepi"),
		// PATH fallback
		Bun.which("musepi") ?? "",
	];
	for (const c of candidates) {
		if (c && fs.existsSync(c)) return c;
	}
	return "";
}

export function getAutostartState(): { enabled: boolean; supported: boolean; binary?: string } {
	if (process.platform === "win32") {
		try {
			const out = Bun.spawnSync(["reg.exe", "query", AUTOSTART_RUN_KEY, "/v", "musepi-daemon"], {
				stdout: "pipe", stderr: "pipe",
			});
			return { enabled: out.exitCode === 0, supported: true };
		} catch {
			return { enabled: false, supported: true };
		}
	}
	if (process.platform === "darwin") {
		const plist = path.join(os.homedir(), "Library", "LaunchAgents", "dev.musepi.daemon.plist");
		return { enabled: fs.existsSync(plist), supported: true };
	}
	if (process.platform === "linux") {
		const dir = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
		const desktop = path.join(dir, "autostart", "musepi-daemon.desktop");
		return { enabled: fs.existsSync(desktop), supported: true };
	}
	return { enabled: false, supported: false };
}

export async function setAutostartState(enabled: boolean): Promise<void> {
	if (process.platform === "win32") {
		if (enabled) {
			const bin = resolveDaemonBinary();
			if (!bin) throw new Error("cannot register autostart: daemon binary not found");
			Bun.spawnSync(["reg.exe", "add", AUTOSTART_RUN_KEY, "/v", "musepi-daemon", "/t", "REG_SZ", "/d", `"${bin}" serve --port 8300`, "/f"], {
				stdout: "pipe", stderr: "pipe",
			});
		} else {
			Bun.spawnSync(["reg.exe", "delete", AUTOSTART_RUN_KEY, "/v", "musepi-daemon", "/f"], {
				stdout: "pipe", stderr: "pipe",
			});
		}
		return;
	}
	if (process.platform === "darwin") {
		const plist = path.join(os.homedir(), "Library", "LaunchAgents", "dev.musepi.daemon.plist");
		if (enabled) {
			const bin = resolveDaemonBinary();
			if (!bin) throw new Error("cannot register autostart: daemon binary not found");
			await fs.promises.mkdir(path.dirname(plist), { recursive: true });
			await fs.promises.writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.musepi.daemon</string>
  <key>ProgramArguments</key><array>
    <string>${bin}</string>
    <string>serve</string>
    <string>--port</string>
    <string>8300</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict></plist>`, "utf8");
		} else {
			try { await fs.promises.unlink(plist); } catch { /* no-op */ }
		}
		return;
	}
	if (process.platform === "linux") {
		const dir = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
		const desktop = path.join(dir, "autostart", "musepi-daemon.desktop");
		if (enabled) {
			const bin = resolveDaemonBinary();
			if (!bin) throw new Error("cannot register autostart: daemon binary not found");
			await fs.promises.mkdir(path.dirname(desktop), { recursive: true });
			await fs.promises.writeFile(desktop, `[Desktop Entry]
Type=Application
Name=Musepi Daemon
Exec=${bin} serve --port 8300
X-GNOME-Autostart-enabled=true
`, "utf8");
		} else {
			try { await fs.promises.unlink(desktop); } catch { /* no-op */ }
		}
		return;
	}
	throw new Error("autostart not supported on this platform");
}

