/**
 * Bundled product skills: the manifest of skills shipped inside the CLI and
 * installed once into the user-level `~/.musepi/agent/skills` (see sdk.ts
 * `ensureBundledSkills`). This module is the single inventory source for
 * both the installer and the extension center's builtin registry
 * (`extensibility/extensions-center/builtin-registry.ts`) — the registry
 * test intersects its names against `BUNDLED_SKILLS` to prove no bundled
 * skill is left unregistered.
 */
import bundledBoardDesignSkill from "./board-design/SKILL.md" with { type: "text" };
import bundledMusepiContributingSkill from "./musepi-contributing/SKILL.md" with { type: "text" };
import bundledExtensionDevSkill from "./musepi-extension-dev/SKILL.md" with { type: "text" };
import bundledMusepiHelpSkill from "./musepi-help/SKILL.md" with { type: "text" };
import bundledUiUxProMaxSkill from "./ui-ux-pro-max/SKILL.md" with { type: "text" };
import bundledWidgetDesignSkill from "./widget-design/SKILL.md" with { type: "text" };

/** Bundled skill definitions, in install order. `dir` (optional) marks a
 * multi-file skill package copied alongside the SKILL.md. */
export const BUNDLED_SKILLS = [
	{ name: "widget-design", content: bundledWidgetDesignSkill },
	{ name: "musepi-help", content: bundledMusepiHelpSkill },
	{ name: "musepi-extension-dev", content: bundledExtensionDevSkill },
	{ name: "ui-ux-pro-max", content: bundledUiUxProMaxSkill, dir: "ui-ux-pro-max" },
	{ name: "board-design", content: bundledBoardDesignSkill },
	{ name: "musepi-contributing", content: bundledMusepiContributingSkill },
] as const;

export type BundledSkillDef = (typeof BUNDLED_SKILLS)[number];

/** Bundled skill names (stable ids for the builtin registry). */
export const BUNDLED_SKILL_NAMES: readonly string[] = BUNDLED_SKILLS.map(s => s.name);
