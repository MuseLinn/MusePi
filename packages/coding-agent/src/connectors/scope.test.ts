import { describe, expect, it } from "bun:test";
import { sanitizeMCPToolNamePart } from "../mcp/tool-bridge";
import { connectorServerNameForScope, toolBelongsToConnector, toolsForConnectorScopes } from "./scope";

/** The prefix a connector's tools are minted under, as the executor computes it. */
function prefixFor(id: string): string {
	return sanitizeMCPToolNamePart(connectorServerNameForScope(id), "server");
}

describe("connector scope", () => {
	it("predicts the prefix the tool bridge mints", () => {
		// `connector:notion` loses the colon exactly the way the bridge does.
		expect(prefixFor("notion")).toBe("connector_notion");
		expect(prefixFor("cal-com")).toBe("connector_cal_com");
	});

	it("claims a connector's own tools and nothing else", () => {
		const notion = prefixFor("notion");
		expect(toolBelongsToConnector("mcp__connector_notion_search", notion)).toBe(true);
		// A longer id that shares the prefix must not be swept in.
		expect(toolBelongsToConnector("mcp__connector_notioncal_search", notion)).toBe(false);
		expect(toolBelongsToConnector("mcp__github_list_issues", notion)).toBe(false);
	});

	it("keeps only the tools of the named connectors", () => {
		const tools = [
			"mcp__connector_notion_search",
			"mcp__connector_notion_create_page",
			"mcp__connector_linear_list_issues",
			"mcp__github_list_issues",
			"read",
		];
		expect(toolsForConnectorScopes(tools, [prefixFor("notion")])).toEqual([
			"mcp__connector_notion_search",
			"mcp__connector_notion_create_page",
		]);
		expect(toolsForConnectorScopes(tools, [prefixFor("notion"), prefixFor("linear")])).toHaveLength(3);
	});

	it("grants nothing when the connector is not connected", () => {
		// An id nobody mounted contributes no tool, instead of a prefix that
		// would match whatever connects later.
		expect(toolsForConnectorScopes(["mcp__connector_notion_search"], [prefixFor("linear")])).toEqual([]);
		expect(toolsForConnectorScopes(["mcp__connector_notion_search"], [])).toEqual([]);
	});
});
