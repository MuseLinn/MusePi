/**
 * Live subagent transcripts, projected from the daemon's event stream.
 *
 * A subagent's conversation used to reach the GUI only as bytes: the panel
 * polled `agents.transcript` every 1.2s and re-parsed the child's JSONL. The
 * executor has always emitted every frame on `TASK_SUBAGENT_EVENT_CHANNEL`,
 * but the daemon forwarded only progress/lifecycle, so those frames stopped
 * at the daemon.
 *
 * Now they ride the parent session's stream as `agent-event`, and this module
 * projects them with the SAME `MaterializedView` the main transcript uses —
 * one projection contract, no second parser, no timer.
 *
 * Two sources feed one view per agent:
 * - the seeded history, restored once when the view opens, so a finished or
 *   already-running agent starts with its earlier turns;
 * - live `agent-event` frames, applied as they arrive.
 *
 * They cannot double up: `MaterializedView` keys a message by
 * `role:timestamp` (or `toolResult:<id>`), and `fromSnapshot` keeps the ids it
 * is given — which are exactly the ids the daemon's snapshot path produces
 * (`rekeyEntriesToViewSpace`). A live frame for a seeded message therefore
 * upserts that row instead of adding a second one.
 */
import type { AgentEvent, SessionEntry } from "@musepi/pi-wire";
import { MaterializedView } from "@musepi/sdk";

interface AgentTranscript {
	view: MaterializedView;
	/** A history seed has been applied; a second read is a no-op. */
	seeded: boolean;
}

const transcripts = new Map<string, AgentTranscript>();
const listeners = new Set<() => void>();
const EMPTY: readonly SessionEntry[] = [];

function notify(): void {
	for (const listener of listeners) listener();
}

/** Subscribe to any projection change. Returns the unsubscribe function. */
export function subscribeAgentTranscripts(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Restore a view from rows already in view space (ids preserved verbatim). */
function viewFrom(agentId: string, entries: readonly SessionEntry[]): MaterializedView {
	return (
		MaterializedView.fromSnapshot(agentId, "", {
			entries,
			cursor: 0,
			header: {},
			state: { isStreaming: false, queuedMessageCount: 0, cwd: "", participants: [] },
			agents: [],
			roundDurations: [],
		}) ?? MaterializedView.replay(agentId, "", [])
	);
}

function entryFor(agentId: string): AgentTranscript {
	let record = transcripts.get(agentId);
	if (!record) {
		record = { view: viewFrom(agentId, []), seeded: false };
		transcripts.set(agentId, record);
	}
	return record;
}

/**
 * Apply one live frame. Frames for an agent nobody is watching are dropped:
 * only a mounted view retains its id, so a session spawning many subagents
 * never accumulates projections nobody reads.
 */
export function applyAgentEvent(agentId: string, event: AgentEvent): void {
	const record = transcripts.get(agentId);
	if (!record) return;
	record.view.apply(event);
	notify();
}

/**
 * Seed an agent's view from history read off disk.
 *
 * The rows replace the current view rather than merging into it: history is
 * authoritative for everything before the first live frame, and the live
 * frames that follow upsert onto these same ids. No-op after the first seed,
 * which is what makes a retried read safe.
 */
export function seedAgentTranscript(agentId: string, entries: readonly SessionEntry[]): void {
	const record = entryFor(agentId);
	if (record.seeded) return;
	record.view = viewFrom(agentId, entries);
	record.seeded = true;
	notify();
}

/** True once this agent's history has been seeded. */
export function isAgentTranscriptSeeded(agentId: string): boolean {
	return transcripts.get(agentId)?.seeded === true;
}

/** The agent's projected rows, or an empty list while nothing is known. */
export function agentTranscriptEntries(agentId: string): readonly SessionEntry[] {
	return transcripts.get(agentId)?.view.snapshot().entries ?? EMPTY;
}

/** Register interest before the first frame arrives; returns the release fn. */
export function retainAgentTranscript(agentId: string): () => void {
	entryFor(agentId);
	return () => {
		transcripts.delete(agentId);
		notify();
	};
}
