/**
 * Canonical model identity: `provider/id`.
 *
 * The brand is compile-time only — a `ModelRef` is a plain string at runtime, so
 * persisted sessions, settings files, CLI arguments and wire payloads keep their
 * existing format. Its purpose is to make "this value already carries both the
 * provider and the model id" a type-level fact, so an internal function cannot
 * accept a bare id where a resolved identity is required.
 */
declare const MODEL_REF_BRAND: unique symbol;

/** A string known to be the canonical `provider/id` form. */
export type ModelRef = string & { readonly [MODEL_REF_BRAND]: true };

/** Build the canonical `provider/id` form from an already-resolved pair. */
export function modelRef(provider: string, id: string): ModelRef {
	return `${provider}/${id}` as ModelRef;
}

/**
 * Accept an existing canonical string, or return `undefined` when it does not
 * carry both halves.
 *
 * Provider ids never contain `/`; model ids may (aggregator ids such as
 * `openai/gpt-oss-120b`), which is why only the first slash splits the pair.
 * Callers that need to distinguish a bare aggregator id from a provider-prefixed
 * selector must check the provider against the catalog — this function only
 * answers "is this shaped like a ref".
 */
export function asModelRef(value: string): ModelRef | undefined {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return undefined;
	return value as ModelRef;
}
