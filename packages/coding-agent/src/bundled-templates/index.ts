/**
 * Bundled design templates: packaged visual shapes the agent renders into a
 * project artifact, shipped inside the CLI.
 *
 * A bundled template answers a question a saved creation template cannot. A
 * saved template (daemon/creation.ts) is a *creation-parameter* preset — the
 * platform, fidelity and kind fields a person had filled in — and its metadata
 * is capped at 16 KiB, which a rendered example never fits inside. A bundled
 * template is the *visual reference* for one shape: what "a landing page" or
 * "an operating-review deck" is supposed to look like, with a baked example the
 * rail can show before anyone commits to it.
 *
 * The two are complementary rather than competing: picking a bundled template
 * seeds a creation draft, and saving the result as a creation template keeps
 * the parameters. Both appear in the same rail, distinguished by origin.
 *
 * Provenance: the three shapes here were absorbed from open-design's
 * `design-templates/` and carry no upstream LICENSE (the licensed templates there
 * — 36 of them, third-party authorship — are deliberately not bundled; adding one
 * requires carrying its LICENSE and an attribution entry).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { CreationTemplateTab } from "../daemon/creation";
import bundledImagePosterExamplePath from "./image-poster/example.html" with { type: "file" };
// bun-types claims `*.html` as HTMLBundle, so this repo imports it as a file
// and reads it at call time (same shape as src/export/html) rather than
// overriding the ambient declaration for every package.
import bundledImagePosterSkill from "./image-poster/SKILL.md" with { type: "text" };
import bundledSimpleDeckExamplePath from "./simple-deck/example.html" with { type: "file" };
import bundledSimpleDeckSkill from "./simple-deck/SKILL.md" with { type: "text" };
import bundledWebPrototypeExamplePath from "./web-prototype/example.html" with { type: "file" };
import bundledWebPrototypeSkill from "./web-prototype/SKILL.md" with { type: "text" };

/**
 * Resolve a Bun file-loader value without parsing Windows drive letters as URL
 * schemes (mirrors src/export/html).
 */
function resolveAssetPath(assetPath: string): string {
	if (path.isAbsolute(assetPath) || path.win32.isAbsolute(assetPath)) return assetPath;
	return path.resolve(import.meta.dir, assetPath);
}

/**
 * One bundled design template.
 *
 * `tab` is the creation surface this shape belongs to, reusing the creation
 * tabs rather than introducing a second taxonomy: a prototype template belongs
 * under the prototype tab, and the rail already filters by it.
 */
export interface BundledTemplateDef {
	/** Stable id — also the rail's key. */
	readonly name: string;
	/** Surface this shape renders into. */
	readonly tab: CreationTemplateTab;
	/** The template's own SKILL.md, verbatim: the agent reads it as a skill. */
	readonly skill: string;
	/**
	 * The baked example, served as a preview. Read lazily rather than inlined:
	 * it is an order of magnitude larger than the 16 KiB a creation template's
	 * metadata allows, and a rail that never opens a card should not pay for it.
	 */
	readonly examplePath: string;
	/** Short blurb for the rail card. */
	readonly summary: string;
}

/** Bundled design templates, in the order the rail lists them. */
export const BUNDLED_TEMPLATES: readonly BundledTemplateDef[] = [
	{
		name: "web-prototype",
		tab: "prototype",
		skill: bundledWebPrototypeSkill,
		examplePath: bundledWebPrototypeExamplePath as unknown as string,
		summary: "Single self-contained HTML page — landing, marketing, docs or SaaS.",
	},
	{
		name: "simple-deck",
		tab: "deck",
		skill: bundledSimpleDeckSkill,
		examplePath: bundledSimpleDeckExamplePath as unknown as string,
		summary: "Decision-grade operating-review deck: growth, burn, path to sustainability.",
	},
	{
		name: "image-poster",
		tab: "media",
		skill: bundledImagePosterSkill,
		examplePath: bundledImagePosterExamplePath as unknown as string,
		summary: "Single-image poster or key art — provider-agnostic.",
	},
];

/** Bundled template ids (stable, for the rail's keys and tests). */
export const BUNDLED_TEMPLATE_NAMES: readonly string[] = BUNDLED_TEMPLATES.map(t => t.name);

/** The bundled template for a creation tab, or `undefined` when it has none. */
export function bundledTemplateForTab(tab: string): BundledTemplateDef | undefined {
	return BUNDLED_TEMPLATES.find(t => t.tab === tab);
}

/**
 * Read a bundled template's baked example.
 *
 * @param name - the template id.
 * @returns the example HTML, or `null` for an unknown id or a missing file —
 * a broken template must not take the rail down with it.
 */
export function readBundledTemplateExample(name: string): string | null {
	const template = BUNDLED_TEMPLATES.find(t => t.name === name);
	if (!template) return null;
	try {
		return fs.readFileSync(resolveAssetPath(template.examplePath), "utf8");
	} catch {
		return null;
	}
}
