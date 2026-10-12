/**
 * `!!js` expression evaluation contract.
 *
 * The reference loader computes a patch's tagged values with
 * `with (ctx) { return eval(expr) }`, so an expression sees the context's
 * fields first and the ordinary globals otherwise. This host does the same —
 * see the module header for why the scope is not restricted: an enabled plugin
 * already runs arbitrary code here, so limiting the expression form would be
 * asymmetry, not defence.
 *
 * What is pinned here is the part that is a contract rather than a capability:
 *
 * - A conditional row RESOLVES to a real enablement when it can be computed —
 *   that is the whole point of evaluating at all.
 * - An expression that cannot be evaluated leaves the row "unresolved" and
 *   records why. It is never treated as enabled because evaluation went wrong,
 *   nor as disabled.
 * - Nested expressions (inside a row's `config`) resolve too.
 */
import { describe, expect, it } from "bun:test";
import { evaluateExpr, hostExprContext, interpolate } from "./dsh-expr";

const expr = (source: string): { kind: "js-expr"; expr: string } => ({ kind: "js-expr", expr: source });

describe("evaluateExpr", () => {
	it("resolves a platform condition against the host facts", () => {
		const ctx = hostExprContext({ profile: "desktop" });

		const outcome = evaluateExpr("platform === 'win32'", ctx);

		expect(outcome.kind).toBe("value");
		// Whatever this machine is, the row's enablement is now KNOWN rather
		// than permanently undecidable.
		if (outcome.kind === "value") {
			expect(outcome.value).toBe(process.platform === "win32");
		}
	});

	it("sees the context's own fields first", () => {
		const ctx = { profile: "work", size: 3 } as const;

		expect(evaluateExpr("profile === 'work'", ctx)).toEqual({ kind: "value", value: true });
		expect(evaluateExpr("size * 2", ctx)).toEqual({ kind: "value", value: 6 });
	});

	it("reaches ordinary globals as well, as the reference loader does", () => {
		// A patch authored against that ecosystem may reference process.* —
		// restricting this was the earlier draft's mistake.
		const ctx = hostExprContext();

		expect(evaluateExpr("typeof process === 'object'", ctx)).toEqual({ kind: "value", value: true });
	});

	it("reports a name it cannot resolve instead of silently yielding undefined", () => {
		const ctx = hostExprContext();

		const outcome = evaluateExpr("noSuchThing === 1", ctx);

		expect(outcome.kind).toBe("failed");
		// The row stays unresolved, never silently enabled.
		if (outcome.kind === "failed") expect(outcome.failure.reason).toBeTruthy();
	});

	it("reports an empty expression as a failure rather than guessing", () => {
		expect(evaluateExpr("   ", hostExprContext()).kind).toBe("failed");
	});

	it("never throws on a malformed expression", () => {
		// A composition must not fail because one row's expression is broken.
		expect(() => evaluateExpr("(((", hostExprContext())).not.toThrow();
		expect(evaluateExpr("(((", hostExprContext()).kind).toBe("failed");
	});
});

describe("interpolate", () => {
	it("resolves nested expressions inside a row's config", () => {
		const ctx = { profile: "desktop", workers: 4 } as const;

		const result = interpolate({ retries: expr("workers + 1"), name: expr("profile"), plain: 7 }, ctx);

		expect(result.value).toEqual({ retries: 5, name: "desktop", plain: 7 });
		expect(result.failures).toEqual([]);
	});

	it("records where an unresolved expression lived", () => {
		const ctx = hostExprContext();

		const result = interpolate({ inner: { bad: expr("nope") } }, ctx);

		// The path is reported so the caller can name the affected row.
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0]?.path).toBe("inner.bad");
		expect(result.value).toEqual({ inner: { bad: undefined } });
	});
});
