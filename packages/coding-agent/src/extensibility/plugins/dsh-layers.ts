/**
 * Layer-stack composition — the half of DSH's patch model this host can
 * translate faithfully.
 *
 * DSH composes a Loader tree from ordered patch layers
 * (`deepseek-harness/packages/boot/app-boot/src/profile-context.ts:63-74`):
 * bundle layers first, then the profile's own patch, then the home patch, then
 * `--patch` overlays. `applyEntryPatches`
 * (`deepseek-harness/vendor/include/src/index.ts:57-127`) then folds them in
 * order, where a patch addresses a row **by id** and replaces that row's config.
 * Later layers win.
 *
 * That fold is reproduced here verbatim in semantics because it is what makes
 * a row independently configurable: a bundle inserts rows, and a profile (or a
 * later bundle) overrides one row's config by id without touching the package.
 *
 * Two DSH behaviours are deliberately NOT reproduced, and the difference is
 * reported rather than guessed:
 *
 * - **`!!js` expressions are never evaluated.** Evaluating a value from an
 *   installed package is how a package that was merely installed ends up
 *   running code it was never given (`dsh-patch.ts` module header). A row
 *   whose `disabled` carries an expression is reported as conditional, not
 *   enabled or disabled.
 * - **Unknown-id patches warn and skip** rather than being guessed at. DSH
 *   does the same; the host keeps the diagnostic so a typo in a profile's
 *   patch does not silently do nothing.
 *
 * @module extensibility/plugins/dsh-layers
 */

import { interpolate } from "./dsh-expr";
import type { DshPatchRow, DshRowOverride, DshValue } from "./dsh-patch";

/** One layer's worth of rows, tagged with where it came from (for diagnostics). */
export interface DshLayer {
	/** Stable label: a bundle package name, `profile`, `home`, or `overlay`. */
	readonly name: string;
	readonly rows: readonly DshPatchRow[];
}

/** A row that made it through composition, with what it costs to use. */
export interface ComposedRow {
	readonly id: string;
	readonly name: string;
	/** `undefined` when no layer said anything about enabledness. */
	readonly disabled: boolean | undefined;
	/**
	 * True when the effective `disabled` came from a `!!js` expression this
	 * host does not evaluate — the row is neither confirmed enabled nor
	 * confirmed disabled, and a caller must say so rather than pick.
	 */
	readonly conditional: boolean;
	/** The row's effective config: the last layer's `config`, wholesale. */
	readonly config: DshValue | undefined;
	/** Services the row injects (union across layers, first-seen order). */
	readonly inject: readonly string[];
	readonly group: boolean;
	/** Which layers touched this row, in application order. */
	readonly layers: readonly string[];
}

/** What a composition produced, and what it could not take. */
export interface DshComposition {
	readonly rows: readonly ComposedRow[];
	/** Rows whose id a later layer addressed but which did not exist yet. */
	readonly unresolved: readonly { readonly id: string; readonly layer: string }[];
	/**
	 * Every `!!js` expression the composed rows still carry, by row id.
	 *
	 * A row counted here is *not* guaranteed to be enabled: this host will not
	 * run the expression, so the row's real enabledness is unknown at boot and
	 * the caller has to say so.
	 */
	readonly conditionalRows: readonly string[];
	/**
	 * Rows whose `!!js` expression could not be evaluated, when evaluation was
	 * asked for. Absent when nothing failed — a composition that evaluated
	 * cleanly should not have to explain an empty list.
	 */
	readonly exprFailures?: ReadonlyArray<{ readonly id: string; readonly reason: string }>;
}

/**
 * Resolve a row's `disabled` field.
 *
 * With an expression context: evaluate tagged values so a conditional row
 * settles into a real enablement. Without one (or when evaluation fails): the
 * row reports as `conditional` with `disabled: undefined`, so the caller must
 * say the enablement is unknown rather than either state being assumed.
 */
function resolveDisabled(
	value: DshValue | undefined,
	ctx: Readonly<Record<string, unknown>> | undefined,
): { disabled: boolean | undefined; conditional: boolean; failure?: string } {
	if (value === undefined) return { disabled: undefined, conditional: false };
	const { value: resolved, failures } = resolveValue(value, ctx);
	if (resolved === undefined && failures.length > 0) {
		return { disabled: undefined, conditional: true, failure: failures[0]?.reason ?? "表达式求值失败" };
	}
	if (typeof resolved === "boolean") return { disabled: resolved, conditional: false };
	// Tagged but not evaluated, or evaluated to something that is not a boolean.
	return { disabled: undefined, conditional: true };
}

/** Interpolate every `!!js` value in a field, when a context was supplied. */
function resolveValue(
	value: DshValue | undefined,
	ctx: Readonly<Record<string, unknown>> | undefined,
): { value: DshValue | undefined; failures: Array<{ path: string; reason: string }> } {
	if (value === undefined) return { value: undefined, failures: [] };
	if (!ctx) {
		// No context: leave tagged values exactly as parsed.
		return containsJsExpr(value) ? { value: undefined, failures: [] } : { value, failures: [] };
	}
	// `interpolate` walks arbitrary data, so its result is `unknown`; it only
	// ever produces JSON-shaped values (the facts are data and the expression's
	// result is returned as-is), which is what `DshValue` describes.
	return interpolate(value, ctx) as { value: DshValue | undefined; failures: Array<{ path: string; reason: string }> };
}

/** Whether a value carries a `!!js` expression (`dsh-patch`'s tagged shape). */
function isJsExpr(value: unknown): value is { kind: "js-expr"; expr: string } {
	return value !== null && typeof value === "object" && (value as { kind?: string }).kind === "js-expr";
}

/** Whether any value nested inside carries a `!!js` expression. */
function containsJsExpr(value: unknown): boolean {
	if (value === null || value === undefined) return false;
	if (isJsExpr(value)) return true;
	if (Array.isArray(value)) return value.some(containsJsExpr);
	if (typeof value === "object") return Object.values(value).some(containsJsExpr);
	return false;
}

/** Count tagged expressions in a value (the "what was dropped" number). */
export function countJsExprs(value: unknown): number {
	if (value === null || value === undefined) return 0;
	if (isJsExpr(value)) return 1;
	if (Array.isArray(value)) return value.reduce((sum, item) => sum + countJsExprs(item), 0);
	if (typeof value === "object") {
		return Object.values(value).reduce((sum, item) => sum + countJsExprs(item), 0);
	}
	return 0;
}

/**
 * A row-targeting override from a later layer: DSH's non-insert patch form.
 *
 * Re-exported rather than redeclared: `dsh-patch.ts` is where the parser
 * produces these and `dsh-layers.ts` is where they are consumed, so the type
 * lives with its producer and the dependency runs parser → composer, never
 * back. Two declarations of one shape would also make the package barrel
 * ambiguous on re-export.
 */
export type { DshRowOverride } from "./dsh-patch";

/**
 * Compose ordered patch layers into the effective row list.
 *
 * Semantics, from `applyEntryPatches`:
 * - Layers apply in order; a later layer's value wins.
 * - An `insert` appends rows (a layer may address a row an earlier layer
 *   inserted — the index is rebuilt as rows are added).
 * - An override targets a row **by id** and replaces its `config` wholesale
 *   (DSH replaces the whole config, not a deep merge; keeping that exact means
 *   a profile can *remove* a key a bundle set, which a deep merge could not).
 * - An override naming a row that does not exist is recorded in `unresolved`
 *   and skipped — never guessed at.
 * - An override whose `name` disagrees with the row it targets is skipped: the
 *   mismatch means the patch was written against a different row.
 *
 * @param layers - patch layers in application order (earlier = lower).
 * @param overrides - id-targeted overrides with the layer that declared them.
 * @param exprContext - when supplied, `!!js` values are evaluated against it
 *   (see `dsh-expr.ts`) and a conditional row resolves to a real enablement.
 *   Omitted, every tagged value is left unevaluated and such rows report as
 *   `conditional` — the caller then decides, and nothing is guessed here.
 */
export function composeDshLayers(
	layers: readonly DshLayer[],
	overrides: ReadonlyArray<{ readonly layer: string; readonly override: DshRowOverride }> = [],
	exprContext?: Readonly<Record<string, unknown>>,
): DshComposition {
	// Row index, rebuilt as rows are added so a later layer can address an
	// earlier layer's insert (the exact DSH ordering guarantee).
	const index = new Map<string, ComposedRow>();
	const order: string[] = [];
	// Expressions that could not be evaluated. Recorded per row so the caller
	// names the affected rows instead of dropping the fact on the floor.
	const exprFailures: { id: string; reason: string }[] = [];

	for (const layer of layers) {
		for (const row of layer.rows) {
			const existing = index.get(row.id);
			if (existing) {
				// Re-inserting a known id is a later layer restating the row:
				// merge its identity and config, keep first-seen ordering.
				index.set(row.id, {
					...existing,
					name: row.name || existing.name,
					layers: [...existing.layers, layer.name],
				});
				continue;
			}
			// A tagged `disabled` resolves when a context is supplied; without
			// one the row stays conditional and the caller says so.
			const { disabled, conditional, failure } = resolveDisabled(row.disabled, exprContext);
			const composed: ComposedRow = {
				id: row.id,
				name: row.name,
				disabled,
				conditional,
				config: resolveValue(row.config, exprContext).value,
				inject: [...row.inject],
				group: row.group,
				layers: [layer.name],
			};
			if (failure) exprFailures.push({ id: row.id, reason: failure });
			index.set(row.id, composed);
			order.push(row.id);
		}
	}

	const unresolved: { id: string; layer: string }[] = [];
	for (const { layer, override } of overrides) {
		const target = index.get(override.id);
		if (!target) {
			unresolved.push({ id: override.id, layer });
			continue;
		}
		if (override.name !== undefined && override.name !== target.name) {
			// Written against a different row: DSH skips with a warning, and so
			// does this — silently applying it would reconfigure the wrong thing.
			unresolved.push({ id: override.id, layer });
			continue;
		}
		// An override's fields resolve under the same rules as a row's: tagged
		// values evaluate when a context exists, and a failure keeps the row
		// conditional rather than guessing a state.
		const resolvedOverride = resolveDisabled(override.disabled, exprContext);
		if (resolvedOverride.failure) {
			exprFailures.push({ id: override.id, reason: resolvedOverride.failure });
		}
		const nextDisabled = override.disabled === undefined ? target.disabled : resolvedOverride.disabled;
		const nextConfig = resolveValue(override.config, exprContext).value;
		index.set(override.id, {
			...target,
			...(override.disabled === undefined
				? {}
				: { disabled: nextDisabled, conditional: resolvedOverride.conditional }),
			...(override.config === undefined ? {} : { config: nextConfig as DshValue }),
			layers: [...target.layers, layer],
		});
	}

	const rows = order.map(id => index.get(id)!).filter(row => row !== undefined);
	return {
		rows,
		unresolved,
		conditionalRows: rows.filter(row => row.conditional).map(row => row.id),
		...(exprFailures.length > 0 ? { exprFailures } : {}),
	};
}
