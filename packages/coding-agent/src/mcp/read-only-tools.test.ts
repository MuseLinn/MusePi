import { describe, expect, it } from "bun:test";
import { MCPTool } from "./tool-bridge";
import { filterReadOnlyTools, isReadOnlyMCPTool, type MCPServerConnection, type MCPToolDefinition } from "./types";

function tool(name: string, readOnly?: boolean): MCPToolDefinition {
	return {
		name,
		inputSchema: { type: "object" },
		...(readOnly === undefined ? {} : { annotations: { readOnlyHint: readOnly } }),
	};
}

/** Only `name` and `config.readOnlyTools` are read while tools are built. */
function connection(readOnlyTools?: boolean): MCPServerConnection {
	return {
		name: "connector:mail",
		config: { type: "http", url: "https://mail.example/mcp", readOnlyTools },
	} as MCPServerConnection;
}

describe("read-only MCP tools", () => {
	it("treats a tool without the hint as a write", () => {
		expect(isReadOnlyMCPTool(tool("send_email"))).toBe(false);
		expect(isReadOnlyMCPTool(tool("send_email", false))).toBe(false);
		expect(isReadOnlyMCPTool(tool("search_email", true))).toBe(true);
	});

	it("keeps only the annotated reads", () => {
		const tools = [tool("search_email", true), tool("send_email"), tool("delete_email", false)];
		expect(filterReadOnlyTools(tools).map(entry => entry.name)).toEqual(["search_email"]);
	});

	it("mounts every tool when the server is not read-only", () => {
		const built = MCPTool.fromTools(connection(), [tool("search_email", true), tool("send_email")]);
		expect(built.map(entry => entry.mcpToolName)).toEqual(["search_email", "send_email"]);
	});

	it("mounts only reads when the server is read-only", () => {
		const built = MCPTool.fromTools(connection(true), [tool("search_email", true), tool("send_email")]);
		expect(built.map(entry => entry.mcpToolName)).toEqual(["search_email"]);
	});

	it("mounts nothing from a server that annotates nothing", () => {
		expect(MCPTool.fromTools(connection(true), [tool("send_email")])).toEqual([]);
	});
});
