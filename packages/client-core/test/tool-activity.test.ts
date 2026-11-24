import { describe, expect, it } from "bun:test";
import { toolActivityKind } from "../src/lib/tool-activity";

describe("toolActivityKind", () => {
	it("maps MusePi's own built-in names", () => {
		expect(toolActivityKind("read")).toBe("reading");
		expect(toolActivityKind("write")).toBe("writing");
		expect(toolActivityKind("edit")).toBe("writing");
		expect(toolActivityKind("bash")).toBe("running-commands");
		expect(toolActivityKind("grep")).toBe("searching");
		expect(toolActivityKind("glob")).toBe("searching");
		expect(toolActivityKind("ast_grep")).toBe("searching");
		expect(toolActivityKind("ast_edit")).toBe("writing");
		expect(toolActivityKind("web_search")).toBe("searching");
		expect(toolActivityKind("browser")).toBe("browsing");
		expect(toolActivityKind("computer")).toBe("using-computer");
		expect(toolActivityKind("ask")).toBe("waiting");
		expect(toolActivityKind("todo")).toBe("waiting");
		expect(toolActivityKind("task")).toBe("working");
	});

	it("maps the Claude Code names OpenMausBot already classifies", () => {
		expect(toolActivityKind("Read")).toBe("reading");
		expect(toolActivityKind("Write")).toBe("writing");
		expect(toolActivityKind("MultiEdit")).toBe("writing");
		expect(toolActivityKind("NotebookEdit")).toBe("writing");
		expect(toolActivityKind("Bash")).toBe("running-commands");
		expect(toolActivityKind("WebSearch")).toBe("searching");
		expect(toolActivityKind("WebFetch")).toBe("browsing");
		expect(toolActivityKind("Grep")).toBe("searching");
		expect(toolActivityKind("Glob")).toBe("searching");
		expect(toolActivityKind("LS")).toBe("searching");
	});

	it("strips an mcp__server__ prefix before classifying", () => {
		expect(toolActivityKind("mcp__files__read")).toBe("reading");
		expect(toolActivityKind("mcp__shell__bash")).toBe("running-commands");
		expect(toolActivityKind("mcp__search__web_search")).toBe("searching");
	});

	it("prefers a structured kind the caller already knows", () => {
		expect(toolActivityKind("mcp__odd__thing", "diff")).toBe("writing");
		expect(toolActivityKind("mcp__odd__thing", "search")).toBe("searching");
		expect(toolActivityKind("mcp__odd__thing", "image")).toBe("working");
	});

	it("falls back to working for unknown, empty and null names", () => {
		expect(toolActivityKind("some_unknown_tool")).toBe("working");
		expect(toolActivityKind("")).toBe("working");
		expect(toolActivityKind(null)).toBe("working");
		expect(toolActivityKind(undefined)).toBe("working");
	});
});
