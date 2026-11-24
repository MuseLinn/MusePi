/** Runtime shape of the stream envelope (see events.ts).
 *
 * `secret-request` / `secret-request-end` joined this shape with the agent
 * secret contract. `ask-request-end`, `recap` and `title` are still missing
 * from this legacy type; extending those is a separate cleanup, not a behavior
 * change in this mission. */
export type SessionStreamEnvelope = {
	kind:
		| "entry"
		| "event"
		| "state"
		| "approval-request"
		| "ask-request"
		| "secret-request"
		| "secret-request-end"
		| "connector-request"
		| "connector-request-end"
		| "agent-lifecycle"
		| "agent-progress"
		| "pause-state"
		| "global-pause-state"
		| "stream-end";
	seq: number;
	payload: unknown;
};
