/**
 * The creator preset's persona, owned by its own plugin package.
 *
 * The preset composes this package with the product-skills package and its
 * tool/role state; the prose lives here. A preset row that is disabled or a
 * mode switch that disposes the fiber therefore removes the persona, rather
 * than falling back to an inline copy in the preset definition.
 */
import type { ExtensionAPI } from "../../extensibility/extensions/types";
import persona from "./persona.md" with { type: "text" };

/** Plugin identity in the Cordis runtime. */
export const name = "musepi-preset-creator";

/** No host services required; the contribution is registration-only. */
export const inject = [] as const;
export const provide = [] as const;

/** The section this package owns. */
export const creatorPersonaSections = [{ name: "mode:creator:role", order: 25, text: persona }] as const;

/** Cordis entry: register the persona section on the fiber that owns it. */
export function apply(ctx: ExtensionAPI): void {
	ctx.setLabel("MusePi Creator Persona");
	for (const section of creatorPersonaSections) ctx.prompts.register(section);
}
