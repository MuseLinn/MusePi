/**
 * AgentSignals — the upstream presence contract for every agent renderer.
 *
 * The facts arrive in three layers:
 *   1. session   what the daemon/session is doing (phase, activity, attention,
 *                subagents, context, goal)
 *   2. outcome   the one-shot result of a turn
 *   3. interaction/persona  UI gestures and relationship signals
 *
 * Renderers project this contract into their own vocabularies:
 *   - CompanionState (the built-in vector companion)
 *   - AoraState (the Aora character engine)
 *   - OrbState (ThinkingOrb)
 * Never feed one renderer's state enum into another.
 */

import { entryStartMs, type SessionEntry } from "@musepi/pi-wire";

export type AgentPhase =
	| "starting"
	| "idle"
	| "thinking"
	| "streaming"
	| "tool"
	| "awaiting-user"
	| "done"
	| "error"
	| "paused"
	| "closing";

/** The verbs Aora's adapter vocabulary already speaks. */
export type AgentActivityVerb =
	| "thinking"
	| "searching"
	| "browsing"
	| "reading"
	| "connecting"
	| "writing"
	| "coding"
	| "running-commands"
	| "using-computer"
	| "working"
	| "generating"
	| "messaging"
	| "waiting"
	| "sending"
	| "uploading"
	| "dictating";

export type AgentOutcomeKind = "success" | "failure" | "cancelled" | "refused";

export interface AgentOutcome {
	kind: AgentOutcomeKind;
	at: number;
	summary?: string;
}

export type AgentPresence = "visible" | "hidden" | "waking" | "closing" | "starting";

export type AgentInteraction = "hover" | "drag" | "poke" | "praise" | "deny" | "play" | "bounce" | "hum" | "listening";

export type AgentPersonaMood =
	| "happy"
	| "excited"
	| "laughing"
	| "playful"
	| "proud"
	| "shy"
	| "sad"
	| "angry"
	| "suspicious"
	| "surprised"
	| "scared"
	| "bored";

export interface AgentSubagentCounts {
	running: number;
	parked: number;
	completed: number;
	failed: number;
}

export interface AgentContextFacts {
	tokens: number | null;
	window: number | null;
	percent: number | null;
	compacting?: boolean;
}

export interface AgentGoalFacts {
	enabled: boolean;
	status?: string;
	done: number;
	total: number;
}

/**
 * The full contract. Legacy compact fields stay optional so older call sites
 * (and the pet window's partial IPC pushes) keep working unchanged.
 */
export interface AgentSignals {
	// ── legacy compact facts ──────────────────────────────────────────────
	dragging?: boolean;
	spawning?: boolean;
	toolFailed?: boolean;
	ambiguous?: boolean;
	working?: boolean;
	streaming?: boolean;
	unread?: number;
	approvals?: number;
	awaitingInput?: boolean;
	sending?: boolean;
	receiving?: boolean;
	idleMs?: number;
	justFinished?: boolean;

	// ── richer session facts ─────────────────────────────────────────────
	phase?: AgentPhase;
	activity?: AgentActivityVerb;
	toolName?: string | null;
	startedAt?: number;
	outcome?: AgentOutcome | null;
	questions?: number;
	queue?: number;
	subagents?: AgentSubagentCounts;
	context?: AgentContextFacts;
	goal?: AgentGoalFacts | null;
	historyLoading?: boolean;

	// ── presence / interaction / persona ─────────────────────────────────
	presence?: AgentPresence;
	interaction?: AgentInteraction | null;
	personaMood?: AgentPersonaMood | null;
	visible?: boolean;
	focused?: boolean;
	now?: number;
}

export const DROWSY_AFTER_MS = 90_000;
export const SLEEPING_AFTER_MS = 5 * 60_000;
export const BORED_AFTER_MS = 30_000;

/** Map a tool name to the closest Aora activity verb. */
export function activityVerbForTool(toolName: string | null | undefined): AgentActivityVerb {
	const name = (toolName ?? "").trim().toLowerCase();
	if (!name) return "working";
	if (name.includes("search") || /(^|_)(grep|glob|find|ast_grep)($|_)/.test(name)) return "searching";
	if (name.includes("read") || /(^|_)(view|inspect|cat)($|_)/.test(name)) return "reading";
	if (name.includes("edit") || name.includes("write") || name.includes("patch") || name.includes("apply"))
		return "writing";
	if (/(^|_)(bash|shell|exec|command|terminal|run)($|_)/.test(name)) return "running-commands";
	if (name.includes("browser") || name.includes("fetch") || name.includes("http")) return "browsing";
	if (name.includes("computer") || name.includes("mouse") || name.includes("keyboard")) return "using-computer";
	if (name.includes("upload") || name.includes("attach")) return "uploading";
	if (name.includes("tts") || name.includes("voice") || name.includes("dictat") || name.includes("speech"))
		return "dictating";
	if (name.includes("message") || name.includes("chat") || name.includes("reply")) return "messaging";
	if (name.includes("connect") || name.includes("oauth") || name.includes("auth")) return "connecting";
	if (name.includes("todo") || name.includes("ask") || name.includes("approval") || name.includes("wait"))
		return "waiting";
	if (name.includes("task") || name.includes("agent") || name.includes("delegate")) return "working";
	return "working";
}

/**
 * The subset of a GUI session snapshot the adapter needs. Structural on
 * purpose: `session-store.ts` can pass `GuiSessionState` without importing
 * this module (and without a cycle).
 */
export interface AgentSignalSource {
	working?: boolean;
	streaming?: boolean;
	activeTools?: ReadonlyMap<string, { toolName: string; startedAt?: number }>;
	approvals?: readonly unknown[];
	agents?: readonly { status?: string; kind?: string }[];
	state?: {
		paused?: boolean;
		pausedAt?: number | null;
		queuedMessageCount?: number;
		contextUsage?: { tokens: number | null; contextWindow: number | null; percent: number | null } | null;
		goalMode?: { enabled: boolean; objective?: string; status?: string } | null;
		todo?: readonly { name: string; done: number; total: number }[];
	} | null;
	entries?: readonly SessionEntry[];
	historyLoading?: boolean;
}

export interface AgentSignalExtras {
	now?: number;
	unread?: number;
	questions?: number;
	presence?: AgentPresence;
	visible?: boolean;
	focused?: boolean;
	interaction?: AgentInteraction | null;
	personaMood?: AgentPersonaMood | null;
	outcome?: AgentOutcome | null;
	justFinished?: boolean;
	sending?: boolean;
	receiving?: boolean;
	toolFailed?: boolean;
	ambiguous?: boolean;
	awaitingInput?: boolean;
}

/**
 * Project a GUI session snapshot into the shared contract. Only facts the
 * snapshot owns are derived; transient one-shots (sending/receiving/outcome/
 * interaction) come from the caller through `extras`.
 */
export function agentSignalsFromSnapshot(
	snap: AgentSignalSource | null | undefined,
	extras: AgentSignalExtras = {},
): AgentSignals {
	if (!snap) {
		return { ...extras, phase: extras.presence === "starting" ? "starting" : "idle", idleMs: 0 };
	}

	const tools = [...(snap.activeTools?.values() ?? [])];
	const lastTool = tools[tools.length - 1];
	const approvals = snap.approvals?.length ?? 0;
	const paused = snap.state?.paused === true;
	const phase: AgentPhase = paused
		? "paused"
		: approvals > 0
			? "awaiting-user"
			: snap.streaming
				? "streaming"
				: tools.length > 0
					? "tool"
					: snap.working
						? "thinking"
						: "idle";

	const subs = (snap.agents ?? []).filter(agent => agent.kind !== "main");
	const subagents: AgentSubagentCounts = {
		running: subs.filter(agent => agent.status === "running").length,
		parked: subs.filter(agent => agent.status === "parked").length,
		completed: subs.filter(agent => agent.status === "idle").length,
		failed: subs.filter(agent => agent.status === "aborted").length,
	};

	const todo = snap.state?.todo ?? [];
	const done = todo.reduce((sum, item) => sum + item.done, 0);
	const total = todo.reduce((sum, item) => sum + item.total, 0);
	const goalMode = snap.state?.goalMode;
	const goal: AgentGoalFacts | null = goalMode
		? { enabled: goalMode.enabled, status: goalMode.status, done, total }
		: todo.length > 0
			? { enabled: false, done, total }
			: null;

	const context = snap.state?.contextUsage;
	const stamps: number[] = [];
	if (lastTool?.startedAt) stamps.push(lastTool.startedAt);
	if (typeof snap.state?.pausedAt === "number") stamps.push(snap.state.pausedAt);
	for (const entry of snap.entries ?? []) {
		try {
			const at = entryStartMs(entry);
			if (Number.isFinite(at)) stamps.push(at);
		} catch {
			// malformed journal row: skip the timestamp, keep the facts
		}
	}
	const lastAt = stamps.length > 0 ? Math.max(...stamps) : 0;
	const idleMs = extras.now && lastAt > 0 ? Math.max(0, extras.now - lastAt) : undefined;

	return {
		...extras,
		phase,
		activity: lastTool ? activityVerbForTool(lastTool.toolName) : undefined,
		toolName: lastTool?.toolName ?? null,
		startedAt: lastTool?.startedAt,
		approvals,
		questions: extras.questions ?? 0,
		unread: extras.unread ?? 0,
		queue: snap.state?.queuedMessageCount ?? 0,
		subagents,
		context: context
			? {
					tokens: context.tokens,
					window: context.contextWindow,
					percent: context.percent,
				}
			: undefined,
		goal,
		historyLoading: snap.historyLoading === true,
		idleMs,
		working: snap.working === true,
		streaming: snap.streaming === true,
		awaitingInput: extras.awaitingInput === true,
		justFinished: extras.justFinished,
	};
}
