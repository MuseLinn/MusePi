/** Shipped bundled skills (installer inventory + extension-center registry). */
export const BUNDLED_SKILL_NAMES: readonly string[] = [
	"widget-design",
	"musepi-help",
	"musepi-plugin-dev",
	"ui-ux-pro-max",
	"board-design",
	"office",
];

/** Skills that used to ship inside a plugin package. Kept for migration only:
 *  `musepi-contributing` now lives in the repository's `.agents/skills`, so an
 *  old untouched copy installed next to the user's skills is pruned once. */
export const LEGACY_PLUGIN_OWNED_SKILLS: readonly string[] = ["musepi-contributing"];
