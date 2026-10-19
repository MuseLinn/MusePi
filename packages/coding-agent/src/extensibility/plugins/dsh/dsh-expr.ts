/**
 * `!!js` expression evaluation — computing a patch's tagged values at load time.
 *
 * A patch marks values it wants computed when a row activates with the YAML tag
 * `!!js` (`disabled: !!js process.platform === 'win32'`). The reference loader
 * evaluates those against its own context:
 *
 * ```js
 * new Function('ctx', 'expr', 'with (ctx) { return eval(expr) }')
 * ```
 *
 * ## Why this host evaluates too, and why the scope is not restricted
 *
 * An earlier draft of this module evaluated against a frozen whitelist of
 * "facts" and refused any expression naming `process`, `require`, `fetch` and
 * friends. That restriction was wrong for this host, and it is worth recording
 * why so nobody reinstates it:
 *
 * **An enabled plugin already runs arbitrary code in this process.** Its entry
 * module is imported and executed, so it can reach the filesystem, the
 * environment, and the network on its own. An expression inside that same
 * package's patch file therefore adds no capability the package did not
 * already hold — the host's own trust model says as much. Restricting the
 * expression scope while leaving the module itself unrestricted is not defence,
 * it is asymmetry: it blocks the auditable, one-line, greppable form of the
 * same power while leaving the unbounded form fully open.
 *
 * The practical cost was worse than the security benefit was real: patches
 * written for this ecosystem reference `ctx.*` and `process.*`, so the
 * whitelist made every conditional row fail to evaluate and degrade to a
 * permanent "unknown" — which is exactly the state that makes the composition
 * model useless for the rows that need it.
 *
 * So: evaluate against whatever context the caller supplies, in the reference
 * loader's own shape. `with (ctx)` means an expression sees the context's
 * fields first and the ordinary globals otherwise, which is what a patch
 * author writing against that ecosystem expects.
 *
 * ## What this module still insists on
 *
 * Evaluation may FAIL, and a failure must be reported on the row it gates
 * rather than being swallowed. An expression that throws, or that names
 * something neither the context nor the globals provide, produces a recorded
 * failure. A row whose enablement could not be computed stays "unresolved" —
 * it is never treated as enabled just because evaluation went wrong, and never
 * treated as disabled either.
 */

import * as os from "node:os";

/** A `!!js` value as the parser recovers it. */
export interface DshJsExpr {
	readonly kind: "js-expr";
	readonly expr: string;
}
/** Why an expression produced no value. */
export interface ExprFailure {
	/** Human-readable reason, safe to show next to the row it gates. */
	readonly reason: string;
}

/** The outcome of resolving one expression. */
export type ExprOutcome =
	| { readonly kind: "value"; readonly value: unknown }
	| { readonly kind: "failed"; readonly failure: ExprFailure };

/**
 * Evaluate one expression against a context, in the reference loader's shape.
 *
 * `with (ctx)` puts the context's fields in scope ahead of the globals, so a
 * patch can write `profile` or `platform` bare and still reach `process` —
 * which is the behaviour such patches are authored against.
 *
 * Never throws: a failing expression is a value-shaped result so the caller can
 * attach it to the row it gates instead of failing the whole composition.
 */
export function evaluateExpr(expr: string, ctx: Readonly<Record<string, unknown>>): ExprOutcome {
	const trimmed = expr.trim();
	if (trimmed.length === 0) {
		return { kind: "failed", failure: { reason: "空表达式" } };
	}
	try {
		// No "use strict": `with` is a syntax error in strict mode, and the
		// reference loader's scope shape depends on it. Non-strict here is
		// deliberate — the expression is one line of the package's own patch,
		// which already runs unrestricted as a module.
		const run = new Function("ctx", "expr", "with (ctx) { return eval(expr) }") as (
			ctx: Readonly<Record<string, unknown>>,
			expr: string,
		) => unknown;
		return { kind: "value", value: run(ctx, trimmed) };
	} catch (error) {
		return { kind: "failed", failure: { reason: error instanceof Error ? error.message : String(error) } };
	}
}

/**
 * The context expressions are evaluated against.
 *
 * Callers supply the pieces they know (the profile name, the project paths);
 * the host fills in what it can observe about itself. Nothing here is
 * restricted — see the module header for why that is deliberate — but every
 * field is plain data, so an expression's inputs are auditable at a glance.
 */
export function hostExprContext(overrides: Record<string, unknown> = {}): Readonly<Record<string, unknown>> {
	return {
		platform: process.platform,
		arch: process.arch,
		release: os.release(),
		env: process.env,
		...overrides,
	};
}

/**
import * as os from "node:os";

/**
 * Replace every `!!js` value inside `value` with its evaluated result.
 *
 * Recursive over arrays and objects: a nested expression inside a row's
 * `config` resolves just like a top-level one.
 *
 * A value that fails to resolve becomes `undefined` **and** is recorded with
 * the path it lived at, so the caller can say which rows carry partly
 * unresolved configuration instead of shipping a half-evaluated config that
 * reads as complete.
 */
export function interpolate(
	value: unknown,
	ctx: Readonly<Record<string, unknown>>,
): { value: unknown; failures: Array<{ path: string; reason: string }> } {
	const failures: Array<{ path: string; reason: string }> = [];
	const walk = (node: unknown, path: string): unknown => {
		if (node !== null && typeof node === "object" && (node as { kind?: string }).kind === "js-expr") {
			const outcome = evaluateExpr((node as DshJsExpr).expr, ctx);
			if (outcome.kind === "value") return outcome.value;
			failures.push({ path, reason: outcome.failure.reason });
			return undefined;
		}
		if (Array.isArray(node)) return node.map((item, i) => walk(item, `${path}[${i}]`));
		if (node !== null && typeof node === "object") {
			const out: Record<string, unknown> = {};
			for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
				out[key] = walk(entry, path ? `${path}.${key}` : key);
			}
			return out;
		}
		return node;
	};
	return { value: walk(value, ""), failures };
}
