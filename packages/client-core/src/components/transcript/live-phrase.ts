/**
 * What the transcript's tail presence says while a turn runs.
 *
 * Pure: no React, no DOM, no timers. The component owns the clock; this module
 * owns the words and the order they arrive in.
 *
 * Two ideas borrowed from OpenMausBot's `live-activity.ts`, both worth keeping:
 *   - a phase is a STABLE key (`tool:searching`), so the rotation resets only
 *     when the work actually changes, never on a re-render;
 *   - the rotation is deterministic (FNV-1a over `seed|index`), so a replayed
 *     turn reads the same way and a test can assert it — random picks would
 *     also make every row on screen switch at once.
 */
import { toolActivityKind, type StructuredToolKind, type ToolActivityKind } from "../../lib/tool-activity";
import { t } from "../../i18n/index.js";

/** The facts the presence line reads. `Transcript` owns `working` / `streaming`;
 *  the host supplies `approvals` and `paused` because the transcript itself
 *  does not receive them. */
export interface TailSignals {
	working: boolean;
	streaming: boolean;
	approvals: number;
	paused: boolean;
	toolName?: string | null;
	/** A structured kind the caller already holds (the transcript's ToolKind). */
	toolKind?: StructuredToolKind | string | null;
}

export interface LivePhrase {
	/** Stable phase key: the rotation restarts when this changes. */
	phase: string;
	/** First entry is the canonical phrase (what a screen reader gets); the
	 *  rest are alternates for the visible slot. */
	phrases: readonly string[];
}

/** The canonical phrase plus its alternates, per activity kind. */
const BY_KIND: Record<ToolActivityKind, readonly string[]> = {
	searching: ["transcript.phaseSearching", "transcript.altNarrowing", "transcript.altLookingItUp"],
	reading: ["transcript.phaseReading", "transcript.altSkimming", "transcript.altTakingALook"],
	writing: ["transcript.phaseWriting", "transcript.altDrafting"],
	"running-commands": ["transcript.phaseCommands", "transcript.altCheckingOutput"],
	browsing: ["transcript.phaseBrowsing", "transcript.altLookingItUp"],
	"using-computer": ["transcript.phaseComputer", "transcript.altClickingThrough"],
	messaging: ["transcript.phaseMessaging"],
	waiting: ["transcript.phaseWaiting"],
	thinking: ["transcript.phaseThinking", "transcript.altMulling", "transcript.altPiecing", "transcript.altWeighing"],
	working: ["transcript.phaseWorking", "transcript.altDrafting"],
};

const REPLY_KEYS = ["transcript.phaseReply"];
const AWAITING_KEYS = ["transcript.phaseWaiting"];
const PAUSED_KEYS = ["transcript.phaseWorking"];
const IDLE_KEYS = ["transcript.phaseWorking"];

/** Keys → labels. Keys are resolved at call time, never at import time, so a
 *  locale switch is picked up. */
function labels(keys: readonly string[]): string[] {
	return keys.map(key => t(key as Parameters<typeof t>[0]));
}

/**
 * The phase and its phrases. Priority: paused → awaiting an approval →
 * streaming a reply → a running tool → thinking. Each step is the state a
 * person would name first if they glanced at the row.
 */
export function livePhraseFor(signals: TailSignals): LivePhrase {
	if (signals.paused) return { phase: "paused", phrases: labels(PAUSED_KEYS) };
	if (signals.approvals > 0) return { phase: "awaiting", phrases: labels(AWAITING_KEYS) };
	if (signals.streaming) return { phase: "reply", phrases: labels(REPLY_KEYS) };
	if (!signals.working) return { phase: "idle", phrases: labels(IDLE_KEYS) };
	const kind = toolActivityKind(signals.toolName, signals.toolKind);
	if (kind === "working" && !signals.toolName) {
		return { phase: "thinking", phrases: labels(BY_KIND.thinking) };
	}
	return { phase: `tool:${kind}`, phrases: labels(BY_KIND[kind]) };
}

/** FNV-1a, 32-bit. */
function hash(value: string): number {
	let h = 2166136261;
	for (let i = 0; i < value.length; i++) {
		h ^= value.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/**
 * The phrase shown at `step`. Step 0 is always the canonical phrase; after
 * that the alternates are visited in a seed-determined order and the cycle
 * closes back on the canonical one, so no phrase ever repeats back to back.
 */
export function phraseAt(phrases: readonly string[], seed: string, step: number): string {
	if (phrases.length === 0) return "";
	if (phrases.length === 1 || step <= 0) return phrases[0] ?? "";
	const rest = phrases.slice(1);
	const order = rest
		.map((phrase, index) => ({ phrase, rank: hash(`${seed}|${index}`) }))
		.sort((a, b) => a.rank - b.rank)
		.map(entry => entry.phrase);
	const cycle = [...order, phrases[0]!];
	return cycle[(step - 1) % cycle.length] ?? "";
}

/**
 * How long a phrase holds, 4–6s, seeded so two rows on screen do not switch
 * together. A smooth constant would make every working bot flip in lockstep.
 */
export function phraseHoldMs(seed: string, step: number): number {
	return 4000 + (hash(`${seed}#${step}`) % 2001);
}
