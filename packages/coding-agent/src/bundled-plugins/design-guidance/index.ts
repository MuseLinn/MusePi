/**
 * First-party design/asset briefs as a bundled plugin.
 *
 * PLUGIN OWNERSHIP: this package owns both the prose and the section
 * registration for the design-system and asset-policy briefs. The host only
 * hands the current selection (`designSystemId`, `assetPolicy`) to prompt
 * assembly; the two `registerPrompt` sections render from that selection at
 * assembly time.
 *
 * Function text is what makes selection switching non-accumulating: one
 * section per name returns the newest brief, so repeated rebuilds or selection
 * changes cannot stack old prose. Unloading the plugin removes its source from
 * the composer, and both briefs disappear with it.
 *
 * Extension-registered design systems keep their own text in
 * `ctx.registerDesignSystem`; this plugin reads that registry only for ids it
 * does not own.
 */
import type { ExtensionAPI } from "../../extensibility/extensions/types";
import { getDesignSystem } from "../../presets/design-systems";
import {
	ASSET_POLICY_BRIEFS,
	type AssetPolicy,
	BUILTIN_DESIGN_SYSTEM_BRIEFS,
	isBuiltinDesignSystemBriefId,
} from "./briefs";

/** Plugin identity in the cordis runtime and the extension center. */
export const name = "musepi-design-guidance";

export const inject = [] as const;
export const provide = [] as const;

/** Section name and slot for the design brief (preserved from the host path). */
export const DESIGN_SYSTEM_SECTION = { name: "design-system", order: 40 } as const;
/** Section name and slot for the asset policy brief (right behind the design brief). */
export const ASSET_POLICY_SECTION = { name: "asset-policy", order: 41 } as const;

/**
 * Render the design brief for one selection.
 *
 * Built-in ids resolve from this plugin's own table; any other id is an
 * extension registration whose text lives in the design-system registry.
 * Unknown/empty ids render nothing rather than throwing.
 */
export function renderDesignSystemBrief(selection: unknown): string | undefined {
	if (typeof selection !== "string" || selection.length === 0) return undefined;
	if (isBuiltinDesignSystemBriefId(selection)) return BUILTIN_DESIGN_SYSTEM_BRIEFS[selection];
	return getDesignSystem(selection)?.promptSection?.text;
}

/** Render the asset-policy instruction for one selection. */
export function renderAssetPolicyBrief(selection: unknown): string | undefined {
	if (typeof selection !== "string" || selection.length === 0) return undefined;
	if (selection === "ai-image" || selection === "placeholder") return ASSET_POLICY_BRIEFS[selection];
	return undefined;
}

/**
 * Register both briefs.
 *
 * Text is a function on purpose: the host passes the current selection into
 * assembly, and `registerPrompt` re-renders on every rebuild. No static
 * section is registered, so a selection change replaces the rendered brief
 * instead of adding a second one.
 */
export function registerDesignGuidance(ctx: ExtensionAPI): void {
	ctx.setLabel("设计/素材简报");
	ctx.prompts.register({
		...DESIGN_SYSTEM_SECTION,
		text: context => renderDesignSystemBrief(context.designSystemId),
	});
	ctx.prompts.register({
		...ASSET_POLICY_SECTION,
		text: context => renderAssetPolicyBrief(context.assetPolicy),
	});
}

export function apply(ctx: ExtensionAPI): void {
	registerDesignGuidance(ctx);
}

export type { AssetPolicy };
