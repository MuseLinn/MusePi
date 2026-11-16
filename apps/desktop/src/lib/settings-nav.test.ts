// SettingsNav imports icon components that build DOM nodes at module scope, so
// the shim must precede it (same reason the other component tests do this).
import "../../test/happy-dom-shim";
import { describe, expect, it } from "bun:test";
import { navGroups } from "../components/SettingsNav";
import { DEFAULT_SECTION, resolveActiveSection, SECTION_ALIAS } from "./settings-nav";

/** The nav ids the pane really exposes, read from the same `navGroups` the
 *  sidebar renders. A hand-copied list drifted from the real nav — it still
 *  carried ids that had become aliases (sessions / memory / suggestions / mcp)
 *  — so the "every alias lands on a real page" check was testing a fiction.
 *
 *  `navGroups` takes extension tabs, which need a daemon; none is registered
 *  here, so this reflects the built-in rows. */
function navIds(): Set<string> {
	const ids = new Set<string>();
	for (const group of navGroups([])) {
		for (const item of group.items) ids.add(item.id);
	}
	return ids;
}

const NAV_IDS = navIds();

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
		// 0.5.1: 设置侧「插件」独立 tab 已摘除（插件列表归一级能力中心），
		// "plugins" 成为能力别名，存量深链落到「扩展与插件」控制中心。
		expect(resolveActiveSection("plugins", NAV_IDS)).toBe("skills");
		// MCP servers are a connector kind: the retired page id must reach the
		// connector page rather than falling back to the default.
		expect(resolveActiveSection("mcp", NAV_IDS)).toBe("connectors");
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
