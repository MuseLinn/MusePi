/**
 * The schema surface a Track A plugin uses to declare `Config`.
 *
 * `Config` is a Standard Schema (dsh's contract): the host validates the
 * effective config through it, fills its defaults, and derives the management
 * form from `toJsonSchema()`. Re-exported here so a plugin package imports one
 * specifier rather than reaching into the host's schema dependency.
 */

export type { ZodLikeSchema } from "@musepi/musepi-type/zod";
export { z } from "@musepi/musepi-type/zod";
