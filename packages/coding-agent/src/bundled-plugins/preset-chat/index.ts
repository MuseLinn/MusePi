/**
 * The chat preset's persona, owned by its own plugin package.
 *
 * The preset declares this package as a composition row; mounting the row is
 * what registers the section. Unmounting the preset (mode switch, disable,
 * session disposal) removes it with the fiber — there is no static fallback in
 * `presets/resolve.ts`, so a disabled row cannot leave the persona behind.
 *
 * `presetOnly` in `package.json` keeps the package out of ambient extension
 * discovery: it is a preset contribution, not something every session should
 * load and then ignore.
 */
import type { ExtensionAPI } from "../../extensibility/extensions/types";
import persona from "./persona.md" with { type: "text" };

/** Plugin identity in the Cordis runtime. */
export const name = "musepi-preset-chat";

/** No host services required; the contribution is registration-only. */
export const inject = [] as const;
export const provide = [] as const;

/** The section this package owns. Exported so callers/tests can see the owner. */
export const chatPersonaSections = [
	{
		name: "mode:chat:persona",
		order: 0,
		text: persona.replace(/\r?\n$/, ""),
	},
] as const;

/** Cordis entry: register the persona section on the fiber that owns it. */
export function apply(ctx: ExtensionAPI): void {
	ctx.setLabel("MusePi Chat Persona");
	for (const section of chatPersonaSections) ctx.prompts.register(section);
}
