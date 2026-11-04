/**
 * Central sparse order table shared by prompt sections.
 *
 * Anchors are deliberately spaced so new slots can be inserted without
 * renumbering existing sections. Numeric orders stay valid for callers that
 * already pass slot numbers; named anchors resolve to these values.
 */
export const PROMPT_ORDERS = {
	core: 0,
	injection: 25,
	/** Anchor for per-tool prompt sections; stays inside the core slot. */
	tool: 75,
	safety: 100,
	project: 200,
	repoContext: 300,
} as const;

export type PromptOrderName = keyof typeof PROMPT_ORDERS;
export type PromptOrder = PromptOrderName | number;

/** Resolve a named anchor or validate a numeric slot. Throws on bad input. */
export function resolvePromptOrder(order: PromptOrder): number {
	if (typeof order === "number") {
		if (!Number.isFinite(order)) throw new TypeError(`prompt order must be finite: ${String(order)}`);
		return order;
	}
	if (Object.hasOwn(PROMPT_ORDERS, order)) return PROMPT_ORDERS[order];
	throw new TypeError(`unknown prompt order: ${String(order)}`);
}
