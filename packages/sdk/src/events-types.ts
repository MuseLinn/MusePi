/** Runtime shape of the stream envelope (see events.ts). */
export type SessionStreamEnvelope = {
	kind:
		| "entry"
		| "event"
		| "state"
		| "approval-request"
		| "ask-request"
		| "agent-lifecycle"
		| "agent-progress"
		| "pause-state"
		| "global-pause-state"
		| "stream-end";
	seq: number;
	payload: unknown;
};
