/**
 * Aora's 44-state vocabulary and its projection from AgentSignals.
 *
 * Aora is one renderer, not the platform contract. The same `AgentSignals`
 * feeds `companionStateFromSignals` (built-in vector companion), this module
 * (Aora character engine), and `thinkingOrbStateFromSession` (the compact
 * roster orb). Do not feed one renderer's state enum into another.
 *
 * The states are split by WHO can honestly produce them:
 *   - session    daemon/session facts (turn, tool, approvals, queue, unread)
 *   - outcome    a turn's one-shot result (success/failure/refused, goal done)
 *   - presence   window/idle lifecycle (spawn, wake, sleep, drag, upload)
 *   - persona    relationship/UI signals (praise, poke, mood, antics)
 *
 * A state with no producer is a bug, not a feature: that is exactly how the
 * old 31-state axis accumulated 18 unreachable entries.
 */

import {
	type AgentActivityVerb,
	type AgentInteraction,
	type AgentPersonaMood,
	type AgentSignals,
	BORED_AFTER_MS,
	DROWSY_AFTER_MS,
	SLEEPING_AFTER_MS,
} from "./agent-signals";

export const AORA_STATES = [
	"idle",
	"sleeping",
	"drowsy",
	"bored",
	"waking",
	"powering-down",
	"listening",
	"thinking",
	"searching",
	"reading",
	"writing",
	"working",
	"loading",
	"progress",
	"radar",
	"orbit",
	"dictating",
	"uploading",
	"sending",
	"receiving",
	"messaging",
	"waiting",
	"spawning",
	"composing",
	"dragging",
	"happy",
	"excited",
	"laughing",
	"playful",
	"proud",
	"celebrate",
	"bouncing",
	"shy",
	"sad",
	"angry",
	"confused",
	"suspicious",
	"surprised",
	"scared",
	"curious",
	"humming",
	"alerting",
	"notifying",
	"refusing",
] as const;

export type AoraState = (typeof AORA_STATES)[number];

export type AoraSurface = "workbench" | "assistant" | "avatar";
export type AoraStateSource = "session" | "outcome" | "presence" | "persona";

export const AORA_STATE_SOURCE: Record<AoraState, AoraStateSource> = {
	idle: "session",
	sleeping: "presence",
	drowsy: "presence",
	bored: "presence",
	waking: "presence",
	"powering-down": "presence",
	listening: "presence",
	thinking: "session",
	searching: "session",
	reading: "session",
	writing: "session",
	working: "session",
	loading: "session",
	progress: "session",
	radar: "session",
	orbit: "session",
	dictating: "presence",
	uploading: "presence",
	sending: "session",
	receiving: "session",
	messaging: "session",
	waiting: "session",
	spawning: "presence",
	composing: "session",
	dragging: "presence",
	happy: "outcome",
	excited: "persona",
	laughing: "persona",
	playful: "persona",
	proud: "outcome",
	celebrate: "outcome",
	bouncing: "presence",
	shy: "persona",
	sad: "persona",
	angry: "persona",
	confused: "session",
	suspicious: "persona",
	surprised: "persona",
	scared: "persona",
	curious: "session",
	humming: "presence",
	alerting: "session",
	notifying: "session",
	refusing: "outcome",
};

/** Workbench may show work/result/presence states, never persona/antics. */
const WORKBENCH_STATES = new Set<AoraState>([
	"idle",
	"sleeping",
	"drowsy",
	"waking",
	"powering-down",
	"listening",
	"thinking",
	"searching",
	"reading",
	"writing",
	"working",
	"loading",
	"progress",
	"radar",
	"orbit",
	"dictating",
	"uploading",
	"sending",
	"receiving",
	"messaging",
	"waiting",
	"spawning",
	"composing",
	"dragging",
	"happy",
	"proud",
	"celebrate",
	"confused",
	"curious",
	"alerting",
	"notifying",
	"refusing",
]);

/** Avatar slots are small: keep the reading compact, not the full 44. */
const AVATAR_STATES = new Set<AoraState>([
	"idle",
	"listening",
	"thinking",
	"searching",
	"reading",
	"writing",
	"working",
	"loading",
	"progress",
	"waiting",
	"composing",
	"sending",
	"receiving",
	"happy",
	"celebrate",
	"confused",
	"curious",
	"alerting",
	"notifying",
]);

const ACTIVITY_STATE: Record<AgentActivityVerb, AoraState> = {
	thinking: "thinking",
	searching: "searching",
	browsing: "searching",
	reading: "reading",
	connecting: "radar",
	writing: "writing",
	coding: "writing",
	"running-commands": "working",
	"using-computer": "working",
	working: "working",
	generating: "writing",
	messaging: "messaging",
	waiting: "waiting",
	sending: "sending",
	uploading: "uploading",
	dictating: "dictating",
};

const INTERACTION_STATE: Record<AgentInteraction, AoraState> = {
	hover: "curious",
	drag: "dragging",
	poke: "surprised",
	praise: "shy",
	deny: "refusing",
	play: "playful",
	bounce: "bouncing",
	hum: "humming",
	listening: "listening",
};

const PERSONA_STATE: Record<AgentPersonaMood, AoraState> = {
	happy: "happy",
	excited: "excited",
	laughing: "laughing",
	playful: "playful",
	proud: "proud",
	shy: "shy",
	sad: "sad",
	angry: "angry",
	suspicious: "suspicious",
	surprised: "surprised",
	scared: "scared",
	bored: "bored",
};

/** A tool that has run this long without a terminal event is "progress". */
const PROGRESS_AFTER_MS = 8_000;

/**
 * Resolve the shared contract to one Aora state. `surface` is the same idea
 * as Aora's own `characterStateForRoster(facts, surface)`: the same facts want
 * different answers in a list, a chat, and an avatar slot.
 */
export function aoraStateFromSignals(s: AgentSignals = {}, surface: AoraSurface = "assistant"): AoraState {
	const resolved = resolveAoraState(s, surface);
	return gateForSurface(resolved, surface);
}

function resolveAoraState(s: AgentSignals, surface: AoraSurface): AoraState {
	// ── deliberate user gestures, highest first ───────────────────────────
	if (s.interaction === "drag" || s.dragging) return "dragging";
	if (s.interaction === "deny") return "refusing";
	if (s.interaction === "poke") return "surprised";
	if (s.interaction === "praise") return "shy";
	if (s.interaction === "play") return "playful";
	if (s.interaction === "bounce") return "bouncing";
	if (s.interaction === "hum") return "humming";

	// ── window / idle lifecycle ───────────────────────────────────────────
	if (s.presence === "starting" || s.spawning) return "spawning";
	if (s.presence === "waking") return "waking";
	if (s.presence === "closing") return "powering-down";
	if (s.presence === "hidden") return "sleeping";

	// ── one-shot outcome ──────────────────────────────────────────────────
	if (s.outcome?.kind === "refused") return "refusing";
	if (s.outcome?.kind === "failure" || s.phase === "error" || s.toolFailed) return "alerting";
	if (s.ambiguous) return "confused";
	if (s.outcome?.kind === "cancelled") return "idle";
	if (s.goal?.enabled && s.goal.total > 0 && s.goal.done >= s.goal.total) return "proud";
	if (s.outcome?.kind === "success") return s.justFinished ? "celebrate" : "happy";

	// ── attention: approvals/questions/unread outrank ambient work ────────
	if (s.phase === "paused") return "waiting";
	if ((s.approvals ?? 0) > 0) return "waiting";
	if ((s.questions ?? 0) > 0 || s.awaitingInput) return "curious";
	if ((s.unread ?? 0) > 0) return "notifying";
	if (s.phase === "awaiting-user") return "waiting";

	// ── live work ─────────────────────────────────────────────────────────
	if (s.historyLoading) return "loading";
	if (s.streaming || s.phase === "streaming") return "composing";
	if (s.subagents && s.subagents.running > 1) return "orbit";
	if (s.interaction === "listening") return "listening";

	if (s.phase === "tool" || s.working || s.activity) {
		if (s.activity && s.now && s.startedAt) {
			const elapsed = Math.max(0, s.now - s.startedAt);
			const generic =
				s.activity === "working" || s.activity === "running-commands" || s.activity === "using-computer";
			if (generic && elapsed >= PROGRESS_AFTER_MS) return "progress";
		}
		if (s.activity) return ACTIVITY_STATE[s.activity];
		return s.phase === "thinking" ? "thinking" : "working";
	}
	if (s.phase === "thinking") return "thinking";
	if (s.sending) return "sending";
	if (s.receiving) return "receiving";

	// ── idle / personality ───────────────────────────────────────────────
	if ((s.idleMs ?? 0) >= SLEEPING_AFTER_MS) return "sleeping";
	if ((s.idleMs ?? 0) >= DROWSY_AFTER_MS) return "drowsy";
	if ((s.idleMs ?? 0) >= BORED_AFTER_MS) return "bored";
	if (surface === "assistant" && s.personaMood) return PERSONA_STATE[s.personaMood];
	if (s.interaction === "hover") return "curious";
	return "idle";
}

function gateForSurface(state: AoraState, surface: AoraSurface): AoraState {
	if (surface === "workbench" && !WORKBENCH_STATES.has(state)) {
		switch (state) {
			case "sad":
			case "angry":
			case "scared":
				return "alerting";
			case "shy":
			case "playful":
			case "laughing":
			case "excited":
				return "idle";
			case "surprised":
			case "suspicious":
				return "confused";
			default:
				return "idle";
		}
	}
	if (surface === "avatar" && !AVATAR_STATES.has(state)) {
		switch (state) {
			case "alerting":
			case "refusing":
				return "alerting";
			case "waiting":
			case "curious":
			case "notifying":
				return "waiting";
			case "celebrate":
			case "proud":
			case "happy":
				return "celebrate";
			case "searching":
			case "reading":
			case "writing":
			case "composing":
				return "working";
			default:
				return "idle";
		}
	}
	return state;
}
