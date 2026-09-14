import { describe, expect, it } from "bun:test";
import { DEFAULT_SECTION, resolveActiveSection, SECTION_ALIAS } from "./settings-nav";

/** The nav ids the pane really exposes (mirrors SettingsView's `navGroups`).
 *  Kept explicit here so the test fails loudly if a section is renamed or
 *  dropped without thinking about the alias/fallback rules. */
const NAV_IDS = new Set([
	"general",
	"appearance",
	"notifications",
	"pet",
	"sessions",
	"git",
	"shortcuts",
	"model",
	"interaction",
	"voice",
	"context",
	"shell",
	"tools",
	"media",
	"files",
	"memory",
	"skills",
	"subagents",
	"mcp",
	"commands",
	"hooks",
	"suggestions",
	"modes",
	"browser",
	"history",
	"indexes",
	"usage",
	"migration",
]);

describe("resolveActiveSection", () => {
	it("passes through a nav id unchanged", () => {
		for (const id of NAV_IDS) {
			expect(resolveActiveSection(id, NAV_IDS)).toBe(id);
		}
	});

	it("resolves capability aliases to the page that renders them", () => {
		// Regression: 添加供应商 opened settings on `providers`, which has no
		// content branch → blank pane until the user clicked a nav row.
		expect(resolveActiveSection("providers", NAV_IDS)).toBe("model");
		expect(resolveActiveSection("plugins", NAV_IDS)).toBe("skills");
		// Every alias must land on a real page.
		for (const target of Object.values(SECTION_ALIAS)) {
			expect(NAV_IDS.has(target)).toBe(true);
		}
	});

	it("falls back to the default for a DOM event handed in by an event prop", () => {
		// Regression: `onSettings={openSettings}` / `onClick={onOpenSettings}`
		// passed a MouseEvent, which was stored as the section verbatim and
		// matched no render branch.
		const fakeEvent = { type: "click", target: null, nativeEvent: {} };
		expect(resolveActiveSection(fakeEvent, NAV_IDS)).toBe(DEFAULT_SECTION);
		expect(resolveActiveSection(new Event("click"), NAV_IDS)).toBe(DEFAULT_SECTION);
	});

	it("falls back to the default for non-strings and empty input", () => {
		expect(resolveActiveSection(undefined, NAV_IDS)).toBe(DEFAULT_SECTION);
		expect(resolveActiveSection(null, NAV_IDS)).toBe(DEFAULT_SECTION);
		expect(resolveActiveSection(42, NAV_IDS)).toBe(DEFAULT_SECTION);
		expect(resolveActiveSection("", NAV_IDS)).toBe(DEFAULT_SECTION);
	});

	it("falls back to the default for a retired or unknown section id", () => {
		expect(resolveActiveSection("no-such-section", NAV_IDS)).toBe(DEFAULT_SECTION);
		// An id that exists in the type union but was removed from the nav.
		expect(resolveActiveSection("voice", new Set(["appearance"]))).toBe(DEFAULT_SECTION);
	});

	it("accepts extension tab ids on the prefix, even before they resolve", () => {
		// Extension tabs are mounted by the daemon asynchronously; an `ext:` id
		// must survive the round trip that happens before navGroups sees it.
		expect(resolveActiveSection("ext:demo.page", NAV_IDS)).toBe("ext:demo.page");
		expect(resolveActiveSection("ext:demo.page", new Set())).toBe("ext:demo.page");
	});
});
