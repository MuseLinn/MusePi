import { describe, expect, it } from "bun:test";
import {
	BUNDLED_TEMPLATE_NAMES,
	BUNDLED_TEMPLATES,
	bundledTemplateForTab,
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

	it("gives each template a summary and a creation tab", () => {
		for (const template of BUNDLED_TEMPLATES) {
			expect(template.summary.trim().length).toBeGreaterThan(0);
			expect(["prototype", "deck", "media", "live-artifact", "other"]).toContain(template.tab);
		}
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
