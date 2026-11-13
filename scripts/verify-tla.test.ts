import { describe, expect, it } from "bun:test";
import { tlaCaseFailure } from "./verify-tla";

const counterexample = {
	name: "intent violation",
	module: "IntentBeforeEffect.tla",
	config: "IntentBeforeEffect_SyncEffect.cfg",
	expect: "counterexample",
	invariant: "EffectAfterDurable",
} as const;

describe("TLA result classification", () => {
	it("accepts only the declared invariant violation for a counterexample", () => {
		expect(tlaCaseFailure(counterexample, "Error: Invariant EffectAfterDurable is violated.", 1)).toBeNull();
		expect(tlaCaseFailure(counterexample, "Error: Invariant StartExactlyOnce is violated.", 1)).not.toBeNull();
		expect(tlaCaseFailure(counterexample, "Error: Parse error at line 4.", 1)).not.toBeNull();
		expect(tlaCaseFailure(counterexample, "Model checking completed. No error.", 0)).not.toBeNull();
	});

	it("requires a successful safe-model run", () => {
		const safe = { ...counterexample, expect: "pass" } as const;
		expect(tlaCaseFailure(safe, "Model checking completed. No error.", 0)).toBeNull();
		expect(tlaCaseFailure(safe, "Error: Invariant EffectAfterDurable is violated.", 1)).not.toBeNull();
	});
});
