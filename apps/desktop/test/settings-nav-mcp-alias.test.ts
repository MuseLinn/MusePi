import { describe, expect, it } from "bun:test";
import { resolveActiveSection, SECTION_ALIAS } from "../src/lib/settings-nav";

/**
 * MCP servers are a connector kind, not a sibling of the connector catalog.
 *
 * The retired page duplicated the catalog's job with less information: a
 * hand-written `mcp.json` row showed a toggle but no transport, URL, or OAuth
 * login. That page's content now renders inside the connector page, and this
 * pins that the old id still lands there — a deep link resolving to the
 * default page would look like the feature disappeared.
 */
const NAV_IDS = new Set(["appearance", "connectors", "skills", "subagents", "commands", "hooks", "modes", "browser"]);

describe("settings navigation", () => {
	it("routes the retired MCP page id to the connector page", () => {
		expect(SECTION_ALIAS.mcp).toBe("connectors");
		expect(resolveActiveSection("mcp", NAV_IDS)).toBe("connectors");
		expect(resolveActiveSection("connectors", NAV_IDS)).toBe("connectors");
	});

	it("keeps an unknown section landing on the default page", () => {
		expect(resolveActiveSection("no-such-section", NAV_IDS)).toBe("appearance");
	});
});
