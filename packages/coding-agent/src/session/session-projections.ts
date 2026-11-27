/**
 * Session projections — the host side of the shared read-model seam.
 *
 * Domain units register a key, a pure fold over committed wire events and a
 * client view. The daemon drives every unit once per event; a unit that does
 * not care returns the same state reference, so the change feed stays quiet.
 * Carriers receive whole current values (never deltas the client must fold):
 * a baseline rides the session snapshot and every later change travels as a
 * `projection` stream envelope.
 *
 * The split is the contract: the daemon owns computation, clients own only
 * per-key caching and rendering, so a client never folds events itself.
 */
import type {
	AgentEvent,
	ContextUsageProjection,
	SessionEntry,
	SessionModeProjection,
	SessionProjectionChange,
	SessionProjectionSnapshot,
	WireUsage,
} from "@musepi/pi-wire";
import { cacheHitRate } from "../modes/utils/cache-hit";
import type { SessionStats } from "../session/agent-session-types";

/** The live facts a unit may sample at a boundary (never per streaming tick). */
export interface ProjectionSampleSource {
	model(): { provider?: string; id: string; contextWindow?: number | null } | null | undefined;
	sessionStats(): SessionStats;
	/** Session mode switches. These have no wire event of their own: they are
	 *  set through an RPC (`session.setGoal` / `session.setPlan`), which is what
	 *  `session_mode_changed` names — the daemon samples after the RPC writes
	 *  the state, so a client never has to poll for them. */
	sessionMode?(): SessionModeProjection;
}

export interface ProjectionSeed {
	/** Full committed entries (the snapshot, before the transport tail-crops it). */
	entries: readonly SessionEntry[];
	/** Present for a live session; absent for an archived snapshot. */
	source?: ProjectionSampleSource;
}

export interface ProjectionDefinition<S> {
	key: string;
	init(seed: ProjectionSeed): S;
	/** Pure transition. MUST return the same reference for unrelated events. */
	apply(state: S, event: ProjectionEvent): S;
	/** Client view; keep the reference stable for unchanged facts. */
	view(state: S): unknown;
	viewEquals?(left: unknown, right: unknown): boolean;
	/** Events after which the host may sample live facts (turn settle,
	 *  compaction, model switch). Never per streaming update. */
	sampleOn?: ReadonlySet<string>;
	sample?(state: S, source: ProjectionSampleSource): S;
}

/** Wire events plus the daemon-only facts that have no wire payload of their
 *  own: a `model_changed` route switch, and a `session_mode_changed` goal/plan
 *  write. The unit samples the live value when one arrives. */
export type ProjectionEvent = AgentEvent | { type: "model_changed" } | { type: "session_mode_changed" };
interface SessionEntryState {
	states: Map<string, unknown>;
	views: Map<string, unknown>;
	source?: ProjectionSampleSource;
}

const SAMPLE_ON = new Set(["turn_end", "agent_end", "auto_compaction_end", "session_leaf_moved", "model_changed"]);

function assistantOf(event: ProjectionEvent): { message: Extract<SessionEventMessage, { role: "assistant" }> } | null {
	if (event.type !== "message_end" && event.type !== "message_start" && event.type !== "message_update") return null;
	const message = (event as { message?: unknown }).message;
	if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") return null;
	return { message: message as Extract<SessionEventMessage, { role: "assistant" }> };
}

type SessionEventMessage = import("@musepi/pi-wire").WireMessage;

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

interface ContextUsageState {
	model: string | null;
	tokens: number;
	contextWindow: number;
	totals: UsageTotals;
	/** Last counted assistant message: a re-emit of the same timestamp replaces
	 *  its contribution instead of double-counting a retried attempt. */
	last: { timestamp: number; usage: WireUsage } | null;
}

const ZERO_TOTALS: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };

function modelRef(model: ReturnType<ProjectionSampleSource["model"]>): string | null {
	if (!model) return null;
	return model.provider ? `${model.provider}/${model.id}` : model.id;
}

function promptSide(usage: WireUsage): number {
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

function totalsWith(totals: UsageTotals, usage: WireUsage): UsageTotals {
	return {
		input: totals.input + usage.input,
		output: totals.output + usage.output,
		cacheRead: totals.cacheRead + usage.cacheRead,
		cacheWrite: totals.cacheWrite + usage.cacheWrite,
		totalTokens: totals.totalTokens + usage.totalTokens,
		cost: totals.cost + usage.cost.total,
	};
}

function totalsWithout(totals: UsageTotals, usage: WireUsage): UsageTotals {
	return {
		input: totals.input - usage.input,
		output: totals.output - usage.output,
		cacheRead: totals.cacheRead - usage.cacheRead,
		cacheWrite: totals.cacheWrite - usage.cacheWrite,
		totalTokens: totals.totalTokens - usage.totalTokens,
		cost: totals.cost - usage.cost.total,
	};
}

function sameTotals(a: UsageTotals, b: UsageTotals): boolean {
	return (
		a.input === b.input &&
		a.output === b.output &&
		a.cacheRead === b.cacheRead &&
		a.cacheWrite === b.cacheWrite &&
		a.totalTokens === b.totalTokens &&
		a.cost === b.cost
	);
}

function applyAssistant(
	state: ContextUsageState,
	message: { timestamp: number; usage: WireUsage; provider?: string; model: string },
): ContextUsageState {
	const sameAsLast = state.last?.timestamp === message.timestamp;
	const totals = sameAsLast
		? totalsWith(totalsWithout(state.totals, state.last!.usage), message.usage)
		: totalsWith(state.totals, message.usage);
	const tokens = promptSide(message.usage);
	// Model identity is `provider/id`; a live settlement without a provider
	// keeps the last qualified reference instead of degrading to a bare id.
	const model = message.provider ? `${message.provider}/${message.model}` : state.model;
	if (sameTotals(totals, state.totals) && tokens === state.tokens && model === state.model && sameAsLast) return state;
	return {
		...state,
		model,
		tokens,
		totals,
		last: { timestamp: message.timestamp, usage: message.usage },
	};
}

/** Fold a full snapshot once (cold open / daemon restart). */
function seedFromEntries(entries: readonly SessionEntry[]): ContextUsageState {
	let state: ContextUsageState = {
		model: null,
		tokens: 0,
		contextWindow: 0,
		totals: ZERO_TOTALS,
		last: null,
	};
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		state = applyAssistant(state, entry.message);
	}
	return state;
}

function fromStats(
	stats: SessionStats,
	source: ProjectionSampleSource,
	fallback: ContextUsageState,
): ContextUsageState {
	const model = modelRef(source.model());
	const context = stats.contextUsage;
	const totals: UsageTotals = {
		input: stats.tokens.input,
		output: stats.tokens.output,
		cacheRead: stats.tokens.cacheRead,
		cacheWrite: stats.tokens.cacheWrite,
		totalTokens: stats.tokens.total,
		cost: stats.cost,
	};
	const tokens = context?.tokens ?? fallback.tokens;
	const contextWindow = context?.contextWindow ?? source.model()?.contextWindow ?? fallback.contextWindow;
	return { ...fallback, model: model ?? fallback.model, tokens, contextWindow, totals };
}

/**
 * The `contextUsage` unit: live context occupancy plus whole-session spend.
 *
 * Streaming assistant settlements update the pressure numerator/provider
 * totals in O(1). `turn_end` / `agent_end` / compaction / model switch sample
 * the live stats once, which is where the exact anchored context count,
 * task-tool usage and the route's window land.
 */
export const contextUsageProjectionDefinition: ProjectionDefinition<ContextUsageState> = {
	key: "contextUsage",
	init: seed => {
		const fallback = seedFromEntries(seed.entries);
		if (!seed.source) return fallback;
		return fromStats(seed.source.sessionStats(), seed.source, fallback);
	},
	apply: (state, event) => {
		if (event.type === "message_end") {
			const assistant = assistantOf(event);
			return assistant ? applyAssistant(state, assistant.message) : state;
		}
		return state;
	},
	view: (state): ContextUsageProjection => {
		const percent = state.contextWindow > 0 ? (state.tokens / state.contextWindow) * 100 : 0;
		return {
			model: state.model,
			tokens: state.tokens,
			contextWindow: state.contextWindow,
			percent,
			usage: {
				input: state.totals.input,
				output: state.totals.output,
				cacheRead: state.totals.cacheRead,
				cacheWrite: state.totals.cacheWrite,
				totalTokens: state.totals.totalTokens,
				cost: state.totals.cost,
				cacheHitRate: cacheHitRate(state.totals),
			},
		};
	},
	viewEquals: (left, right) => {
		if (left === right) return true;
		if (!left || !right) return false;
		const a = left as ContextUsageProjection;
		const b = right as ContextUsageProjection;
		return (
			a.model === b.model &&
			a.tokens === b.tokens &&
			a.contextWindow === b.contextWindow &&
			a.percent === b.percent &&
			a.usage.input === b.usage.input &&
			a.usage.output === b.usage.output &&
			a.usage.cacheRead === b.usage.cacheRead &&
			a.usage.cacheWrite === b.usage.cacheWrite &&
			a.usage.totalTokens === b.usage.totalTokens &&
			a.usage.cost === b.usage.cost &&
			a.usage.cacheHitRate === b.usage.cacheHitRate
		);
	},
	sampleOn: SAMPLE_ON,
	sample: (state, source) => fromStats(source.sessionStats(), source, state),
};

/**
 * Session mode switches — goal and plan. These have no wire event of their own:
 * `session.setGoal` / `session.setPlan` write them through the live
 * AgentSession, so the projection samples them at a `session_mode_changed`
 * boundary the daemon emits after the RPC writes the state. This replaces the
 * GUI's 30s `session.modes` poll for the two fields the transcript cannot
 * express, and makes a change made by the TUI or another device arrive
 * immediately instead of up to 30s later.
 */
export const sessionModeProjectionDefinition: ProjectionDefinition<SessionModeProjection> = {
	key: "sessionMode",
	// Seed from the live source so a freshly opened surface shows the real
	// switches in its baseline — an empty seed would paint "no goal, no plan"
	// until the next write.
	init: seed => {
		const mode = seed.source?.sessionMode?.();
		if (!mode) return { goal: null, plan: false };
		return { goal: mode.goal?.enabled ? mode.goal : null, plan: mode.plan };
	},
	// Mode switches are written through the live session, never through a
	// journal record, so there is nothing to fold here — `sample` does the work
	// at the `session_mode_changed` boundary.
	apply: state => state,
	sample: (state, source) => {
		const mode = source.sessionMode?.();
		if (!mode) return state;
		const goal = mode.goal?.enabled ? mode.goal : null;
		return goal === state.goal && mode.plan === state.plan ? state : { goal, plan: mode.plan };
	},
	sampleOn: new Set(["session_mode_changed"]),
	view: (state): SessionModeProjection => state,
	viewEquals: (left, right) => left === right || JSON.stringify(left) === JSON.stringify(right),
};

/**
 * Per-session projection registry. One instance per daemon host; unit
 * definitions are process-wide by construction (registered at construction).
 */
export class SessionProjectionRegistry {
	readonly #definitions = new Map<string, ProjectionDefinition<unknown>>();
	readonly #sessions = new Map<string, SessionEntryState>();

	register<S>(definition: ProjectionDefinition<S>): void {
		this.#definitions.set(definition.key, definition as ProjectionDefinition<unknown>);
	}

	/** Seed (or reseed) one session from a full snapshot; a live source makes
	 *  the seed exact without replaying the transcript. */
	seed(sessionId: string, seed: ProjectionSeed): void {
		const entry: SessionEntryState = {
			states: new Map(),
			views: new Map(),
			...(seed.source ? { source: seed.source } : {}),
		};
		for (const definition of this.#definitions.values()) {
			const state = definition.init(seed);
			entry.states.set(definition.key, state);
			entry.views.set(definition.key, definition.view(state));
		}
		this.#sessions.set(sessionId, entry);
	}

	/** Seed only when this daemon has no state for the session yet (archived reads). */
	seedIfAbsent(sessionId: string, seed: ProjectionSeed): void {
		if (!this.#sessions.has(sessionId)) this.seed(sessionId, seed);
	}

	/** Current values for the snapshot/subscribe baseline. */
	snapshot(sessionId: string): SessionProjectionSnapshot | undefined {
		const entry = this.#sessions.get(sessionId);
		if (!entry) return undefined;
		return { values: Object.fromEntries(entry.views), seq: 0 };
	}

	/**
	 * Drive every unit for one committed event. Returns only views that
	 * actually changed; the caller broadcasts them as one `projection` frame.
	 */
	applyEvent(sessionId: string, event: ProjectionEvent): SessionProjectionChange[] {
		const entry = this.#sessions.get(sessionId);
		if (!entry) return [];
		const changes: SessionProjectionChange[] = [];
		for (const [key, definition] of this.#definitions) {
			const state = entry.states.get(key);
			let next = definition.apply(state, event);
			if (definition.sample && entry.source && definition.sampleOn?.has(event.type) === true) {
				next = definition.sample(next, entry.source);
			}
			if (next === state) continue;
			entry.states.set(key, next);
			const view = definition.view(next);
			const previous = entry.views.get(key);
			const equals = definition.viewEquals ?? Object.is;
			if (equals(previous, view)) continue;
			entry.views.set(key, view);
			changes.push({ key, value: view });
		}
		return changes;
	}

	clear(sessionId: string): void {
		this.#sessions.delete(sessionId);
	}
}
