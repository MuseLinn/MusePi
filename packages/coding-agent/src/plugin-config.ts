/**
 * The schema surface a Track A plugin uses to declare `Config`.
 *
 * `Config` is a Standard Schema (dsh's contract): the host validates the
 * effective config through it, fills its defaults, and derives the management
 * form from `toJsonSchema()`. Re-exported here so a plugin package imports one
 * specifier rather than reaching into the host's schema dependency.
 */

import type { ZodLikeSchema } from "@musepi/musepi-type/zod";

export type { ZodLikeSchema } from "@musepi/musepi-type/zod";
export { z } from "@musepi/musepi-type/zod";

/** A live config value: a field the host updates in place after a config write. */
export interface Volatile<T> {
	get(): T;
}

const VOLATILE_SCHEMA = Symbol.for("musepi.pluginConfig.volatileSchema");
const VOLATILE_REF = Symbol.for("musepi.pluginConfig.volatileRef");

/**
 * Mark one `Config` field volatile (dsh's `.volatile()`): the host returns a
 * ref and updates it in place on a config write instead of remounting the
 * plugin. The schema still validates the plain value; wrapping happens at
 * mount, so `toJsonSchema()` and the generated form do not change.
 */
export function volatile<T>(schema: ZodLikeSchema<T>): ZodLikeSchema<Volatile<T>> {
	Object.defineProperty(schema, VOLATILE_SCHEMA, { value: true, enumerable: false });
	return schema as unknown as ZodLikeSchema<Volatile<T>>;
}

/** Whether a `Config` field schema was marked through {@link volatile}. */
export function isVolatileSchema(schema: unknown): boolean {
	return (
		(typeof schema === "object" || typeof schema === "function") &&
		schema !== null &&
		(schema as Record<PropertyKey, unknown>)[VOLATILE_SCHEMA] === true
	);
}

/** Whether a mounted config value is a live ref. */
export function isVolatileRef(value: unknown): value is Volatile<unknown> & { set(next: unknown): void } {
	return typeof value === "object" && value !== null && (value as Record<PropertyKey, unknown>)[VOLATILE_REF] === true;
}

/** Wrap one validated value in a live ref the host can update in place. */
export function makeVolatileRef<T>(value: T): Volatile<T> {
	let current = value;
	const ref = { get: (): T => current } as Volatile<T> & { set(next: T): void };
	Object.defineProperty(ref, VOLATILE_REF, { value: true, enumerable: false });
	Object.defineProperty(ref, "set", {
		value: (next: T): void => {
			current = next;
		},
		enumerable: false,
	});
	return ref;
}
