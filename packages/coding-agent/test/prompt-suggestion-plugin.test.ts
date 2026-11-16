import { describe, expect, it } from "bun:test";
import { apply } from "../src/bundled-plugins/prompt-suggestion/index";

interface Quirks {
	reply?: string;
	withComposer?: boolean;
	withSideTurn?: boolean;
	willContinue?: boolean;
	stopReason?: string;
	failures?: number;
	enabled?: boolean;
}

function makeContext(values: Record<string, unknown>, initial: Quirks = {}) {
	const prompts: string[] = [];
	const modelSources: (string | undefined)[] = [];
	const shown: string[] = [];
	let calls = 0;
	let remainingFailures = initial.failures ?? 0;
	let enabled = initial.enabled ?? true;

	const ctx: Record<string, unknown> = {
		sessionManager: { getSessionName: () => undefined },
		settings: {
			get: (key: string) => {
				if (key === "suggestion.enabled") return values[key] === undefined ? enabled : values[key];
				return values[key];
			},
		},
	};
	if (initial.withSideTurn !== false) {
		ctx.runEphemeralTurn = async (options: { promptText: string; signal?: AbortSignal; modelSource?: string }) => {
			calls += 1;
			prompts.push(options.promptText);
			modelSources.push(options.modelSource);
			if (remainingFailures > 0) {
				remainingFailures -= 1;
				throw new Error("provider rejected");
			}
			await Bun.sleep(1);
			return { replyText: initial.reply ?? "Run the tests." };
		};
	}
	if (initial.withComposer !== false) {
		ctx.showSuggestion = (suggestion: string) => shown.push(suggestion);
	}

	return {
		ctx,
		prompts,
		modelSources,
		shown,
		setEnabled(next: boolean) {
			enabled = next;
		},
		calls: () => calls,
	};
}

function harness(values: Record<string, unknown> = {}, initial: Quirks = {}) {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(event, handler),
	} as never;
	apply(pi);
	const primary = makeContext(values, initial);
	const payload = {
		type: "agent_end",
		messages: [
			{ role: "user", content: "fix the build" },
			{ role: "assistant", stopReason: initial.stopReason ?? "stop" },
		],
		...(initial.willContinue ? { willContinue: true } : {}),
	};
	const emit = (event: string, ctx: object = primary.ctx, eventPayload: unknown = payload) =>
		handlers.get(event)?.(eventPayload, ctx);
	return { ...primary, emit, payload };
}

describe("prompt suggestion plugin", () => {
	it("publishes one trimmed prediction from a completed turn", async () => {
		const harnessed = harness({}, { reply: "  Run the tests.  " });
		harnessed.emit("agent_end");
		await Bun.sleep(5);
		expect(harnessed.shown).toEqual(["Run the tests."]);
	});

	it("keeps the turn's own model so the provider's cached prefix still hits", async () => {
		const harnessed = harness();
		harnessed.emit("agent_end");
		await Bun.sleep(5);
		expect(harnessed.modelSources).toEqual(["session"]);
		expect(harnessed.prompts[0]?.length).toBeGreaterThan(0);
	});

	it("stays idle when the host has no composer", async () => {
		const harnessed = harness({}, { withComposer: false });
		harnessed.emit("agent_end");
		await Bun.sleep(5);
		expect(harnessed.calls()).toBe(0);
		expect(harnessed.shown).toEqual([]);
	});

	it("stays idle when the host cannot run a side turn", async () => {
		const harnessed = harness({}, { withSideTurn: false });
		harnessed.emit("agent_end");
		await Bun.sleep(5);
		expect(harnessed.shown).toEqual([]);
	});

	it("does nothing while the setting is off", async () => {
		const harnessed = harness({ "suggestion.enabled": false });
		harnessed.emit("agent_end");
		await Bun.sleep(5);
		expect(harnessed.calls()).toBe(0);
		expect(harnessed.shown).toEqual([]);
	});

	it("does nothing for a turn that was aborted or failed", async () => {
		for (const stopReason of ["aborted", "error"]) {
			const harnessed = harness({}, { stopReason });
			harnessed.emit("agent_end");
			await Bun.sleep(5);
			expect(harnessed.calls()).toBe(0);
		}
	});

	it("waits for a scheduled continuation instead of predicting mid-run", async () => {
		const harnessed = harness({}, { willContinue: true });
		harnessed.emit("agent_end");
		await Bun.sleep(5);
		expect(harnessed.calls()).toBe(0);
	});

	it("declines when the model answers null", async () => {
		const harnessed = harness({}, { reply: "null" });
		harnessed.emit("agent_end");
		await Bun.sleep(5);
		expect(harnessed.shown).toEqual([]);
	});

	it("retries one failed request and then stays silent", async () => {
		const harnessed = harness({}, { failures: 2 });
		harnessed.emit("agent_end");
		await Bun.sleep(5);
		expect(harnessed.calls()).toBe(2);
		expect(harnessed.shown).toEqual([]);
	});

	it("recovers when only the first attempt fails", async () => {
		const harnessed = harness({}, { failures: 1 });
		harnessed.emit("agent_end");
		await Bun.sleep(5);
		expect(harnessed.calls()).toBe(2);
		expect(harnessed.shown).toEqual(["Run the tests."]);
	});

	it("drops a prediction the user turned off while it was in flight", async () => {
		const harnessed = harness();
		harnessed.emit("agent_end");
		harnessed.setEnabled(false);
		await Bun.sleep(5);
		expect(harnessed.shown).toEqual([]);
	});

	it("a new turn supersedes the prediction of the previous one", async () => {
		const harnessed = harness({}, { reply: "stale" });
		harnessed.emit("agent_end");
		harnessed.emit("turn_start");
		await Bun.sleep(5);
		expect(harnessed.shown).toEqual([]);
	});

	it("typed input cancels the prediction", async () => {
		const harnessed = harness({}, { reply: "stale" });
		harnessed.emit("agent_end");
		harnessed.emit("input");
		await Bun.sleep(5);
		expect(harnessed.shown).toEqual([]);
	});

	it("tracks each session separately", async () => {
		const harnessed = harness({}, { reply: "for the first session" });
		const other = makeContext({}, { reply: "for the second session" });
		harnessed.emit("agent_end", harnessed.ctx);
		harnessed.emit("agent_end", other.ctx);
		await Bun.sleep(5);
		expect(harnessed.shown).toEqual(["for the first session"]);
		expect(other.shown).toEqual(["for the second session"]);
	});
});
