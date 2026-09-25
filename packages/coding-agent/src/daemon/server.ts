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
import { getDashboardStats } from "@musepi/musepi-stats";
import type { AgentEvent } from "@musepi/pi-agent-core";
import { AgentBusyError, agentPauseGate } from "@musepi/pi-agent-core";
import { effectiveReserveTokens, resolveThresholdTokens } from "@musepi/pi-agent-core/compaction";
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
import { DesktopSession, getWorkProfile } from "@musepi/pi-natives";
import { $env, getAgentDir, getConfigRootDir, getSessionsDir, logger, prompt, VERSION } from "@musepi/pi-utils";
import { interceptUnhandledRejections } from "@musepi/pi-utils/postmortem";
import type {
	SessionEntry,
	SessionHeader,
	SessionState,
	SttModelRow,
	SttModelStatusResponse,
	AgentEvent as WireAgentEvent,
	WireMessage,
} from "@musepi/pi-wire";
import { messageKey, type Static, type sessionSnapshot } from "@musepi/sdk";
import { YAML } from "bun";
import { reset as resetCapabilities } from "../capability";
import {
	ChannelCommandHandler,
	type ChannelKind,
	ChannelRegistry,
	channelFailureText,
	DiscordChannel,
	FeishuChannel,
	HuaweiTodayChannel,
	TelegramChannel,
	WechatChannel,
} from "../channels";
import { loadChannelBindings, saveChannelBindings } from "../channels/bindings";
import { BUILTIN_PLUGINS, loadChannelPlugins } from "../channels/plugins";
import { CollabHost } from "../collab/host";
import { LocalShareManager } from "../collab/local-share";
import { PairCodes } from "../collab/pair-codes";
import { findConfigFile } from "../config";
import { resolveProviderModelReference } from "../config/model-resolver";
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
import { buildSkillPromptMessage, parseSkillInvocation } from "../extensibility/skills";
import { loadSlashCommands } from "../extensibility/slash-commands";
import { copyLocalArtifacts, resolveLocalRoot, resolveLocalUrlToPath } from "../internal-urls/local-protocol";
import { cacheHitRate } from "../modes/utils/cache-hit";
import { resolveApprovedPlan, resolvePlanTitle } from "../plan-mode/approved-plan";
import { listPlanFiles, readPlanFile, writePlanFile } from "../plan-mode/plan-files";
import guidedGoalInterviewPrompt from "../prompts/goals/guided-goal-interview.md" with { type: "text" };
import manualContinuePrompt from "../prompts/system/manual-continue.md" with { type: "text" };
import planModeApprovedPrompt from "../prompts/system/plan-mode-approved.md" with { type: "text" };
import planModeCompactInstructionsPrompt from "../prompts/system/plan-mode-compact-instructions.md" with {
	type: "text",
};
import type { CompactMode } from "../session/compact-modes";
import {
	createForeignSessionStore,
	foreignSessionSourceName,
	foreignSessionSources,
	persistForeignSession,
} from "../session/foreign-session-import";
import type { ForeignSessionInfo, ForeignSessionSource } from "../session/foreign-session-store";
import { SKILL_PROMPT_MESSAGE_TYPE } from "../session/messages";
import { executeAcpBuiltinSlashCommand } from "../slash-commands/acp-builtins";
import { lookupBuiltinSlashCommand } from "../slash-commands/builtin-registry";
import { parseSlashCommand } from "../slash-commands/helpers/parse";
import { resolvePromptInput } from "../system-prompt";
import { refreshAgentDiscovery } from "../task";
import type { ConfiguredThinkingLevel } from "../thinking";
import { parseConfiguredThinkingLevel } from "../thinking";
import type { CollabToolHandle } from "../tools/collab";
import { getExtensionMediaProviders, IMAGE_PROVIDER_CHOICES } from "../tools/image-providers";
import type { ScheduledTaskHandle } from "../tools/schedule-task";
import type { TodoPhase } from "../tools/todo";
import { ToolError } from "../tools/tool-errors";
import { createSessionWorktree } from "../utils/session-worktree";
import { readArtifactEntryText, scanWorkspaceArtifacts } from "./artifact-scan.js";

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

import { ModelsConfigFile } from "../config/models-config";
import type { StoredAuthCredential } from "../session/auth-storage";
import { USER_INTERRUPT_LABEL } from "../session/messages";
import { openPath } from "../utils/open";
import { installWindowsSpawnGuard } from "../utils/windows-spawn-guard";
import { ApprovalService } from "./services/approval-service";
import { BoardService } from "./services/board-service";
import { BrowserService } from "./services/browser-service";
import { EventService } from "./services/event-service";
import { ExtensionService } from "./services/extension-service";
import { FileService } from "./services/file-service";
import { MarketplaceService } from "./services/marketplace-service";
import { HostServices } from "./services/registry";
import { RemoteService } from "./services/remote-service";
import { ScheduleService } from "./services/schedule-service";
import { TerminalService } from "./services/terminal-service";
import { UsageService } from "./services/usage-service";
import { ViewStoreService } from "./services/view-store-service";
import type { DaemonConnection, DaemonOptions, LiveSession, RpcRequest } from "./session-host";
import {
	assistantReplyText,
	buildDaemonTurnIndex,
	DaemonSessionHost,
	DEFAULT_SOCKET,
	estimateSnapcompactSavings,
	extractEntryText,
	MAX_REQUEST_BYTES,
	modesOf,
	PAIR_PORT,
	renderDebugTranscript,
	SOCKET_DIR,
	TAIL_ENTRIES,
	tailSnapshot,
} from "./session-host";
import { type DaemonWebHandle, startDaemonWeb } from "./static-web";
import { type DaemonWsHandle, startDaemonWs } from "./ws-transport";

export type { DaemonConnection, DaemonOptions, IdleCandidate, LiveSession } from "./session-host";
export {
	buildDaemonTurnIndex,
	DaemonSessionHost,
	IDLE_TIMEOUT_MS,
	idleDisposePlan,
	isLiveSessionBusy,
	JOURNAL_DIR,
	journalFilePath,
	MAX_REQUEST_BYTES,
	TAIL_ENTRIES,
} from "./session-host";

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
	/** L2 宿主服务注册表（P1 服务抽取）。服务的 case 委托入口见构造函数。 */
	readonly #services = new HostServices();
	/** Speech-model downloads currently running (keyed by model tier key).
	 *  Guards against two windows (or a double-click race) starting parallel
	 *  fetches into the same cache directory. */
	readonly #sttDownloads = new Map<string, Promise<void>>();

	/** Drop a connection from the global-event targets (called on close —
	 *  the host's disconnect handles the session subscription side). */
	dropGlobalEventTarget(connectionId: string): void {
		this.#services.get<EventService>("events").dropTarget(connectionId);
	}
	/** In-flight CPU profilers started by debug.profileStart (TUI /debug
	 *  performance-report parity: profile spans two RPC calls so the GUI can
	 *  hold "reproduce, then stop" between them). */
	#debugProfilers = new Map<number, ProfilerSession>();
	#nextDebugProfilerId = 1;

	constructor(host: DaemonSessionHost) {
		host.setCollabToolProvider(() => this.#collabToolHandle());
		host.setScheduledTaskProvider(sessionCwd => this.scheduledTaskHandle(sessionCwd));
		host.setOnExtensionNotification((channel, message) => {
			this.#services.get<EventService>("events").broadcastExtensionNotification(channel, message);
		});
		this.#host = host;
		// L2 宿主服务注册表（P1 服务抽取，docs/review/0.5.0-m2-daemon-host-layering.md）：
		// 巨型 switch 的 case 逐个委托给注册表中的服务；未委托 case 必须
		// 登记在 services/legacy-routes.ts（路由覆盖快照测试强制闭包）。
		this.#services.register(
			new UsageService({
				get: sessionId => this.#host.get(sessionId),
				ensureRegistry: () => this.#host.ensureRegistry(),
			}),
		);
		this.#services.register(
			new EventService({
				emitEvent: (conn, event) => this.#host.emitEvent(conn as DaemonConnection, event),
				catchupFrom: (sessionId, afterSeq, conn) =>
					this.#host.catchupFrom(sessionId, afterSeq, conn as DaemonConnection),
			}),
		);
		this.#services.register(new ViewStoreService(host.viewStore));
		this.#services.register(new BoardService());
		this.#services.register(
			new FileService({
				fallbackCwd: () => host.workspaceFallbackCwd,
				ensureFileIndex: () => host.ensureFileIndex(),
			}),
		);
		this.#services.register(
			new TerminalService({
				nextSeq: () => ++this.#eventSeq,
				emit: (conn, envelope) => this.#host.emitEvent(conn as DaemonConnection, envelope),
				settings: () => this.#settingsForRpc().catch(() => null),
			}),
		);
		this.#services.register(
			new ApprovalService({
				get: sessionId => this.#host.get(sessionId),
			}),
		);
		this.#services.register(
			new BrowserService({
				settings: () => this.#settingsForRpc(),
				cwd: () => this.#host.cwd(),
			}),
		);
		this.#services.register(new RemoteService());
		const schedule = new ScheduleService({
			createSession: opts => this.#host.createSession(opts),
			get: sessionId => this.#host.get(sessionId),
			deleteSession: sessionId => this.#host.deleteSession(sessionId),
			onCronsChanged: () => this.#services.get<EventService>("events").broadcastCronsChanged(),
		});
		this.#services.register(schedule);
		schedule.start();
		this.#services.register(
			new ExtensionService({
				settings: () => this.#host.settings(),
				ensureRegistry: () => this.#host.ensureRegistry(),
				cwd: () => this.#host.cwd(),
				webUrl: () => this.#webUrl,
				webPortFile: () => path.join(path.dirname(this.#socketPath || DEFAULT_SOCKET), "web.port"),
				onChanged: () => this.#services.get<EventService>("events").broadcastExtensionsChanged(),
			}),
		);
		this.#services.register(
			new MarketplaceService({
				cwd: () => this.#host.cwd(),
				settings: () => this.#host.settings(),
				extensionEntries: () => this.#services.get<ExtensionService>("extensions").getExtensions(),
				invalidateExtensionsCache: () =>
					this.#services.get<ExtensionService>("extensions").invalidateExtensionsCache(),
				invalidatePluginCaches: () => this.#services.get<ExtensionService>("extensions").invalidatePluginCaches(),
				onChanged: () => this.#services.get<EventService>("events").broadcastExtensionsChanged(),
			}),
		);
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
				// Native typing indicator toward every peer bound to the session
				// (wechat sendtyping); #pushChannelReplies stops it on reply.
				startTyping: sessionId => this.#startChannelTyping(sessionId),
			},
			(kind, from, text) => this.#channels.send(kind as ChannelKind, { to: from, text }),
			{
				// Bindings persist across daemon restarts — a plain text message
				// must still route to the session it was bound to before.
				load: () => loadChannelBindings(path.join(SOCKET_DIR, "channel-bindings.json")),
				save: snapshot => saveChannelBindings(path.join(SOCKET_DIR, "channel-bindings.json"), snapshot),
			},
		);
		this.#channelHandler = handler;
		this.#channels = new ChannelRegistry({
			configPath: path.join(SOCKET_DIR, "channels.json"),
			host: handler,
			factories: {
				"huawei-today": () => new HuaweiTodayChannel(),
				discord: () => new DiscordChannel(),
				wechat: () =>
					new WechatChannel({
						// QR-login bot_token flows into channels.json (registry
						// persistRuntimeConfig) — 停止 then only disconnects; the next
						// start() reconnects with the saved token instead of a re-scan.
						persistCredentials: token => this.#channels.persistRuntimeConfig("wechat", { token }),
					}),
				telegram: () => new TelegramChannel(),
				feishu: () => new FeishuChannel("feishu"),
				lark: () => new FeishuChannel("lark"),
			},
		});
		// agent_end → channel reply pushes (wechat "正在输入" stop + final
		// answer) + task-completion pushes (huawei today-screen).
		host.onAgentEnd = (live, event) => {
			void this.#pushChannelReplies(live, event).catch(() => {});
			void this.#pushTaskCompletion(live).catch(() => {});
		};
		void this.#channels.startAll().catch(() => {});
		// Hot-pluggable channel plugins: scan ~/.musepi/agent/channels/*.ts
		// and register any discovered channel modules (game-mod style).
		this.#channelPluginDir = path.join(getAgentDir(), "channels");
		void this.#loadChannelPlugins().catch(() => {});
	}

	/** Active GUI collab share (ZCode remote-control dialog). */
	#collab: { host: CollabHost; transport: LocalShareManager } | null = null;

	/** Mobile pair codes: 6-digit code → the shared webLink. The GUI displays
	 *  the code; the mobile app resolves it against the LAN pair endpoint
	 *  (pair.resolve) to obtain the full collab link without typing it. */
	#pairCodes = new PairCodes();
	/** LAN pair endpoint (ws://0.0.0.0:8301) — resolves pair codes only. */
	#pairWs: DaemonWsHandle | null = null;

	/** Bot/notification channels (wechat/discord/huawei-today…). */
	#channels: ChannelRegistry;
	/** Command router reference — reply routing + typing target lookup. */
	#channelHandler: ChannelCommandHandler;
	/** Sessions with an active channel typing indicator (started when a
	 *  channel prompt is dispatched; stopped when the reply is pushed). */
	#channelTyping = new Set<string>();
	/** Directory for hot-pluggable channel plugins (game-mod style). */
	#channelPluginDir = "";

	/** Native typing indicator toward every peer bound to this session. */
	#startChannelTyping(sessionId: string): void {
		if (this.#channelTyping.has(sessionId)) return;
		this.#channelTyping.add(sessionId);
		for (const peer of this.#channelHandler.peersFor(sessionId)) {
			void this.#channels.startTyping(peer.kind as ChannelKind, peer.from).catch(() => {});
		}
	}

	#stopChannelTyping(sessionId: string): void {
		if (!this.#channelTyping.delete(sessionId)) return;
		for (const peer of this.#channelHandler.peersFor(sessionId)) {
			void this.#channels.stopTyping(peer.kind as ChannelKind, peer.from).catch(() => {});
		}
	}

	/** THE reply path for chat bots (was missing entirely: a plain text
	 *  message from WeChat reached the session but the agent's answer never
	 *  came back — the bot looked dead). On agent_end, push the last
	 *  assistant message to every channel peer bound to that session and
	 *  stop the typing indicator. */
	async #pushChannelReplies(live: LiveSession, event: Extract<AgentEvent, { type: "agent_end" }>): Promise<void> {
		this.#stopChannelTyping(live.sessionId);
		const peers = this.#channelHandler.peersFor(live.sessionId);
		if (peers.length === 0) return;
		const lastAssistant = [...event.messages].reverse().find(msg => msg.role === "assistant");
		const stop = (lastAssistant as { stopReason?: string } | undefined)?.stopReason;
		// A failed/aborted turn still owes the peer an answer — otherwise the
		// typing indicator just stops and they wait forever.
		const text =
			stop === "aborted" || stop === "error"
				? channelFailureText(
						peers[0].kind,
						stop,
						(lastAssistant as { errorMessage?: string } | undefined)?.errorMessage,
					)
				: assistantReplyText(lastAssistant);
		if (!text.trim()) return;
		for (const peer of peers) {
			await this.#channels
				.send(peer.kind as ChannelKind, { to: peer.from, text, replyTo: peer.messageId })
				.catch(err => {
					logger.warn(`channel reply push failed (${peer.kind})`, {
						error: err instanceof Error ? err.message : String(err),
					});
				});
		}
	}

	/** Load directory plugins and register them (hot-plug on reload). */
	async #loadChannelPlugins(): Promise<void> {
		if (!this.#channelPluginDir) return;
		const found = await loadChannelPlugins(this.#channelPluginDir, { force: true });
		const known = new Set(this.#channels.kinds());
		for (const { plugin, origin } of found) {
			if (known.has(plugin.kind)) continue; // builtin wins
			this.#channels.register(plugin.kind, () => plugin.create({ host: this.#channels.host }));
			logger.info(`channel plugin registered: ${plugin.kind} (${origin})`);
		}
	}

	#resumeLive: LiveSession | null = null;

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
					// Spent, not merely read: a resolved code is gone (see PairCodes).
					const webLink = this.#pairCodes.spend(code);
					if (!webLink) {
						conn.send({ error: { message: "invalid or expired pair code" } });
						return;
					}
					conn.send({ result: { webLink } });
				},
				onClose: () => {},
			});
		} catch (err) {
			logger.warn("pair endpoint unavailable", {
				error: err instanceof Error ? err.message : String(err),
			});
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
				const mode = opts.mode === "tunnel" ? "tunnel" : opts.mode === "workspace" ? "workspace" : "session";
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

	/** Clients subscribed to global-pause broadcasts (daemon.pauseStatus
	 *  subscribes; dead sockets are dropped lazily inside broadcast). */
	#pauseConns = new Set<DaemonConnection>();

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
			this.#services.get<ExtensionService>("extensions").invalidateCaches();
			// 扩展声明的技能经 MarketplaceService.getSkills 合并:扩展源变更
			// 时一并失效,否则虚拟技能列表最多滞后 10s TTL。
			this.#services.get<MarketplaceService>("marketplace").invalidateSkillsCache();
			void import("./extension-artifact-compiler").then(m => m.invalidateExtensionCaches());
			this.#services.get<EventService>("events").broadcastExtensionsChanged();
			// P5 HMR v2: session-scoped hot reload of loaded extensions whose
			// entry changed on disk. The watcher callback filename is
			// unreliable (empty/short names on Windows recursive watch), so
			// the per-entry mtime comparison decides what changed.
			this.#reloadChangedSessionExtensions();
		}, 500);
	}

	/** 预设目录(决策 #5):env MUSEPI_MODES_DIR 可覆盖(隔离测试),默认 <home>/.musepi/modes。 */
	#modesDir(): string {
		return $env.MUSEPI_MODES_DIR ?? path.join(os.homedir(), ".musepi", "modes");
	}

	/** Resolve a workspace-memory request to its per-cwd memory directory
	 *  (settings → memory workspace card). `slug` must be an existing
	 *  directory name under the memories root — the GUI only ever echoes
	 *  names this RPC itself handed out, but the check is enforced here:
	 *  no separators, no `..`, must exist. */
	async #memoryWorkspaceDir(p: {
		cwd?: unknown;
		slug?: unknown;
	}): Promise<{ rootDir: string; slug: string; dir: string }> {
		const { getMemoryRoot } = await import("../memories");
		const { getMemoriesDir } = await import("@musepi/pi-utils");
		const agentDir = getAgentDir();
		const rootDir = getMemoriesDir(agentDir);
		const cwd = typeof p.cwd === "string" && p.cwd.length > 0 ? path.resolve(p.cwd) : this.#host.cwd();
		const slug =
			typeof p.slug === "string" &&
			p.slug.startsWith("--") &&
			p.slug.endsWith("--") &&
			!p.slug.includes("..") &&
			fs.existsSync(path.join(rootDir, p.slug))
				? p.slug
				: path.basename(getMemoryRoot(agentDir, cwd));
		return { rootDir, slug, dir: path.join(rootDir, slug) };
	}

	/** Bridge handed to the `schedule_task` tool on every session create
	 *  (P1 第十刀：实现归 ScheduleService，此处为薄委托）。 */
	scheduledTaskHandle(sessionCwd: string): ScheduledTaskHandle {
		return this.#services.get<ScheduleService>("schedule").taskHandle(sessionCwd);
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
			const event = {
				type: "extensions.reloaded",
				extensionPath: entryPath,
				removedTools: result.removedTools,
				errors: result.errors,
				deferred: result.deferred,
				at: Date.now(),
			} as unknown as WireAgentEvent;
			// Same seq authority as every other kind:"event" envelope: journal
			// it + apply it so the broadcast seq, the journal record and the
			// view cursor stay in one numbering space (the projection no-ops
			// on the unknown type; replay is equally inert).
			const seq = live.journal ? live.journal.append(event) : ++live.seq;
			live.view.apply(event);
			for (const send of live.subscribers.values()) {
				try {
					send({ kind: "event", seq, payload: event });
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
		const known = await this.#services.get<ExtensionService>("extensions").getExtensions();
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
				//
				// Optional campaign reward card: <agentDir>/reward.json
				// (id + amount required) rides along in both branches; the
				// GUI renders it as the celebratory ticket overlay. Absent
				// or malformed → no reward, never a startup error.
				const readReward = async (): Promise<Record<string, unknown> | null> => {
					try {
						const raw = JSON.parse(await Bun.file(path.join(getAgentDir(), "reward.json")).text()) as Record<
							string,
							unknown
						>;
						if (typeof raw.id === "string" && raw.id.length > 0 && typeof raw.amount === "number") return raw;
						return null;
					} catch {
						return null;
					}
				};
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
					const reward = await readReward();
					return sel || reward ? { markdown: sel?.markdown, latestVersion: sel?.latestVersion, reward } : null;
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
				const reward = await readReward();
				return changelog || reward
					? {
							markdown: changelog?.markdown,
							latestVersion: changelog?.latestVersion,
							locale,
							reward,
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
						// The release workflow ships notes as a plain string (the newest
						// CHANGELOG.musepi section, bilingual-mixed); the {zh,en} shape
						// is reserved for a future split manifest. Pass either through.
						notes?: string | { zh?: string; en?: string };
					};
					const latest = typeof data.version === "string" ? data.version : undefined;
					const currentVersion = process.env.MUSEPI_VERSION ?? VERSION;
					const notes =
						typeof data.notes === "string"
							? data.notes
							: data.notes && typeof data.notes === "object"
								? data.notes
								: null;
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
				const cronIds = this.#services.get<ScheduleService>("schedule").sessionIds();
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
						// 会话预设 id（null = 未设预设）：侧栏悬浮卡的模式行。
						modeId: r.modeId ?? undefined,
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
								? this.#services.get<ViewStoreService>("views").firstUserMessage(r.sessionId)
								: undefined),
					};
				});
			}
			case "history.messages": {
				// One session's message rows (history viewer right pane) —
				// straight from the materialized view-store, no session
				// activation required.（实现归 ViewStoreService，行为不变）
				return this.#services.get<ViewStoreService>("views").messages(params ?? {});
			}
			case "tray.state": {
				// Menu-bar tray snapshot (openchamber tray parity): the
				// session list plus live activity, pending approvals (inline
				// Allow/Deny in the tray menu) and usage — one round-trip
				// per 5s poll, so the tray never fans out RPCs.
				const cronIds = this.#services.get<ScheduleService>("schedule").sessionIds();
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
							? this.#services.get<ViewStoreService>("views").firstUserMessage(r.sessionId)
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
				// 实现归 BrowserService（共享 Chromium 面板 RPC 语义不变）。
				return this.#services.get<BrowserService>("browser").endpoint();
			}
			case "browser.tabs": {
				return this.#services.get<BrowserService>("browser").tabs();
			}
			case "browser.screenshot": {
				return this.#services.get<BrowserService>("browser").screenshot((params ?? {}) as { targetId: string });
			}
			case "browser.extensions": {
				return this.#services.get<BrowserService>("browser").extensions();
			}
			case "browser.relayInstall": {
				return this.#services.get<BrowserService>("browser").relayInstall();
			}
			case "browser.relayStatus": {
				return this.#services.get<BrowserService>("browser").relayStatus();
			}
			case "browser.relayUninstall": {
				return this.#services.get<BrowserService>("browser").relayUninstall();
			}
			case "browser.importChrome": {
				return this.#services.get<BrowserService>("browser").importChrome();
			}
			case "browser.clearCache": {
				return this.#services.get<BrowserService>("browser").clearCache();
			}
			case "browser.clearAll": {
				return this.#services.get<BrowserService>("browser").clearAll();
			}
			case "session.tree": {
				// Cross-session tree (OMP /tree): sessions fork from a parent
				// (parentId) into a hierarchy. Roots have no parent.
				const rows = await this.#host.knownSessions();
				const cronIds = this.#services.get<ScheduleService>("schedule").sessionIds();
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
							? this.#services.get<ViewStoreService>("views").firstUserMessage(r.sessionId)
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
				// Cross-session message search（实现归 ViewStoreService，
				// 分组语义不变：matches 全量 + 按会话计数）。
				return this.#services.get<ViewStoreService>("views").search(params ?? {});
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
				// 工作区文件内容索引查询归 FileService（索引导线宿主懒创建）。
				return this.#services
					.get<FileService>("files")
					.searchIndex((params ?? {}) as { query?: string; limit?: number });
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
				// 实现归 ExtensionService（扩展/插件控制面语义不变）。
				return this.#services.get<ExtensionService>("extensions").listPlugins();
			}
			case "plugins.packages": {
				return this.#services.get<ExtensionService>("extensions").pluginPackages();
			}
			case "plugins.setEnabled": {
				return this.#services.get<ExtensionService>("extensions").setPluginEnabled(params ?? {});
			}
			case "marketplace.list": {
				// 实现归 MarketplaceService（marketplace/skills 面语义不变）。
				return this.#services.get<MarketplaceService>("marketplace").list();
			}
			case "marketplace.install": {
				return this.#services.get<MarketplaceService>("marketplace").install(params ?? {});
			}
			case "marketplace.remove": {
				return this.#services.get<MarketplaceService>("marketplace").remove(params ?? {});
			}
			case "skills.list": {
				return this.#services.get<MarketplaceService>("marketplace").listSkills();
			}
			case "skills.delete": {
				return this.#services.get<MarketplaceService>("marketplace").deleteSkill(params ?? {});
			}
			case "skills.install": {
				return this.#services.get<MarketplaceService>("marketplace").installSkill(params ?? {});
			}
			case "skills.read": {
				return this.#services.get<MarketplaceService>("marketplace").readSkill(params ?? {});
			}
			case "skills.marketplace.query": {
				return this.#services.get<MarketplaceService>("marketplace").querySkillMarket(params ?? {});
			}
			case "skills.marketplace.categories": {
				return this.#services.get<MarketplaceService>("marketplace").skillCategories();
			}
			case "skills.marketplace.featured": {
				return this.#services.get<MarketplaceService>("marketplace").featuredSkills(params ?? {});
			}
			case "skills.marketplace.detail": {
				return this.#services.get<MarketplaceService>("marketplace").skillDetail(params ?? {});
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
				// 实现归 ExtensionService（扩展/插件控制面语义不变）。
				return this.#services.get<ExtensionService>("extensions").list();
			}
			case "extensions.raw": {
				return this.#services.get<ExtensionService>("extensions").raw(params ?? {});
			}
			case "extensions.setEnabled": {
				return this.#services.get<ExtensionService>("extensions").setEnabled(params ?? {});
			}
			case "extensions.setForceEnabled": {
				return this.#services.get<ExtensionService>("extensions").setForceEnabled(params ?? {});
			}
			case "events.subscribe": {
				// 委托 EventService（P1 服务抽取；原实现搬至
				// services/event-service.ts，行为不变）。全局（非会话）事件：
				// extensions.changed（HMR——扩展源/配置变更立即使缓存失效，
				// 渲染层即时刷新槽位/面板，不等下一轮询）。
				return this.#services.get<EventService>("events").subscribe(conn);
			}
			case "extensions.setProviderEnabled": {
				// 实现归 ExtensionService（扩展/插件控制面语义不变）。
				return this.#services.get<ExtensionService>("extensions").setProviderEnabled(params ?? {});
			}
			case "ext.call": {
				return this.#services.get<ExtensionService>("extensions").call(params ?? {});
			}
			case "setup.status": {
				// 上手就绪态聚合（欢迎页状态感知空态的数据源）：供应商/模式/扩展
				// 配置状态的只读汇总。纯读、零新增写路径；扩展数复用
				// #getExtensions 的 10s 缓存不触发扫描，模式数复用
				// ensureModeTemplates 既有幂等初始化。GUI 侧刷新走既有
				// providers/extensions/modes 广播事件重拉，无需新事件。
				const registry = await this.#host.ensureRegistry();
				const storage = registry?.authStorage;
				const oauthLoggedIn = storage
					? getOAuthProviders().some(info => storage.has(info.storeCredentialsAs ?? info.id))
					: false;
				const apiConfigured = storage ? getBundledProviders().some(id => storage.has(id)) : false;
				// 自定义供应商（models.yml providers 块）与 models.listCustom 同源
				// 读取；文件缺失/损坏按 0 处理——就绪态不做诊断，只回答"有没有"。
				let customCount = 0;
				try {
					const raw = fs.readFileSync(ModelsConfigFile.path(), "utf8");
					const parsed = YAML.parse(raw) as { providers?: Record<string, unknown> } | null;
					customCount = Object.keys(parsed?.providers ?? {}).length;
				} catch {
					// no models.yml yet
				}
				const model: "ready" | "none" = oauthLoggedIn || apiConfigured || customCount > 0 ? "ready" : "none";
				const { listModeIds, ensureModeTemplates } = await import("../presets/resolve");
				const modesDir = this.#modesDir();
				ensureModeTemplates(modesDir);
				const modeCount = listModeIds(modesDir).length;
				const extensions = await this.#services.get<ExtensionService>("extensions").getExtensions();
				const active = extensions.filter(e => e.state === "active").length;
				const disabled = extensions.filter(e => e.state !== "active").length;
				return {
					model,
					providers: { oauthLoggedIn, apiConfigured, customCount },
					modes: { count: modeCount },
					extensions: { active, disabled },
				};
			}
			case "modes.list": {
				// 预设中心数据源(docs/archive/modes-plan.md §7):摘要列表,含继承链与
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
				for (const em of await collectExtensionModes(
					await this.#services.get<ExtensionService>("extensions").getExtensions(),
					this.#host.cwd(),
				)) {
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
				const knownExtensions = (await this.#services.get<ExtensionService>("extensions").getExtensions()).map(
					e => e.id,
				);
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
				this.#services.get<EventService>("events").broadcastModesChanged();
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
				this.#services.get<EventService>("events").broadcastModesChanged();
				return { ok: true };
			}
			case "modes.validate": {
				const { loadModeFile, resolveMode, validateMode, MODE_ID_PATTERN } = await import("../presets/resolve");
				const p = (params ?? {}) as { id: string };
				if (!MODE_ID_PATTERN.test(p.id)) return { valid: false, errors: [`invalid mode id: ${p.id}`] };
				const dir = this.#modesDir();
				const knownExtensions = (await this.#services.get<ExtensionService>("extensions").getExtensions()).map(
					e => e.id,
				);
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
				// 实现归 BoardService（boards 存储语义不变）。
				return this.#services.get<BoardService>("boards").list();
			}
			case "board.save": {
				return this.#services.get<BoardService>("boards").save((params ?? {}) as { boards?: unknown });
			}
			case "cron.list": {
				// 实现归 ScheduleService（cron 状态机语义不变）。
				return this.#services.get<ScheduleService>("schedule").list();
			}
			case "cron.upsert": {
				return this.#services.get<ScheduleService>("schedule").upsert(params ?? {});
			}
			case "cron.runs": {
				return this.#services.get<ScheduleService>("schedule").runs(params ?? {});
			}
			case "cron.nextRuns": {
				return this.#services.get<ScheduleService>("schedule").nextRuns(params ?? {});
			}
			case "cron.delete": {
				return this.#services.get<ScheduleService>("schedule").deleteTask(params ?? {});
			}
			case "cron.toggle": {
				return this.#services.get<ScheduleService>("schedule").toggle(params ?? {});
			}
			case "cron.runNow": {
				return this.#services.get<ScheduleService>("schedule").runNow(params ?? {});
			}
			case "widget.schema": {
				// 实现归 BoardService（agent 侧 widget schema parity 不变）。
				return this.#services.get<BoardService>("boards").schema();
			}
			case "widget.data": {
				// Daemon 侧数据源代理归 BoardService（fx-rates 软错误约定不变）。
				return this.#services.get<BoardService>("boards").data(params ?? {});
			}
			case "git.log": {
				// Recent commit history for the right-pane git view.
				// Runs git in the caller's session cwd (params.cwd), not the
				// daemon cwd — the GUI passes snap.state.cwd.
				//
				// Structured mode (default): `git log --all --topo-order`
				// with \x1f-separated fields / \x1e-separated records — full
				// hash, short hash, author, author timestamp, decorations
				// (%D) and parents — parsed into typed commits for the GUI's
				// lane-solving graph renderer. `limit`/`skip` page the log
				// (load-more fetches the next slice); one extra record beyond
				// `limit` yields `hasMore`. `graph: true` keeps the legacy
				// `--graph --oneline` ASCII string. Async spawn with a 10s
				// kill guard — NOT spawnSync, which froze the whole daemon
				// event loop once (see git.status).
				const p = (params ?? {}) as { cwd?: unknown; graph?: unknown; limit?: unknown; skip?: unknown };
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
				if (p.graph === true) {
					const res = await run(["log", "--graph", "--all", "--oneline", "--decorate", "-n", "60"]);
					if (res.exitCode !== 0) return { error: "not a git repository" };
					return { graph: res.stdout.trim() };
				}
				const limit = Math.min(
					500,
					Math.max(10, typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.floor(p.limit) : 100),
				);
				const skip = typeof p.skip === "number" && p.skip > 0 ? Math.floor(p.skip) : 0;
				// Remote names distinguish `origin/main`-style remote refs
				// from same-shaped local branches (`feature/x`) in %D.
				const [logRes, remotesRes] = await Promise.all([
					run([
						"log",
						"--all",
						"--topo-order",
						// %H %h %an %at %D %P %s — records end with \x1e.
						"--pretty=format:%H%x1f%h%x1f%an%x1f%at%x1f%D%x1f%P%x1f%s%x1e",
						`--max-count=${limit + 1}`,
						...(skip > 0 ? [`--skip=${skip}`] : []),
					]),
					run(["remote"]),
				]);
				if (logRes.exitCode !== 0) return { error: "not a git repository" };
				const remoteNames =
					remotesRes.exitCode === 0
						? remotesRes.stdout
								.split("\n")
								.map(r => r.trim())
								.filter(Boolean)
						: [];
				const commits: {
					hash: string;
					shortHash: string;
					author: string;
					timestamp: number;
					refs: { kind: "head" | "local" | "remote" | "tag"; name: string }[];
					parents: string[];
					subject: string;
				}[] = [];
				for (const record of logRes.stdout.split("\x1e")) {
					const trimmed = record.replace(/^\n/, "");
					if (!trimmed.trim()) continue;
					const [hash, shortHash, author, at, deco, parentsRaw, subject] = trimmed.split("\x1f");
					if (!hash || !shortHash) continue;
					const refs: { kind: "head" | "local" | "remote" | "tag"; name: string }[] = [];
					for (const d of (deco ?? "").split(/,\s*/)) {
						const ref = d.trim();
						if (!ref) continue;
						const arrow = /^HEAD -> (.+)$/.exec(ref);
						if (arrow) refs.push({ kind: "head", name: arrow[1]! });
						else if (ref === "HEAD") refs.push({ kind: "head", name: "HEAD" });
						else if (ref.startsWith("tag: ")) refs.push({ kind: "tag", name: ref.slice(5) });
						else if (remoteNames.some(r => ref.startsWith(`${r}/`))) refs.push({ kind: "remote", name: ref });
						else refs.push({ kind: "local", name: ref });
					}
					commits.push({
						hash,
						shortHash,
						author: author ?? "",
						timestamp: Number.parseInt(at ?? "0", 10) * 1000,
						refs,
						parents: (parentsRaw ?? "").split(" ").filter(Boolean),
						subject: subject ?? "",
					});
				}
				const hasMore = commits.length > limit;
				return { commits: hasMore ? commits.slice(0, limit) : commits, hasMore };
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
					const proc = Bun.spawnSync({
						cmd: ["git", ...args],
						cwd,
						stdout: "pipe",
						stderr: "pipe",
						windowsHide: true,
					});
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
				// `numstat: true` additionally sums line insertions/deletions
				// (`diff HEAD --numstat`, staged+unstaged vs HEAD) for the
				// floating status card's +N/−M badge.
				//
				// Async spawns (NOT spawnSync — that froze the whole daemon
				// event loop, stalling every session's turn while git ran),
				// and the probes run concurrently instead of serially.
				const p = (params ?? {}) as { ignored?: boolean; numstat?: boolean; cwd?: unknown };
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
				const [root, branchRaw, aheadRaw, statusRaw, numstatRaw] = await Promise.all([
					run(["rev-parse", "--show-toplevel"]),
					run(["branch", "--show-current"]),
					run(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]),
					run(["status", "--porcelain=v1", ...(p.ignored ? ["--ignored"] : [])]),
					p.numstat === true ? run(["diff", "HEAD", "--numstat"]) : Promise.resolve(null),
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
				// numstat sums (binary files report "-" — skip them).
				let added: number | undefined;
				let deleted: number | undefined;
				if (numstatRaw && numstatRaw.exitCode === 0) {
					added = 0;
					deleted = 0;
					for (const line of numstatRaw.stdout.split("\n")) {
						const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
						if (!m) continue;
						added += m[1] === "-" ? 0 : Number.parseInt(m[1], 10);
						deleted += m[2] === "-" ? 0 : Number.parseInt(m[2], 10);
					}
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
					added,
					deleted,
				};
			}
			case "git.stage": {
				// Stage paths into the index (changes panel + button).
				const p = (params ?? {}) as Record<string, unknown>;
				const paths = Array.isArray(p.paths) ? (p.paths as string[]).filter(x => typeof x === "string") : [];
				const cwd = path.resolve(
					typeof p.cwd === "string" && (p.cwd as string).length > 0 ? (p.cwd as string) : this.#host.cwd(),
				);
				const proc = Bun.spawn({
					cmd: ["git", "add", "--", ...paths],
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
				// Switch the repo's branch (welcome branch selector, status-card
				// branch menu). Caller's cwd; uncommitted changes are git's
				// problem (checkout fails with a clear stderr, surfaced to the
				// GUI toast). `create` → `checkout -b` (create + check out in
				// one step, status-card "create branch" parity).
				const p = (params ?? {}) as { cwd?: unknown; branch?: unknown; create?: unknown };
				const branch = typeof p.branch === "string" && p.branch.length > 0 ? p.branch : "";
				if (!branch) throw new Error("branch required");
				const cwd = path.resolve(typeof p.cwd === "string" && p.cwd.length > 0 ? p.cwd : this.#host.cwd());
				const proc = Bun.spawnSync({
					cmd: p.create === true ? ["git", "checkout", "-b", branch] : ["git", "checkout", branch],
					cwd,
					stdout: "pipe",
					stderr: "pipe",
					windowsHide: true,
				});
				if (proc.exitCode !== 0) return { error: proc.stderr.toString().trim() || "git checkout failed" };
				return { ok: true };
			}
			case "worktree.create": {
				// Create (or reuse) an isolated git worktree for the caller's repo
				// and return its path. The client then re-roots the session there
				// with the existing `/move` slash command — that pairing is the
				// GUI's "move to new worktree" action. Layout follows the other
				// agent-managed worktrees (~/.musepi/wt, `worktree.base` aware).
				const p = (params ?? {}) as {
					cwd?: unknown;
					branch?: unknown;
					startPoint?: unknown;
					createBranch?: unknown;
				};
				const cwd = path.resolve(typeof p.cwd === "string" && p.cwd.length > 0 ? p.cwd : this.#host.cwd());
				try {
					return await createSessionWorktree({
						cwd,
						...(typeof p.branch === "string" && p.branch.trim() ? { branch: p.branch } : {}),
						...(typeof p.startPoint === "string" && p.startPoint.trim() ? { startPoint: p.startPoint } : {}),
						...(typeof p.createBranch === "boolean" ? { createBranch: p.createBranch } : {}),
					});
				} catch (err) {
					// Surfaced verbatim (not a git repo / branch exists / path
					// collision) — the dialog shows it as-is.
					return { error: err instanceof Error ? err.message : String(err) };
				}
			}
			case "remote.hosts": {
				// 实现归 RemoteService（SSH 远程主机面语义不变）。
				return this.#services.get<RemoteService>("remote").hosts();
			}
			case "remote.hostAdd": {
				// 实现归 RemoteService（SSH 远程主机面语义不变）。
				return this.#services.get<RemoteService>("remote").hostAdd(
					(params ?? {}) as {
						name?: unknown;
						host?: unknown;
						username?: unknown;
						port?: unknown;
						keyPath?: unknown;
					},
				);
			}
			case "remote.connect": {
				// 实现归 RemoteService（SSH 远程主机面语义不变）。
				return this.#services.get<RemoteService>("remote").connect((params ?? {}) as { name?: unknown });
			}
			case "remote.browse": {
				// 实现归 RemoteService（SSH 远程主机面语义不变）。
				return this.#services
					.get<RemoteService>("remote")
					.browse((params ?? {}) as { name?: unknown; path?: unknown });
			}
			case "remote.disconnect": {
				// 实现归 RemoteService（SSH 远程主机面语义不变）。
				return this.#services.get<RemoteService>("remote").disconnect((params ?? {}) as { name?: unknown });
			}
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
					const proc = Bun.spawn({ cmd: [gh, ...args], stdout: "pipe", stderr: "pipe", env, windowsHide: true });
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
			case "session.turns": {
				// Full-turn index over the materialized snapshot
				// (session.history parity): the client tails 200 entries
				// and pages older chunks in, so its own buildTurnIndex only
				// covers the LOADED window — the rail dropped unloaded
				// turns on long sessions. Scanning the in-memory snapshot
				// here costs the same as session.history and returns one
				// ~120B record per turn (20k turns ≈ 2.4MB, loopback).
				const p = (params ?? {}) as { sessionId?: unknown };
				if (typeof p.sessionId !== "string") throw new Error("sessionId required");
				const snap = (await this.#host.snapshot(p.sessionId)) as { entries?: unknown[] } | null;
				const entries = Array.isArray(snap?.entries) ? snap.entries : [];
				return { turns: buildDaemonTurnIndex(entries), totalEntries: entries.length };
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
			case "session.catchup": {
				// 委托 EventService（P1 服务抽取；入参校验在服务内，补推实现
				// 仍归 DaemonSessionHost.catchupFrom——journal 序/session tree
				// 事件序的载体，P1 不动）。M1.4 gap fill：客户端事件流掉帧
				//（重连竞态/batcher 丢失）后按水位请求补推，delta 帧走常规
				// 推送通道（batcher），响应体保持轻量。
				return this.#services.get<EventService>("events").catchup(params ?? {}, conn);
			}
			case "session.thinking": {
				// Mobile parity of the TUI thinking selector: sanitize through
				// the same parser as --thinking, apply to the live session.
				// The resulting thinking_level_change event re-reaches clients
				// through the normal session event stream.
				const p = (params ?? {}) as { sessionId?: unknown; level?: unknown };
				if (typeof p.sessionId !== "string") throw new Error("sessionId required");
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error("unknown session");
				live.agentSession.setThinkingLevel(
					parseConfiguredThinkingLevel(typeof p.level === "string" ? p.level : undefined),
				);
				return { ok: true };
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
					deliverAs?: "prompt" | "steer" | "followUp" | "continue";
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
				// TUI "." / "c" continue parity: the shortcut's payload is the
				// hidden developer directive (manualContinuePrompt), not the
				// user's literal "." — same text the TUI input-controller
				// sends. The GUI passes the raw shortcut and the daemon is the
				// single authority for the directive text.
				const sendContent = p.deliverAs === "continue" ? manualContinuePrompt : content;
				this.#host.touch(p.sessionId);
				// TUI parity: auto-generate the session title from the first
				// user message (input-controller calls maybeStartTitleGeneration
				// on first submit). The gate inside is idempotent — a session
				// that already has a name (or a low-signal first message, or
				// PI_NO_TITLE) is a no-op — so calling it every send is safe.
				// The GUI's Settings → 会话 → 自动生成会话标题 toggle gates it.
				// Continue shortcuts are synthetic directives — never a title
				// source.
				if (live.autoTitle && p.deliverAs !== "continue") {
					const textPart =
						typeof sendContent === "string"
							? sendContent
							: (sendContent.find(c => c.type === "text")?.text ?? "");
					if (textPart) live.agentSession.maybeStartTitleGeneration(textPart);
				}
				// Fire-and-forget: prompt()'s promise only settles at end-of-turn
				// (minutes for a long run), while the GUI client enforces a hard
				// 15s RPC timeout — awaiting the turn here always surfaced a false
				// "request timeout: session.send" banner while the agent kept
				// working. Turn progress and errors already flow to clients via
				// the session event stream; log background failures instead.
				void live.agentSession.sendUserMessage(sendContent, options).catch(err => {
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
				// History sessions (idle-closed / pre-restart) reactivate on
				// demand, exactly like session.abort / collab.start. Requiring
				// an already-live session made every branch gesture fail on a
				// session the user had merely opened from the list — the
				// transcript's 撤回/编辑/重试 buttons, the message tree, the
				// branch bar and the canvas all go through here.
				const blive = this.#host.get(bp.sessionId) ?? (await this.#host.activate(bp.sessionId).catch(() => null));
				if (!blive) throw new Error(`Unknown session: ${bp.sessionId}`);
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
							// Entries of type "message" need not carry a payload:
							// the SDK file mixes in bookkeeping records, and an
							// unguarded `e.message.role` threw
							// "undefined is not an object (evaluating 'message.role')"
							// on the first one — which surfaced to the user as the
							// 撤回/编辑/重试 buttons doing nothing at all.
							const m = e.message as
								| { role?: string; timestamp?: number | string; toolCallId?: string }
								| undefined;
							if (!m || m.role !== brole) return false;
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
				// Report where the leaf landed as a VIEW key ("role:timestamp").
				// The leaf need not be a message — model_change /
				// thinking_level_change / title records are legitimate leaves —
				// and `messageKey` dereferences `.message`, so reading it
				// unguarded threw "undefined is not an object (evaluating
				// 'message.role')" out of an otherwise successful branch. The
				// GUI saw only a failed RPC, which is why 撤回/编辑/重试 looked
				// like dead buttons (nothing moved, nothing backfilled).
				// Walk up to the nearest MESSAGE ancestor — the entry the
				// transcript tree actually keys on (same resolution as the
				// stream-event rekey above).
				const bsm = blive.agentSession.sessionManager as unknown as {
					getLeafEntry(): SessionEntry | undefined;
				};
				const bById = new Map(bentries.map(e => [e.id, e]));
				let bCursor: SessionEntry | undefined = bsm.getLeafEntry();
				const bSeen = new Set<string>();
				let bleafKey: string | null = null;
				while (bCursor && typeof bCursor.id === "string" && !bSeen.has(bCursor.id)) {
					bSeen.add(bCursor.id);
					const bRaw = bCursor as { message?: WireMessage; parentId?: string | null };
					if (bRaw.message) {
						bleafKey = messageKey(bRaw.message);
						break;
					}
					bCursor = bRaw.parentId ? bById.get(bRaw.parentId) : undefined;
				}
				// editorText is what the composer gets backfilled with. navigateTree
				// returns it when it actually moves the leaf, but it takes an early
				// no-op exit when the leaf is ALREADY at the target — which is
				// exactly the state 撤回 leaves behind, so clicking 编辑 right
				// after 撤回 backfilled nothing. Fall back to the target message's
				// own text (the 编辑契约), rather than reporting success with an
				// empty editor.
				const btarget = bentries.find(e => e.id === bsdkId) as { message?: WireMessage } | undefined;
				const btargetText =
					btarget?.message?.role === "user" ? extractEntryText({ content: btarget.message.content }) : "";
				// Active path (root → leaf) AFTER the move, in VIEW-key space.
				// The client store only holds the daemon's TAIL window
				// (TAIL_ENTRIES) and re-fetched resume snapshots return the
				// newest 200 rows — on a long session a rewind to a node far
				// above the tail re-anchored the client onto the WRONG data
				// (the old tail stayed on screen, 撤回 looked like a no-op).
				// Shipping the path lets subscribers re-anchor locally. Same
				// parentId convention the materialized view uses: message
				// entries only, parentId = nearest MESSAGE ancestor's view
				// key (hex ids rewritten via messageKey), non-message records
				// (model_change / compaction) skipped. Truncated from the
				// LEAF end to TAIL_ENTRIES so the payload stays bounded; a
				// truncated root's parentId then points outside the payload,
				// which clients read exactly like a cut tail-window chain.
				const bpathInfo = ((): { path: string[]; pathEntries: SessionEntry[] } => {
					const bySdkId = new Map(bentries.map(e => [e.id, e]));
					const sdkSeen = new Set<string>();
					let sdkCursor: SessionEntry | undefined = bsm.getLeafEntry();
					const sdkPath: SessionEntry[] = [];
					while (sdkCursor && typeof sdkCursor.id === "string" && !sdkSeen.has(sdkCursor.id)) {
						sdkSeen.add(sdkCursor.id);
						sdkPath.unshift(sdkCursor);
						sdkCursor = sdkCursor.parentId ? bySdkId.get(sdkCursor.parentId) : undefined;
					}
					const pathEntries: SessionEntry[] = [];
					let parentViewKey: string | null = null;
					for (const e of sdkPath) {
						const m = (e as { message?: WireMessage }).message;
						if (!m) continue; // non-message record — not a path row
						const viewKey = messageKey(m);
						pathEntries.push({
							type: "message",
							id: viewKey,
							parentId: parentViewKey,
							timestamp: new Date(m.timestamp).toISOString(),
							message: m,
						} as SessionEntry);
						parentViewKey = viewKey;
					}
					const windowed = pathEntries.slice(-TAIL_ENTRIES);
					return { path: windowed.map(e => e.id), pathEntries: windowed };
				})();
				// 撤回/切分支广播: navigateTree 只移动 SDK 树的 leaf 指针 —
				// 不 append 条目、不走 agent 事件流,而 GUI store 只从事件流
				// 学习(leaf_moved 之前撤回/切分支后订阅端永远停在旧 active
				// path)。publishWireEvent 保证三件事: journal append(seq 连续,
				// M1.4 catchup 可原样重放)、view.apply(对无投影的类型是安全
				// no-op)、订阅端 fan-out。leafId 与下方返回值同源(null =
				// 撤到根,首条用户消息的 parentId 在 wire 快照里恒为 null)。
				blive.publishWireEvent({
					type: "session_leaf_moved",
					leafId: bleafKey,
					path: bpathInfo.path,
					pathEntries: bpathInfo.pathEntries,
				});
				return {
					ok: true,
					leafId: bleafKey,
					path: bpathInfo.path,
					pathEntries: bpathInfo.pathEntries,
					editorText: bresult.editorText ?? (btargetText || null),
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
				const bsm = (
					blive.agentSession as unknown as {
						sessionManager: { getLeafId(): string | null };
					}
				).sessionManager;
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
				const bnewId = (
					blive.agentSession as unknown as {
						sessionManager: { getSessionId(): string };
					}
				).sessionManager.getSessionId();
				if (bnewId && bnewId !== bp.sessionId) {
					this.#host.rekeySession(bp.sessionId, bnewId);
				}
				return { ok: true, sessionId: bnewId ?? null, sessionFile: bresult.sessionFile ?? null };
			}
			case "session.ephemeralAsk": {
				// GUI /btw + ask-popover side question (TUI /btw parity): run an
				// ephemeral side-channel turn WITHOUT touching the session
				// transcript (the same runEphemeralTurn path the idle recap and
				// IRC steers use). The side channel needs an active model and is
				// safe while the main turn is mid-tool-call. There is no
				// cross-request cancel — the GUI's stop button only discards the
				// reply locally, the daemon turn still completes.
				const p = (params ?? {}) as { sessionId: string; promptText: string };
				if (typeof p.sessionId !== "string" || typeof p.promptText !== "string" || !p.promptText.trim()) {
					throw new Error("sessionId and promptText required");
				}
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				const { replyText } = await live.agentSession.runEphemeralTurn({ promptText: p.promptText });
				return { replyText };
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
				const head = titleSlot ? `${titleSlot}\n` : "";
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
							// Canonical label: AgentSession.abort matches it exactly to
							// flag the turn as a user interrupt (advisor auto-resume
							// suppression + the transcript's interrupt card). A
							// near-miss string silently degrades to a generic abort.
							await live.agentSession.abort({ reason: USER_INTERRUPT_LABEL });
						},
					},
				};
				const transport = new LocalShareManager({ port: undefined, onStatus: () => {} });
				// Tunnel mode with no sessionId shares the workspace (like
				// workspace mode); with a sessionId it shares that session.
				const collabMode: "session" | "workspace" =
					mode === "workspace" || (mode === "tunnel" && !p.sessionId) ? "workspace" : "session";
				const collabHost = new CollabHost(stubCtx as never, collabMode);
				// Tunnel shares the same loopback relay as the client-core dist;
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
					// Who is actually watching: the share panel renders this list,
					// which is the only way to tell an idle share from one with a
					// guest connected (and whether that guest may prompt).
					participants: this.#collab.host.participants.map(p => ({
						name: p.name,
						role: p.role,
						readOnly: p.readOnly === true,
					})),
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
				const { code, expiresAt } = this.#pairCodes.mint(webLink);
				await this.#ensurePairServer();
				return { code, expiresInSeconds: Math.round((expiresAt - Date.now()) / 1000), lanPort: PAIR_PORT };
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
			case "channels.unlink": {
				// 解绑: stop + drop persisted config/credentials (GUI confirm
				// dialog sits in front of this — the next start needs a fresh
				// login/QR scan).
				const p = (params ?? {}) as { kind: string };
				return this.#channels.unlink(p.kind as ChannelKind);
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
				const sessionId = imported.getSessionId();
				await imported.close();
				if (!sessionFile) throw new Error("failed to persist imported session");
				// sessionId: the GUI's import dialog groups imported sessions by
				// workspace into editable custom groups — it needs the NEW id.
				return { ok: true, sessionId, sessionFile, source, sourceId: match.id };
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
				// Canonical label (not a "user interrupt" literal): abort() matches
				// it exactly, so only this form sets the UserInterrupt flag — which
				// is what suppresses advisor auto-resume and renders the transcript's
				// interrupt card. A near-miss string reads as a generic abort.
				await live.agentSession.abort({ reason: USER_INTERRUPT_LABEL });
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
				return registry.getAvailable().map(modelDetailRow);
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
				// `satisfies` (not `:`) — the wire contract in @musepi/pi-wire
				// is the single source of truth for both shells; if the shape
				// here drifts, typecheck fails instead of the UI breaking.
				const models: SttModelRow[] = await Promise.all(
					STT_MODELS.map(async m => ({ key: m.key, label: m.label, cached: await isSttModelCached(m.key) })),
				);
				return { models, downloads: [...this.#sttDownloads.keys()] } satisfies SttModelStatusResponse;
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
						this.#services.get<EventService>("events").broadcast(payload);
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
				// 实现归 TerminalService（pty 生命周期语义不变）。
				return this.#services
					.get<TerminalService>("terminal")
					.open((params ?? {}) as { cwd?: string; cols?: number; rows?: number }, conn);
			}
			case "terminal.input": {
				return this.#services
					.get<TerminalService>("terminal")
					.input((params ?? {}) as { id: string; data?: string });
			}
			case "terminal.resize": {
				return this.#services
					.get<TerminalService>("terminal")
					.resize((params ?? {}) as { id: string; cols?: number; rows?: number });
			}
			case "terminal.close": {
				return this.#services.get<TerminalService>("terminal").close((params ?? {}) as { id: string });
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
				// `tuiOnly` marks entries without an ACP/text-mode `handle` —
				// session.slashCommand reports those "tui-only", so the GUI
				// hides them (minus its own intercepted panel commands)
				// instead of letting the user fire commands that can only
				// answer "该命令仅在终端中可用".
				const { BUILTIN_SLASH_COMMANDS_INTERNAL } = await import("../slash-commands/builtin-registry");
				const { getSkillSlashCommandName } = await import("../extensibility/skills");
				const list: {
					name: string;
					description?: string;
					subcommands?: { name: string; description?: string }[];
					kind: "command" | "skill";
					category: string;
					tuiOnly: boolean;
				}[] = BUILTIN_SLASH_COMMANDS_INTERNAL.map(c => ({
					name: c.name,
					description: c.description,
					subcommands: c.subcommands?.map((sc: { name: string; description?: string }) => ({
						name: sc.name,
						description: sc.description,
					})),
					kind: "command",
					category: slashCommandCategory(c.name),
					tuiOnly: typeof c.handle !== "function",
				}));
				for (const skill of await this.#services.get<MarketplaceService>("marketplace").getSkills()) {
					list.push({
						name: getSkillSlashCommandName({ name: skill.name }),
						description: skill.description,
						kind: "skill",
						// Second badge = discovery scope (openchamber's PROJECT tag).
						category: skill.source.split(":")[1] === "project" ? "project" : "user",
						// Skills are agent-side invocations — never tui-only.
						tuiOnly: false,
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
				// Effective compaction threshold in force (issue #42): when
				// the user configured a custom soft cap (e.g.
				// compaction.thresholdTokens: 300_000), every frontend usage
				// display can use it as the ring/status denominator instead
				// of the physical context window.
				let thresholdTokens: number | null = null;
				if (cw > 0) {
					const comp = live.agentSession.settings.getGroup("compaction") as
						| { enabled?: boolean; strategy?: string }
						| undefined;
					if (comp?.enabled && comp.strategy !== "off") {
						const threshold = resolveThresholdTokens(cw, comp as Parameters<typeof resolveThresholdTokens>[1]);
						thresholdTokens = threshold > 0 ? threshold : null;
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
				// Session token/cost summary + prompt-cache hit rate (issue #8,
				// TUI `cache_hit` segment parity). The GUI has no other source
				// for either: the context ring is window-percentage only, and
				// settings → agent stats is easy to miss. Hit rate is computed
				// here with the TUI's own helper so the two cannot disagree.
				const tokenStats = live.agentSession.sessionManager?.getUsageStatistics?.() ?? null;
				const hitRate = cacheHitRate(tokenStats);
				const tokenSummary =
					tokenStats || hitRate !== null
						? {
								input: tokenStats?.input ?? 0,
								output: tokenStats?.output ?? 0,
								cacheRead: tokenStats?.cacheRead ?? 0,
								cacheWrite: tokenStats?.cacheWrite ?? 0,
								totalTokens: tokenStats?.totalTokens ?? 0,
								cost: tokenStats?.cost ?? 0,
								cacheHitRate: hitRate,
							}
						: null;
				return snapcompact ||
					breakdown ||
					modelRef ||
					autoCompactBufferTokens > 0 ||
					tokenSummary ||
					thresholdTokens !== null
					? {
							...usage,
							...(modelRef ? { model: modelRef } : {}),
							...(snapcompact ? { snapcompact } : {}),
							...(breakdown ? { breakdown } : {}),
							...(tokenSummary ? { usage: tokenSummary } : {}),
							...(thresholdTokens !== null ? { thresholdTokens } : {}),
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
				// 会话预设 id（design 等模式驱动的 composer UI 依赖它判型）。
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
					modeId: live.modeId ?? null,
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
			case "memory.workspace": {
				// 设置 → 记忆的工作区记忆卡(ZCode 记忆面板 parity):记忆根下的
				// 各工作区目录 + 选中工作区的 .md 记忆文件列表(mtime 降序)。
				// 目录缺失时列出空集(该工作区还没有记忆产物)。
				const p = (params ?? {}) as { cwd?: unknown; slug?: unknown };
				const { rootDir, slug, dir } = await this.#memoryWorkspaceDir(p);
				const workspaces: string[] = [];
				try {
					for (const e of fs.readdirSync(rootDir, { withFileTypes: true })) {
						if (e.isDirectory() && e.name.startsWith("--") && e.name.endsWith("--")) workspaces.push(e.name);
					}
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
				}
				const files: Array<{ name: string; size: number; mtimeMs: number }> = [];
				try {
					for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
						if (!e.isFile() || !e.name.toLowerCase().endsWith(".md")) continue;
						const st = fs.statSync(path.join(dir, e.name));
						files.push({ name: e.name, size: st.size, mtimeMs: st.mtimeMs });
					}
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
				}
				files.sort((a, b) => b.mtimeMs - a.mtimeMs);
				return { root: dir, slug, workspaces: workspaces.sort(), files };
			}
			case "memory.workspaceRead": {
				// 读取一个记忆 .md 供面板内查看。name 只接受根内裸文件名,
				// 上限 512KB(面板阅读用,不是编辑器)。
				const p = (params ?? {}) as { cwd?: unknown; slug?: unknown; name?: unknown };
				const { dir } = await this.#memoryWorkspaceDir(p);
				const name = typeof p.name === "string" ? p.name : "";
				if (
					!name ||
					name.includes("/") ||
					name.includes("\\") ||
					name.includes("..") ||
					!name.toLowerCase().endsWith(".md")
				) {
					throw new Error("invalid memory file name");
				}
				const target = path.join(dir, name);
				const st = fs.statSync(target);
				if (!st.isFile()) throw new Error("not a file");
				if (st.size > 512 * 1024) throw new Error("memory file too large to display");
				return { name, content: fs.readFileSync(target, "utf8"), mtimeMs: st.mtimeMs };
			}
			case "memory.workspaceReveal": {
				// 在文件管理器中显示一个记忆文件(缺省显示工作区记忆目录)。
				// daemon 宿主侧执行 —— 远程 daemon 的 GUI 会在远程机器上打开,
				// 与其它 daemon 侧路径语义一致。
				const p = (params ?? {}) as { cwd?: unknown; slug?: unknown; name?: unknown };
				const { dir } = await this.#memoryWorkspaceDir(p);
				let target = dir;
				if (typeof p.name === "string" && p.name) {
					const name = p.name;
					if (
						name.includes("/") ||
						name.includes("\\") ||
						name.includes("..") ||
						!name.toLowerCase().endsWith(".md")
					) {
						throw new Error("invalid memory file name");
					}
					target = path.join(dir, name);
					if (!fs.existsSync(target)) throw new Error(`Unknown memory file: ${name}`);
				}
				if (process.platform === "win32") {
					Bun.spawn(["explorer.exe", `/select,${target}`], { stdout: "ignore", stderr: "ignore" });
				} else if (process.platform === "darwin") {
					Bun.spawn(["open", "-R", target], { stdout: "ignore", stderr: "ignore" });
				} else {
					Bun.spawn(["xdg-open", path.dirname(target)], { stdout: "ignore", stderr: "ignore" });
				}
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
					// Guided kickoff image attachments (same wire shape as
					// session.send): they ride on the synthetic interview kickoff.
					images?: { type: "image"; data: string; mimeType: string }[];
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
						// Pre-checks mirror the TUI's handleGuidedGoalCommand in
						// the same order (plan → vibe → goal.enabled →
						// active/paused goal) so both entry points reject the
						// same states with the same wording.
						if (g.getPlanModeState?.()?.enabled === true) {
							throw new Error("Exit plan mode first.");
						}
						if (g.getVibeModeState?.()?.enabled === true) {
							throw new Error("Exit vibe mode first.");
						}
						if (!g.settings.get("goal.enabled")) {
							throw new Error("Goal mode is disabled. Enable it in settings (goal.enabled).");
						}
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
						// Image attachments (welcome/session composer chips) ride
						// on the kickoff — TUI input.images parity.
						const images = Array.isArray(p.images) && p.images.length > 0 ? p.images : undefined;
						try {
							if (g.isStreaming) {
								await g.followUp(kickoff, images, { synthetic: true });
							} else {
								await g.prompt(kickoff, images ? { synthetic: true, images } : { synthetic: true });
							}
						} catch (error) {
							// AgentBusyError during the race between the streaming
							// check and prompt(): queue instead of failing.
							if (!(error instanceof AgentBusyError)) throw error;
							await g.followUp(kickoff, images, { synthetic: true });
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
					 *  planning conversation before the approved-prompt dispatch. */
					compact?: boolean;
					/** Start the approved prompt in a fresh context (TUI default
					 *  clear-then-execute parity). Falls back to context-preserved
					 *  when the session is streaming (resetSessionContext rejects). */
					fresh?: boolean;
					/** Optional execution model override (provider/id) for the
					 *  approved prompt. Passed through session.setModel before
					 *  the prompt so the chosen model applies to execution only. */
					executionModel?: { id: string; provider?: string };
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

						// Capture the pre-clear execution tool set (TUI parity):
						// approved-plan prompts require `read` to load the durable
						// local:// plan file, so force it into the restored set.
						const executionTools = [...new Set([...g.getEnabledToolNames(), "read"])];

						if (p.compact === true) {
							// Pin the reference path BEFORE compacting so the
							// approved-prompt injection can find it on the
							// post-compaction session (issue #4359).
							g.setPlanReferencePath(planFilePath);
							await g.compact(undefined, {
								internalGuidance: prompt.render(planModeCompactInstructionsPrompt, {
									planFilePath,
								}),
								// Plan approval hands control back to the user with the
								// execution model armed — it must NOT auto-resume the
								// aborted turn the way a plain mid-turn `/compact` does
								// (oh-my-pi #11873). TUI parity with #approvePlan.
								suppressContinuation: true,
							});
						}

						if (p.fresh === true) {
							// TUI "clear then execute" parity: drop the planning
							// conversation so the approved prompt runs in a fresh
							// context. resetSessionContext rejects while streaming.
							const oldLocalRoot = resolveLocalRoot(localProtocolOptions);
							const dropResult = await g.resetSessionContext();
							if (dropResult === undefined) {
								throw new Error("Wait for the current response to finish before approving in a fresh context.");
							}
							// Migrate the plan file into the new session's local
							// root so the approved prompt's local:// ref still
							// resolves (mirrors interactive-mode copyLocalArtifacts
							// + resolveLocalUrlToPath + writeFile).
							const newLocalRoot = resolveLocalRoot(localProtocolOptions);
							await copyLocalArtifacts(oldLocalRoot, newLocalRoot);
							const newPlanPath = resolveLocalUrlToPath(planFilePath, {
								getArtifactsDir: () => sessionManager.getArtifactsDir(),
								getSessionId: () => sessionManager.getSessionId(),
							});
							await fs.promises.mkdir(path.dirname(newPlanPath), { recursive: true });
							await fs.promises.writeFile(newPlanPath, content, "utf-8");
						}

						const executionModel = p.executionModel;
						if (executionModel?.id) {
							const models = g.getAvailableModels();
							const model = executionModel.provider
								? resolveProviderModelReference(executionModel.provider, executionModel.id, models)
								: models.find(m => m.id === executionModel.id);
							if (!model) throw new Error(`Unknown execution model: ${executionModel.id}`);
							await g.setModelTemporary(model);
						}

						// Restore the execution tool set (TUI parity): approved-plan
						// prompts now require `read` to load the durable plan file.
						await g.setActiveToolsByName(executionTools);

						const contextPreserved = !p.fresh;
						const approvePrompt = prompt.render(planModeApprovedPrompt, {
							planFilePath,
							contextPreserved,
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
					this.#services.get<EventService>("events").broadcastModelsChanged();
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
				this.#services.get<EventService>("events").broadcastModelsChanged();
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
				this.#services.get<EventService>("events").broadcastModelsChanged();
				return { ok: true, removed: p.credentialId !== undefined ? 1 : credentials.length };
			}
			case "media.providers": {
				// Media generation provider status (image/video tools
				// generate_image + agnes_video_gen): merges the built-in image
				// provider list with extension-registered media providers and
				// reports per-provider credential state from the shared auth
				// storage. Session-less — the storage is host-shared.
				const registry = await this.#host.ensureRegistry();
				if (!registry) throw new Error("No model registry yet — create a session first");
				const storage = registry.authStorage;
				const builtin = IMAGE_PROVIDER_CHOICES.map(choice => {
					const provider = choice.value;
					const configured = storage.hasAuth(provider);
					return {
						id: provider,
						label: choice.label,
						description: choice.description,
						kind: "image" as const,
						source: "builtin" as const,
						configured,
					};
				});
				const extensionEntries = getExtensionMediaProviders().map(config => ({
					id: config.id,
					label: config.label,
					description: config.auth.type === "apiKey" && config.auth.envVar ? `Requires ${config.auth.envVar}` : "",
					kind: config.kind,
					source: "extension" as const,
					baseUrl: config.baseUrl ?? null,
					models: config.models.map(model => model.id),
					authType: config.auth.type,
					configured: storage.hasAuth(config.id),
				}));
				return { builtin, extension: extensionEntries };
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
			case "session.queuedReorder": {
				// Drag-reorder a queued message within one group (GUI queue
				// panel parity, openchamber messageQueueStore.reorderQueue).
				// Same-group only — steering↔follow-up is a timing change,
				// not a sort. Returns the moved flag; unmatched/no-op → false.
				const p = (params ?? {}) as {
					sessionId: string;
					group?: "steering" | "followUp";
					from?: string;
					to?: string;
				};
				if (
					typeof p.sessionId !== "string" ||
					typeof p.from !== "string" ||
					!p.from ||
					typeof p.to !== "string" ||
					!p.to
				) {
					throw new Error("sessionId, from and to required");
				}
				const live = this.#host.get(p.sessionId);
				if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
				const agent = live.agentSession as unknown as {
					reorderQueuedMessage(group: "steering" | "followUp", from: string, to: string): boolean;
				};
				const moved = agent.reorderQueuedMessage(p.group === "followUp" ? "followUp" : "steering", p.from, p.to);
				return { moved };
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
				return registry.getAvailable().map(modelDetailRow);
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
					{
						provider: string;
						name: string;
						available: boolean;
						models: {
							id: string;
							name: string;
							reasoning: boolean;
							text: boolean;
							vision: boolean;
							video: boolean;
							imageGen: boolean;
							videoGen: boolean;
						}[];
					}
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
					// Same capability mapping the model picker uses (modelDetailRow),
					// so this pane can render the identical icon set per row.
					const capabilities = resolveModelCapabilities(model.id, model.input);
					group.models.push({
						id: model.id,
						name: model.name ?? model.id,
						reasoning: model.reasoning === true,
						text: capabilities.text,
						vision: capabilities.image,
						video: capabilities.video,
						imageGen: capabilities.imageGen,
						videoGen: capabilities.videoGen,
					});
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
							api?: string | null;
							supportsTools?: boolean | null;
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
					if (m.api === null) delete row.api;
					else if (m.api) row.api = m.api;
					if (m.supportsTools === null) delete row.supportsTools;
					else if (m.supportsTools !== undefined) row.supportsTools = m.supportsTools;
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
				this.#services.get<EventService>("events").broadcastModelsChanged();
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
				this.#services.get<EventService>("events").broadcastModelsChanged();
				return { ok: true };
			}
			case "tool.approve": {
				// 实现归 ApprovalService（note trim 与未知请求抛错语义不变）。
				return this.#services
					.get<ApprovalService>("approvals")
					.approve((params ?? {}) as { sessionId: string; requestId: string; note?: string });
			}
			case "tool.deny": {
				return this.#services
					.get<ApprovalService>("approvals")
					.deny((params ?? {}) as { sessionId: string; requestId: string; note?: string });
			}
			case "session.askAnswer": {
				return this.#services
					.get<ApprovalService>("approvals")
					.answer((params ?? {}) as { sessionId: string; requestId: string; answer: string | null });
			}
			case "usage.reports": {
				// 委托 UsageService（P1 服务抽取；原实现整体搬移至
				// services/usage-service.ts，行为不变，TUI /usage parity 语义
				// 与注释全部保留在服务内）。
				const p = (params ?? {}) as { sessionId?: string };
				return this.#services.get<UsageService>("usage").reports(p);
			}
			case "fs.read": {
				// 实现归 FileService（512 KiB 文本软帽语义不变）。
				return this.#services.get<FileService>("files").read((params ?? {}) as { path?: string });
			}
			case "fs.readBytes": {
				// GUI 文件预览二进制读取归 FileService（8/32 MiB 帽不变）。
				return this.#services
					.get<FileService>("files")
					.readBytes((params ?? {}) as { path?: string; maxBytes?: number });
			}
			case "fs.write": {
				return this.#services
					.get<FileService>("files")
					.write((params ?? {}) as { cwd?: string; path?: string; content?: string; encoding?: string });
			}
			case "fs.mkdir": {
				return this.#services.get<FileService>("files").mkdir((params ?? {}) as { cwd?: string; path?: string });
			}
			case "fs.rename": {
				return this.#services
					.get<FileService>("files")
					.rename((params ?? {}) as { cwd?: string; from?: string; to?: string });
			}
			case "fs.delete": {
				// GUI 仅在显式确认后发送（语义注释归服务头）。实现归 FileService。
				return this.#services
					.get<FileService>("files")
					.deleteEntry((params ?? {}) as { cwd?: string; path?: string });
			}
			case "workspace.tree": {
				return this.#services.get<FileService>("files").tree(params ?? {});
			}
			case "artifact.list": {
				// Artifacts-panel discovery: scan the workspace for
				// artifact.manifest.json sidecars (design-preset contract) and
				// validate each through the shared manifest module.
				const p = (params ?? {}) as { cwd?: string };
				if (!p.cwd) return { error: "missing cwd" };
				return scanWorkspaceArtifacts(p.cwd);
			}
			case "artifact.read": {
				// Artifacts-panel viewer: entry file text for the validated
				// manifest's renderer (html/markdown/react-component are all
				// text). Path escape guards live in artifact-scan.ts.
				const p = (params ?? {}) as { cwd?: string; dir?: string; entry?: string };
				if (!p.cwd || !p.dir || !p.entry) return { error: "missing cwd/dir/entry" };
				return readArtifactEntryText(p.cwd, p.dir, p.entry);
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
	// TEMP diagnostic (MUSEPI_RPC_TRACE=1): trace the request stream so a
	// silent daemon death can be attributed to its last in-flight RPC.
	if (process.env.MUSEPI_RPC_TRACE) logger.info("rpc.request", { method: req.method });
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
 *  client-core/dist (dev layout). A missing dist is non-fatal —
 *  startDaemonWeb throws and the shell falls back to its local bundle. */
function rendererDistDir(): string {
	const fromEnv = process.env.MUSEPI_RENDERER_DIST;
	if (fromEnv) return fromEnv;
	return path.resolve(import.meta.dir, "../../../client-core", "dist");
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
	// The daemon's own handler alone is not enough — postmortem.ts registers
	// a global `unhandledRejection` listener at module load time that exits
	// the process for any rejection not matching its known-safe patterns
	// (IPC EPIPE, EBADF, expected cleanup, or intercepted). Register an
	// interceptor to prevent postmortem's fatal path, keeping the daemon
	// alive through expected teardown races.
	interceptUnhandledRejections(reason => {
		logger.error("Unhandled rejection in daemon (intercepted)", { reason: String(reason) });
		return true;
	});
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
		const remote = options.remoteToken ? { host: "0.0.0.0" as const, authToken: options.remoteToken } : undefined;
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

const AUTOSTART_RUN_KEY = "Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\Run";

/** Resolve the daemon binary path for autostart registration. Returns empty
 *  when the binary cannot be found (dev mode — autostart only makes sense
 *  for packaged installs). */
function resolveDaemonBinary(): string {
	// Packaged: look for the daemon binary relative to this script's
	// location. The server is at <root>/packages/coding-agent/src/daemon/.
	// The packaged binary is at <root>/packages/desktop-app/vendor/daemon/musepi.exe
	// (or the asar-unpacked equivalent).
	const candidates = [
		path.join(__dirname, "..", "..", "..", "..", "..", "vendor", "daemon", "musepi.exe"),
		path.join(__dirname, "..", "..", "..", "..", "..", "vendor", "daemon", "musepi"),
		// Electron asar-unpacked path (packaged app)
		path.join(
			(process as { resourcesPath?: string }).resourcesPath ?? "",
			"app.asar.unpacked",
			"vendor",
			"daemon",
			"musepi.exe",
		),
		path.join(
			(process as { resourcesPath?: string }).resourcesPath ?? "",
			"app.asar.unpacked",
			"vendor",
			"daemon",
			"musepi",
		),
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
				stdout: "pipe",
				stderr: "pipe",
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
			Bun.spawnSync(
				[
					"reg.exe",
					"add",
					AUTOSTART_RUN_KEY,
					"/v",
					"musepi-daemon",
					"/t",
					"REG_SZ",
					"/d",
					`"${bin}" serve --port 8300`,
					"/f",
				],
				{
					stdout: "pipe",
					stderr: "pipe",
				},
			);
		} else {
			Bun.spawnSync(["reg.exe", "delete", AUTOSTART_RUN_KEY, "/v", "musepi-daemon", "/f"], {
				stdout: "pipe",
				stderr: "pipe",
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
			await fs.promises.writeFile(
				plist,
				`<?xml version="1.0" encoding="UTF-8"?>
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
</dict></plist>`,
				"utf8",
			);
		} else {
			try {
				await fs.promises.unlink(plist);
			} catch {
				/* no-op */
			}
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
			await fs.promises.writeFile(
				desktop,
				`[Desktop Entry]
Type=Application
Name=Musepi Daemon
Exec=${bin} serve --port 8300
X-GNOME-Autostart-enabled=true
`,
				"utf8",
			);
		} else {
			try {
				await fs.promises.unlink(desktop);
			} catch {
				/* no-op */
			}
		}
		return;
	}
	throw new Error("autostart not supported on this platform");
}
