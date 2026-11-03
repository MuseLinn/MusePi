import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@musepi/pi-agent-core";
import { type AdvisorPrimaryTurnEndListener, CordisAdvisorLifecycle } from "../src/session/advisor-lifecycle-plugin";
import { SessionAdvisors, type SessionAdvisorsHost } from "../src/session/session-advisors";

function createLifecycle(events: string[]) {
	const turnListeners = new Set<AdvisorPrimaryTurnEndListener>();
	const lifecycle = new CordisAdvisorLifecycle({
		host: { settings: { get: () => "off" } } as unknown as SessionAdvisorsHost,
		advisorOptions: { enabled: false },
		subscribeTurnEnd: listener => {
			turnListeners.add(listener);
			return () => {
				events.push("unsubscribe");
				turnListeners.delete(listener);
			};
		},
	});
	return { lifecycle, turnListeners };
}

describe("CordisAdvisorLifecycle", () => {
	it("constructs the controller and delivers the first turn before the fiber is ready", async () => {
		const events: string[] = [];
		const { lifecycle, turnListeners } = createLifecycle(events);
		expect(lifecycle.advisors).toBeInstanceOf(SessionAdvisors);
		expect(lifecycle.advisors.isAdvisorEnabled()).toBe(false);
		expect(turnListeners.size).toBe(1);

		lifecycle.advisors.onPrimaryTurnEnd = async () => {
			events.push("turn");
		};
		const messages: AgentMessage[] = [{ role: "user", content: "hello", timestamp: Date.now() }];
		for (const listener of turnListeners) await listener(messages, false);
		expect(events).toEqual(["turn"]);

		await lifecycle.ready();
		expect(lifecycle.fiber.state).toBe(2); // FiberState.ACTIVE (const enum has no runtime export).
		await lifecycle.dispose();
		expect(lifecycle.fiber.state).toBe(4); // FiberState.DISPOSED.
		expect(turnListeners.size).toBe(0);
	});

	it("unsubscribes, stops runtimes, and awaits recorder close in fiber disposal order", async () => {
		const events: string[] = [];
		const recorderClosed = Promise.withResolvers<void>();
		const stopStarted = Promise.withResolvers<void>();
		const { lifecycle } = createLifecycle(events);
		lifecycle.advisors.stopRuntime = () => {
			events.push("runtime-stop", "recorder-close-start");
			stopStarted.resolve();
			return recorderClosed.promise.then(() => {
				events.push("recorder-closed");
			});
		};

		let disposed = false;
		const disposing = lifecycle.dispose().then(() => {
			disposed = true;
		});
		await stopStarted.promise;
		expect(events).toEqual(["unsubscribe", "runtime-stop", "recorder-close-start"]);
		expect(disposed).toBe(false);

		recorderClosed.resolve();
		await disposing;
		expect(events).toEqual(["unsubscribe", "runtime-stop", "recorder-close-start", "recorder-closed"]);
		expect(lifecycle.fiber.state).toBe(4);
	});
});
