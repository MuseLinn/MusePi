import { describe, expect, it } from "bun:test";
import { parseFrontmatter } from "@musepi/pi-utils";
import {
	BUNDLED_TEMPLATE_NAMES,
	BUNDLED_TEMPLATES,
	bundledTemplateForTab,
	localizeText,
	readBundledTemplateExample,
} from "../src/bundled-templates";

/**
 * A bundled template is the visual reference for one creation shape — what a
 * landing page or an operating-review deck is supposed to look like — sitting
 * beside the saved creation templates, which are parameter presets. The two are
 * different things and the cap that keeps creation metadata under 16 KiB is why
 * the example cannot be one of their fields.
 *
 * These cases cover what a broken absorption would look like: a template whose
 * skill body did not survive the copy, one whose example file is missing, and
 * one filed under a surface it does not belong to.
 */
describe("bundled design templates", () => {
	it("ships one template per creation surface, with distinct ids", () => {
		// A duplicate id would collapse two cards into one React key.
		expect(new Set(BUNDLED_TEMPLATE_NAMES).size).toBe(BUNDLED_TEMPLATE_NAMES.length);
		expect(BUNDLED_TEMPLATE_NAMES.length).toBeGreaterThanOrEqual(3);
	});

	it("reads every template's SKILL.md as a real skill body", () => {
		// The agent reads this text; an empty or truncated body is a template that
		// renders nothing and says nothing.
		for (const template of BUNDLED_TEMPLATES) {
			expect(template.skill.length).toBeGreaterThan(200);
			expect(template.skill).toContain("---");
			expect(template.skill).toContain(template.name);
		}
	});

	it("gives each template a description and a creation tab", () => {
		for (const template of BUNDLED_TEMPLATES) {
			expect(template.description.en.trim().length).toBeGreaterThan(0);
			expect(["prototype", "deck", "media", "live-artifact", "other"]).toContain(template.tab);
		}
	});

	it("reads both languages from the skill frontmatter, id as the fallback", () => {
		// The upstream templates carry `en_name`/`zh_name` for the translated
		// ones; the rest fall back to the id rather than an empty label.
		for (const template of BUNDLED_TEMPLATES) {
			expect(template.title.en.trim().length).toBeGreaterThan(0);
			if (template.title.zh !== null) expect(template.title.zh.trim().length).toBeGreaterThan(0);
			if (template.description.zh !== null) expect(template.description.zh.trim().length).toBeGreaterThan(0);
		}
		// simple-deck is the bundled template that ships a translation.
		const deck = BUNDLED_TEMPLATES.find(t => t.name === "simple-deck");
		expect(deck?.title.zh).toBeTruthy();
		expect(deck?.description.zh).toBeTruthy();
	});

	it("keeps the whole description rather than trimming it to one sentence", () => {
		// The card carries a name and nothing else, so the tooltip is where a shape
		// gets explained. Cutting it to the first sentence drops exactly the half
		// that tells two neighbouring templates apart — the reference product's
		// own start-from rail puts the full localized description in the tooltip.
		const prototype = BUNDLED_TEMPLATES.find(t => t.name === "web-prototype")!;
		const fm = parseFrontmatter(prototype.skill).frontmatter as Record<string, unknown>;
		expect(prototype.description.en).toBe((fm.description as string).replace(/\s+/g, " ").trim());
		// Its description is three sentences; a one-line trim would keep one.
		expect(prototype.description.en.split(/[.!?。！？]\s/).filter(s => s.trim()).length).toBeGreaterThan(1);
		// It ends on the last sentence, not the first: the tail is what says
		// "default when nothing more specific matches", which is the whole reason
		// to prefer this shape over the six other prototypes.
		expect(prototype.description.en).toContain("when no more specific skill matches");
		// A hard line break inside a tooltip renders as a broken two-row bubble.
		expect(prototype.description.en).not.toContain("\n");
	});

	it("prefers the explicit English side when a template ships one", () => {
		// `en_description` exists on the translated templates as the English half
		// of a pair; a template that carries it must not fall back to the shared
		// `description`, which may describe the same thing in the other language.
		const deck = BUNDLED_TEMPLATES.find(t => t.name === "simple-deck")!;
		const fm = parseFrontmatter(deck.skill).frontmatter as Record<string, unknown>;
		expect(fm.en_description).toBeTruthy();
		expect(deck.description.en).toBe((fm.en_description as string).trim());
		expect(deck.description.zh).toBe((fm.zh_description as string).trim());
	});

	it("localizes against the active locale and falls back to English", () => {
		const deck = BUNDLED_TEMPLATES.find(t => t.name === "simple-deck")!;
		// A translated template reads in Chinese and in English.
		expect(deck.title.zh).not.toBeNull();
		expect(localizeText(deck.title, "zh-CN")).toBe(deck.title.zh!);
		expect(localizeText(deck.title, "en-US")).toBe(deck.title.en);
		// An untranslated one is English in every locale rather than blank.
		const untranslated = BUNDLED_TEMPLATES.find(t => t.title.zh === null)!;
		expect(localizeText(untranslated.title, "zh-CN")).toBe(untranslated.title.en);
	});

	it("covers prototype, deck and media — one of each shape class", () => {
		// The three classes behave differently downstream (a deck navigates in an
		// iframe, a prototype responds to viewport), so covering all three is what
		// makes this a useful sample rather than three of the same thing.
		const tabs = BUNDLED_TEMPLATES.map(t => t.tab);
		expect(tabs).toContain("prototype");
		expect(tabs).toContain("deck");
		expect(tabs).toContain("media");
	});

	it("reads every bundled example off disk", () => {
		for (const template of BUNDLED_TEMPLATES) {
			const html = readBundledTemplateExample(template.name);
			expect(html).not.toBeNull();
			expect(html!.length).toBeGreaterThan(200);
			expect(html!.toLowerCase()).toContain("html");
		}
	});

	it("ships a deck a person can move through inside the card's iframe", () => {
		// The card renders the example in a sandboxed iframe and does not drive
		// it, so a deck with no navigation of its own shows one slide and no way
		// to reach the rest.
		//
		// Two models satisfy that, and they are checked as alternatives rather
		// than as one list: a deck may drive itself from key/wheel/touch events,
		// or it may hand the job to the platform with CSS scroll snapping and
		// read its position back from scroll. Requiring both would reject either
		// a correct keyboard-driven deck or a correct scroll-snap one.
		for (const template of BUNDLED_TEMPLATES.filter(t => t.tab === "deck")) {
			const html = readBundledTemplateExample(template.name)!.toLowerCase();
			expect(html).toContain("keydown");
			expect(html).toContain("arrowright");
			expect(html).toContain("arrowleft");
			const selfDriving = html.includes("touchstart") || html.includes("deltay");
			const snapDriven = html.includes("scroll-snap");
			expect({ template: template.name, navigable: selfDriving || snapDriven }).toEqual({
				template: template.name,
				navigable: true,
			});
		}
	});

	it("keeps every bundled example self-contained, with no off-host asset", () => {
		// A card renders through `srcDoc` with scripts allowed. A stylesheet or
		// image fetched over the network inside that frame is a blank card on a
		// slow link and an unexpected outbound request on a private one, so a
		// template that needs one does not ship.
		for (const template of BUNDLED_TEMPLATES) {
			const html = readBundledTemplateExample(template.name)!;
			const remote = html.match(/(?:src|href)\s*=\s*["'](?:https?:)?\/\/[^"']+/gi) ?? [];
			expect({ template: template.name, remote: remote.length }).toEqual({ template: template.name, remote: 0 });
		}
	});

	it("resolves a template by its creation tab", () => {
		expect(bundledTemplateForTab("deck")?.name).toBe("simple-deck");
		expect(bundledTemplateForTab("nope")).toBeUndefined();
	});

	it("answers null for an unknown template instead of throwing", () => {
		// The rail asks about ids from persisted layouts; a stale one must not take
		// the panel down.
		expect(readBundledTemplateExample("not-a-template")).toBeNull();
	});
});
