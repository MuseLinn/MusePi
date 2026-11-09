import { describe, expect, it } from "bun:test";
import { apply } from "../src/bundled-plugins/idle-maintenance/index";

interface FakeTimer {
	callback: () => void;
	ms: number;
	cleared: boolean;
}

interface Quirks {
	tokens?: number;
	idle?: boolean;
	settled?: boolean;
	draft?: boolean;
	reply?: string;
	withRecapHost?: boolean;
}

function makeContext(values: Record<string, unknown>, initial: Quirks = {}) {
	const timers = new Set<FakeTimer>();
	const runs: number[] = [];
	const prompts: string[] = [];
	const recorded: string[] = [];
	const shown: string[] = [];
	const order: string[] = [];
	let tokens = initial.tokens ?? 150_000;
	let idle = initial.idle ?? true;
	let settled = initial.settled ?? true;
	let draft = initial.draft ?? false;

	const ctx: Record<string, unknown> = {
		sessionManager: { getSessionName: () => undefined },
		settings: { get: (key: string) => values[key] },
		getContextUsage: () => ({ tokens }),
		isIdle: () => idle,
		isSettled: () => settled,
		hasDraftInput: () => draft,
		runIdleCompaction: async () => {
			runs.push(tokens);
		},
		getGoalModeState: () => ({ goal: { objective: "Ship the parser rewrite" } }),
		getTodoPhases: () => [{ name: "Work", tasks: [{ content: "Wire the focused test", status: "in_progress" }] }],
		recordRecap: (reply: string) => {
			recorded.push(reply);
			order.push("record");
		},
		showRecap: (reply: string) => {
			shown.push(reply);
			order.push("show");
		},
		setTimeout: (callback: () => void, ms: number) => {
			const timer: FakeTimer = { callback, ms, cleared: false };
			timers.add(timer);
			return timer as never;
		},
		clearTimer: (timer: FakeTimer) => {
			timer.cleared = true;
			timers.delete(timer);
		},
	};
	if (initial.withRecapHost !== false) {
		ctx.runEphemeralTurn = async ({ promptText }: { promptText: string }) => {
			prompts.push(promptText);
			await Bun.sleep(1);
			return { replyText: initial.reply ?? "Parser rewrite is mid-flight; next is the focused token test." };
		};
	}

	return {
		ctx,
		timers,
		runs,
		prompts,
		recorded,
		shown,
		order,
		setTokens: (next: number) => {
			tokens = next;
		},
		setIdle: (next: boolean) => {
			idle = next;
		},
		setSettled: (next: boolean) => {
			settled = next;
		},
		setDraft: (next: boolean) => {
			draft = next;
		},
		fire: (ms: number) => {
			for (const timer of [...timers]) {
				if (timer.ms !== ms) continue;
				timers.delete(timer);
				timer.callback();
			}
		},
	};
}

function harness(overrides: Record<string, unknown> = {}, initial: Quirks = {}) {
	const values: Record<string, unknown> = {
		"compaction.idleEnabled": true,
		"compaction.enabled": true,
		"compaction.idleThresholdTokens": 100_000,
		"compaction.idleTimeoutSeconds": 300,
		"recap.enabled": true,
		"recap.idleSeconds": 240,
		...overrides,
	};
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(event, handler),
	} as never;
	apply(pi);

	const primary = makeContext(values, initial);
	const emit = (event: string, ctx: object = primary.ctx, payload: unknown = {}) =>
		handlers.get(event)?.(payload, ctx);

	return {
		...primary,
		values,
		emit,
		emitTo: (event: string, ctx: object) => handlers.get(event)?.({}, ctx),
		newSession: (sessionInitial: Quirks = {}) => makeContext(values, sessionInitial),
	};
}

describe("idle maintenance plugin", () => {
	it("does not schedule either pass while both are disabled", () => {
		const harnessed = harness({ "compaction.idleEnabled": false, "recap.enabled": false });
		harnessed.emit("agent_end");
		expect(harnessed.timers.size).toBe(0);
	});

	it("arms both the compaction and recap timers from one agent_end", () => {
		const harnessed = harness();
		harnessed.emit("agent_end");
		expect([...harnessed.timers].map(timer => timer.ms).sort((a, b) => a - b)).toEqual([240_000, 300_000]);
	});

	it("runs compaction when its timer fires above the threshold", async () => {
		const harnessed = harness();
		harnessed.emit("agent_end");
		harnessed.fire(300_000);
		await Bun.sleep(1);
		expect(harnessed.runs).toEqual([150_000]);
	});

	it("does not schedule compaction below the token threshold", () => {
		const harnessed = harness({}, { tokens: 50_000 });
		harnessed.emit("agent_end");
		expect([...harnessed.timers].map(timer => timer.ms)).toEqual([240_000]);
	});

	it("runs the recap with goal and todo anchors, records it, then shows it", async () => {
		const harnessed = harness();
		harnessed.emit("agent_end");
		harnessed.fire(240_000);
		await Bun.sleep(1);
		expect(harnessed.prompts).toHaveLength(1);
		expect(harnessed.prompts[0]).toContain("Ship the parser rewrite");
		expect(harnessed.prompts[0]).toContain("Wire the focused test");
		expect(harnessed.recorded).toEqual(["Parser rewrite is mid-flight; next is the focused token test."]);
		expect(harnessed.shown).toEqual(harnessed.recorded);
		expect(harnessed.order).toEqual(["record", "show"]);
	});

	it("drops a recap that lands after the session became busy", async () => {
		const harnessed = harness();
		harnessed.emit("agent_end");
		harnessed.fire(240_000);
		harnessed.setIdle(false);
		await Bun.sleep(1);
		expect(harnessed.recorded).toEqual([]);
		expect(harnessed.shown).toEqual([]);
	});

	it("drops a recap that lands after a newer turn started", async () => {
		const harnessed = harness();
		harnessed.emit("agent_end");
		harnessed.fire(240_000);
		harnessed.emit("turn_start");
		await Bun.sleep(1);
		expect(harnessed.recorded).toEqual([]);
		expect(harnessed.shown).toEqual([]);
	});

	it("does not schedule while the composer holds a draft", () => {
		const harnessed = harness({}, { draft: true });
		harnessed.emit("agent_end");
		expect(harnessed.timers.size).toBe(0);
	});

	it("does not schedule while background work is unsettled", () => {
		const harnessed = harness({}, { settled: false });
		harnessed.emit("agent_end");
		expect(harnessed.timers.size).toBe(0);
	});

	it("cancels both timers on turn start or host maintenance", () => {
		for (const event of ["turn_start", "input", "auto_compaction_start", "session_switch", "session_shutdown"]) {
			const harnessed = harness();
			harnessed.emit("agent_end");
			harnessed.emit(event);
			expect(harnessed.timers.size, event).toBe(0);
		}
	});

	it("skips the recap when the host lacks the ephemeral or display capability", () => {
		const harnessed = harness({}, { withRecapHost: false });
		harnessed.emit("agent_end");
		expect([...harnessed.timers].map(timer => timer.ms)).toEqual([300_000]);
	});

	it("keeps each session's timers independent when the instance is shared", async () => {
		const harnessed = harness();
		const second = harnessed.newSession({ tokens: 120_000 });

		harnessed.emit("agent_end");
		harnessed.emitTo("agent_end", second.ctx);
		expect(harnessed.timers.size).toBe(2);
		expect(second.timers.size).toBe(2);

		second.fire(240_000);
		await Bun.sleep(1);
		expect(second.shown).toHaveLength(1);
		expect(harnessed.shown).toHaveLength(0);

		harnessed.emitTo("turn_start", second.ctx);
		expect(harnessed.timers.size).toBe(2);
		expect(second.timers.size).toBe(0);
	});

	it("re-reads settings on every settlement", () => {
		const harnessed = harness();
		harnessed.emit("agent_end");
		harnessed.values["recap.enabled"] = false;
		harnessed.emit("turn_start");
		harnessed.emit("agent_end");
		expect([...harnessed.timers].map(timer => timer.ms)).toEqual([300_000]);
	});
});
