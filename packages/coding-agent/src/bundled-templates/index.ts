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
import { parseFrontmatter } from "@musepi/pi-utils";
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
	/** Stable id — also the rail's key, and the `skillId` in project metadata. */
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
	/**
	 * What the card's tooltip says, in both languages.
	 *
	 * The description comes from the template's own SKILL.md rather than from a
	 * string written here: a summary in this file drifts from the skill it
	 * describes the moment either is edited, and the upstream templates already
	 * carry the Chinese fields for the ones that have been translated. A template
	 * with no translation falls back to English rather than losing its tooltip.
	 *
	 * Kept whole. A skill's description is several sentences, and the tail is
	 * where it says when to reach for this shape rather than a neighbouring one
	 * — the part a person reads to decide between six prototypes. A one-line trim
	 * keeps the first sentence and drops exactly that.
	 */
	readonly description: LocalizedText;
	/** Display name, also from the frontmatter (`en_name` / `zh_name`). */
	readonly title: LocalizedText;
}

/** One string per language, with English as the fallback when a translation is
 *  absent — a partially translated catalogue still reads, rather than showing
 *  an empty card. */
export interface LocalizedText {
	readonly en: string;
	readonly zh: string | null;
}

/** Resolve a bilingual field against the active locale. */
export function localizeText(text: LocalizedText, locale: string): string {
	return locale.toLowerCase().startsWith("zh") && text.zh ? text.zh : text.en;
}

/**
 * Read a frontmatter string field as one line.
 *
 * Both steps matter for a tooltip. The trim drops a YAML block scalar's
 * trailing newline; the fold drops the soft line breaks inside one, which the
 * YAML parser keeps because the source wraps them for readability. An untrimmed
 * field arrives with a newline in the middle, and the browser's `title`
 * renders a tooltip with a hard line break in it.
 */
function readField(fm: Record<string, unknown>, key: string): string {
	return typeof fm[key] === "string" ? (fm[key] as string).replace(/\s+/g, " ").trim() : "";
}

/** Frontmatter → bilingual field, tolerating a missing translation. */
function localized(fm: Record<string, unknown>, enKey: string, zhKey: string): LocalizedText {
	const zh = readField(fm, zhKey);
	return { en: readField(fm, enKey), zh: zh === "" ? null : zh };
}

function build(name: string, tab: CreationTemplateTab, skill: string, examplePath: string): BundledTemplateDef {
	const fm = parseFrontmatter(skill).frontmatter as Record<string, unknown>;
	const title = localized(fm, "en_name", "zh_name");
	// `description` is the skill's own summary and the only one most templates
	// carry; `en_description` exists on the translated ones as an explicit
	// English side, which is what a card in an English locale should read rather
	// than whatever the shared field happens to say. English wins, then the
	// shared field, so a template is never left without a tooltip.
	const description: LocalizedText = {
		en: readField(fm, "en_description") || readField(fm, "description"),
		zh: readField(fm, "zh_description") || null,
	};
	return {
		name,
		tab,
		skill,
		examplePath,
		title: { en: title.en || name, zh: title.zh },
		description,
	};
}

/** Bundled design templates, in the order the rail lists them. */
export const BUNDLED_TEMPLATES: readonly BundledTemplateDef[] = [
	build("web-prototype", "prototype", bundledWebPrototypeSkill, bundledWebPrototypeExamplePath as unknown as string),
	build("simple-deck", "deck", bundledSimpleDeckSkill, bundledSimpleDeckExamplePath as unknown as string),
	build("image-poster", "media", bundledImagePosterSkill, bundledImagePosterExamplePath as unknown as string),
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
