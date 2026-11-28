// SessionScopedEventBus tags subagent channel payloads with the owning session
// so a live subagent frame cannot leak into another session's stream. The
// event channel joined that set when subagent conversations began riding the
// parent stream (agent-event) instead of being polled off disk.
import { describe, expect, test } from "bun:test";
import { SessionScopedEventBus } from "../../src/daemon/session-host";
import {
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "../../src/task/types";
import { EventBus } from "../../src/utils/event-bus";

function capture(channel: string): { bus: EventBus; seen: unknown[] } {
	const bus = new EventBus();
	const seen: unknown[] = [];
	bus.on(channel, data => seen.push(data));
	return { bus, seen };
}

describe("SessionScopedEventBus subagent tagging", () => {
	test("every subagent channel is stamped with the owning session id", () => {
		for (const channel of [
			TASK_SUBAGENT_PROGRESS_CHANNEL,
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			TASK_SUBAGENT_EVENT_CHANNEL,
		]) {
			const { bus, seen } = capture(channel);
			const scoped = new SessionScopedEventBus(bus, "session-a");
			scoped.emit(channel, { id: "agent-1" });

			expect(seen).toHaveLength(1);
			// Without this stamp the daemon has no way to tell whose subagent a
			// frame belongs to, and session B would receive session A's conversation.
			expect((seen[0] as { sessionId?: string }).sessionId).toBe("session-a");
		}
	});

	test("an already-tagged payload keeps its own session id", () => {
		const { bus, seen } = capture(TASK_SUBAGENT_EVENT_CHANNEL);
		const scoped = new SessionScopedEventBus(bus, "session-a");
		scoped.emit(TASK_SUBAGENT_EVENT_CHANNEL, { id: "agent-1", sessionId: "session-b" });

		expect((seen[0] as { sessionId?: string }).sessionId).toBe("session-b");
	});

	test("unrelated channels are passed through untouched", () => {
		const { bus, seen } = capture("some:other:channel");
		const scoped = new SessionScopedEventBus(bus, "session-a");
		scoped.emit("some:other:channel", { payload: 1 });

		expect(seen[0]).toEqual({ payload: 1 });
	});
});
