/**
 * Shared wire-event guards for host→guest/daemon replication.
 *
 * The collab host and the daemon stream only pi-wire-compatible events to
 * peers (the SDK contract pins AgentEvent/SessionEntry payloads). Non-wire
 * session internals never cross the boundary — keeping the journal, the
 * stream and the SDK contract on one format (gui-architecture Phase 3:
 * journal records wire events).
 */
import type {
	AgentEvent as WireAgentEvent,
	SessionEntry as WireSessionEntry,
	WireCustomMessage,
} from "@musepi/pi-wire";
import type { AgentSessionEvent } from "../session/agent-session-events";
import type { SessionEntry as StoredSessionEntry } from "../session/session-entries";

export const WIRE_AGENT_EVENT_TYPES: Record<WireAgentEvent["type"], true> = {
	agent_start: true,
	agent_end: true,
	turn_start: true,
	turn_end: true,
	message_start: true,
	message_update: true,
	message_end: true,
	tool_execution_start: true,
	tool_execution_update: true,
	tool_execution_end: true,
	notice: true,
	ttsr_triggered: true,
	irc_message: true,
	auto_compaction_start: true,
	auto_compaction_end: true,
	auto_retry_start: true,
	auto_retry_end: true,
	thinking_level_changed: true,
};

export const WIRE_SESSION_ENTRY_TYPES: Record<WireSessionEntry["type"], true> = {
	message: true,
	custom_message: true,
	compaction: true,
	branch_summary: true,
	model_change: true,
	thinking_level_change: true,
};

export function isWireAgentEvent(event: AgentSessionEvent): event is AgentSessionEvent & WireAgentEvent {
	return event.type in WIRE_AGENT_EVENT_TYPES;
}

/**
 * Project a session event onto the wire shape the daemon/journal/GUI share.
 * Most events are already wire-compatible; TTSR carries the FULL Rule
 * objects (paths, frontmatter, conditions) that must shrink to the wire
 * rule, and IRC carries the session CustomMessage whose content shape is
 * structurally identical to the wire one.
 */
export function toWireAgentEvent(event: AgentSessionEvent): WireAgentEvent | null {
	switch (event.type) {
		case "ttsr_triggered":
			return {
				type: "ttsr_triggered",
				rules: event.rules.map(r => ({
					name: r.name,
					...(r.description ? { description: r.description } : {}),
					...(r.content ? { content: r.content } : {}),
				})),
			};
		case "irc_message": {
			const m = event.message;
			return {
				type: "irc_message",
				message: {
					role: "custom",
					customType: m.customType,
					content: m.content as WireCustomMessage["content"],
					display: m.display,
					...(m.details !== undefined ? { details: m.details } : {}),
					...(m.attribution ? { attribution: m.attribution } : {}),
					timestamp: m.timestamp,
				},
			};
		}
		default:
			return event as unknown as WireAgentEvent;
	}
}

export function isWireSessionEntry(entry: StoredSessionEntry): entry is StoredSessionEntry & WireSessionEntry {
	return entry.type in WIRE_SESSION_ENTRY_TYPES;
}
