/**
 * The design preset's persona and workflow, owned by its own plugin package.
 *
 * The preset keeps only its composition (persona package, product skills,
 * model/tool state). Text lives in this package's Markdown files; mounting the
 * preset row registers the sections, and disposing the fiber removes them with
 * the rest of the preset. Nothing in `presets/resolve.ts` restates this text,
 * so an edited or disabled row cannot leave a stale design brief behind.
 */
import type { ExtensionAPI } from "../../extensibility/extensions/types";
import artifact from "./artifact.md" with { type: "text" };
import boundary from "./boundary.md" with { type: "text" };
import brief from "./brief.md" with { type: "text" };
import role from "./role.md" with { type: "text" };
import workflow from "./workflow.md" with { type: "text" };

/** Plugin identity in the Cordis runtime. */
export const name = "musepi-preset-design";

/** No host services required; the contribution is registration-only. */
export const inject = [] as const;
export const provide = [] as const;

const trimDocument = (document: string): string => document.replace(/\r?\n$/, "");

/** The sections this package owns, in prompt order. */
export const designPersonaSections = [
	{ name: "mode:design:role", order: 25, text: trimDocument(role) },
	{ name: "mode:design:workflow", order: 30, text: trimDocument(workflow) },
	{ name: "mode:design:brief", order: 35, text: trimDocument(brief) },
	{ name: "mode:design:artifact", order: 40, text: trimDocument(artifact) },
	{ name: "mode:design:boundary", order: 45, text: trimDocument(boundary) },
] as const;

/** Cordis entry: register the design sections on the fiber that owns them. */
export function apply(ctx: ExtensionAPI): void {
	ctx.setLabel("MusePi Design Persona");
	for (const section of designPersonaSections) ctx.prompts.register(section);
}
