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
import { goalFromModeData } from "../goals/state";
import { cacheHitRate } from "../modes/utils/cache-hit";
import type { SessionStats } from "../session/agent-session-types";

/** The live facts a unit may sample at a boundary (never per streaming tick). */
export interface ProjectionSampleSource {
	model(): { provider?: string; id: string; contextWindow?: number | null } | null | undefined;
	sessionStats(): SessionStats;
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

/**
 * What a domain gets back from `register`.
 *
 * The handle is how a domain READS the state it declared instead of keeping a
 * second copy: `stateOf` folds that session's committed events through the
 * unit, `viewOf` returns the client-facing value, and `dispose` unregisters.
 * Holding a WeakMap beside the unit instead would create a third source of
 * truth; the cache is reserved for process-local ephemera.
 */
export interface ProjectionHandle<S> {
	/** The unit's folded state for one session; undefined when the session is
	 *  unknown to the registry or the fold failed. */
	stateOf(sessionId: string): S | undefined;
	/** The unit's client view for one session. */
	viewOf(sessionId: string): unknown;
	/** Unregister the unit (withdraws its key from every future baseline). */
	dispose(): void;
}

/**
 * What a projection unit folds.
 *
 * `AgentEvent` covers the journal's wire events; `entry` covers the session
 * entries that are NOT wire events (`mode_change` among them) — a mode switch
 * is journaled as an entry, so folding entries is what makes the journal the
 * single source instead of sampling the live session. The two daemon-only facts
 * keep their own shape: `model_changed` has no payload, and
 * `session_mode_changed` is published after an RPC writes a switch.
 */
export type ProjectionEvent =
	| AgentEvent
	| { type: "entry"; entry: SessionEntry }
	| { type: "model_changed" }
	| { type: "session_mode_changed" };
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

/** Fold one journal entry onto the mode state. Pure, so `init` and `apply`
 *  share it — a seeded baseline and a live switch can never disagree. */
function applyModeEntry(state: SessionModeProjection, rawEntry: unknown): SessionModeProjection {
	const entry = rawEntry as { type?: string; mode?: unknown; data?: Record<string, unknown> } | null;
	if (entry?.type !== "mode_change") return state;
	const mode = typeof entry.mode === "string" ? entry.mode : "none";
	if (mode === "plan" || mode === "plan_paused") {
		const planFilePath = entry.data?.planFilePath;
		// `plan_paused` keeps the path but is not "in plan mode"; entering
		// without a path could never be approved, so it counts as off.
		const plan = mode === "plan" && typeof planFilePath === "string" && planFilePath !== "";
		return plan === state.plan ? state : { ...state, plan };
	}
	if (mode === "goal" || mode === "goal_paused") {
		const goal = goalFromModeData(entry.data);
		// `goal_paused` is a recorded goal that is NOT running. Projecting it as
		// an active goal would make the badge claim work the agent is not doing,
		// so only `goal` counts as on.
		const nextGoal =
			goal && mode === "goal" ? { enabled: true, objective: goal.objective, status: goal.status } : null;
		if (nextGoal === null && state.goal === null) return state;
		return { ...state, goal: nextGoal };
	}
	// Any other mode ("none", "vibe", …) means neither switch is on. Vibe is a
	// tool-set mode of its own and does not project here.
	if (state.goal === null && state.plan === false) return state;
	return { goal: null, plan: false };
}

/**
 * Session mode switches — goal and plan.
 *
 * The source is the journal, not the live session: a switch is recorded as a
 * `mode_change` entry, and this unit folds those entries. That is what makes
 * the journal the single authority — the projection derives from persisted
 * history, so a reload shows the mode the journal recorded rather than
 * whatever the fresh AgentSession happens to hold, and the
 * `session_mode_changed` boundary only re-reads after an RPC wrote the entry.
 */
export const sessionModeProjectionDefinition: ProjectionDefinition<SessionModeProjection> = {
	key: "sessionMode",
	// Fold the transcript the snapshot already carries, so an opened session
	// starts from what the journal recorded rather than from the live session's
	// freshly-initialized fields.
	init: seed => {
		let state: SessionModeProjection = { goal: null, plan: false };
		for (const entry of seed.entries) state = applyModeEntry(state, entry);
		return state;
	},
	apply: (state, event) => (event.type === "entry" ? applyModeEntry(state, event.entry) : state),
	view: (state): SessionModeProjection => state,
	viewEquals: (left, right) => left === right || JSON.stringify(left) === JSON.stringify(right),
};

/**
 * Per-session projection registry. One instance per daemon host; unit
 * definitions are contributed by the projection plugin
 * (`daemon/session-projection-plugin.ts`), which owns the registration list and
 * reverts it on fiber teardown.
 */
export class SessionProjectionRegistry {
	readonly #definitions = new Map<string, ProjectionDefinition<unknown>>();
	/** Newest install token per key — see {@link register}. */
	readonly #installs = new Map<string, object>();
	readonly #sessions = new Map<string, SessionEntryState>();

	/** Register one unit. Returns a handle so the owning domain can READ the
	 *  state it declared and unregister on teardown:
	 *  a withdrawn unit stops folding, drops out of every baseline, and its key
	 *  disappears from client snapshots.
	 *
	 *  Ownership is tracked by an install token, not by the definition object:
	 *  the same unit mounted twice (a plugin reload) yields two registrations
	 *  over one shared definition, and the earlier handle must not withdraw the
	 *  later install. */
	register<S>(definition: ProjectionDefinition<S>): ProjectionHandle<S> {
		const token = {};
		this.#installs.set(definition.key, token);
		this.#definitions.set(definition.key, definition as ProjectionDefinition<unknown>);
		return {
			stateOf: (sessionId: string) => {
				// Read through the registration token so a withdrawn unit never
				// serves a value: a disabled domain must look absent, not stale.
				if (this.#installs.get(definition.key) !== token) return undefined;
				return this.#sessions.get(sessionId)?.states.get(definition.key) as S | undefined;
			},
			viewOf: (sessionId: string) => {
				if (this.#installs.get(definition.key) !== token) return undefined;
				return this.#sessions.get(sessionId)?.views.get(definition.key);
			},
			dispose: () => {
				if (this.#installs.get(definition.key) !== token) return;
				this.#installs.delete(definition.key);
				this.#definitions.delete(definition.key);
				for (const entry of this.#sessions.values()) {
					entry.states.delete(definition.key);
					entry.views.delete(definition.key);
				}
			},
		};
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
			// One unit's bad input must not take the others down with it: a
			// throw here used to abort the whole loop, so every later unit
			// silently vanished from the baseline. A unit that cannot seed is
			// simply absent for this session, and the next `applyEvent` gives it
			// another chance.
			try {
				const state = definition.init(seed);
				entry.states.set(definition.key, state);
				entry.views.set(definition.key, definition.view(state));
			} catch {
				entry.states.delete(definition.key);
				entry.views.delete(definition.key);
			}
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
			// Same isolation as `seed`: a faulty unit is skipped for this event
			// instead of aborting the fold for every other unit.
			try {
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
			} catch {
				// Leave the last good view in place.
			}
		}
		return changes;
	}

	clear(sessionId: string): void {
		this.#sessions.delete(sessionId);
	}

	/** Registered unit keys, in registration order (diagnostics and tests). */
	keys(): string[] {
		return [...this.#definitions.keys()];
	}

	/** Drop every session's fold state, keeping the registrations. */
	clearAll(): void {
		this.#sessions.clear();
	}
}
