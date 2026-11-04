/**
 * Contract: the file-tool guidance lives in the `file-tools` bundled plugin and
 * registers on the session prompt host as tool sections.
 *
 * Each section is owned by the plugin, appears only while its tool (or a
 * declared wire name) is active, and disappears when the registration is
 * disposed or the owner is released.
 */
import { describe, expect, it } from "bun:test";
import { PromptHost } from "@musepi/pi-coding-agent/prompts/host";
import { PROMPT_ORDERS } from "@musepi/pi-coding-agent/prompts/orders";
import { FILE_TOOLS_OWNER, registerFileToolPrompts } from "../src/bundled-plugins/file-tools/prompts";

function install(): { host: PromptHost; dispose: () => void } {
	const host = new PromptHost();
	return { host, dispose: registerFileToolPrompts(host) };
}

function names(host: PromptHost, activeTools: readonly string[]): string[] {
	return host.assemble({ activeTools }).sections.map(section => section.name);
}

function textFor(host: PromptHost, activeTools: readonly string[], name: string): string {
	return host.assemble({ activeTools }).sections.find(section => section.name === name)?.text ?? "";
}

describe("file-tools plugin: read", () => {
	it("registers tool:read at the tool anchor under the plugin owner", () => {
		const { host } = install();
		const [section] = host.assemble({ activeTools: ["read"] }).sections;
		expect(section).toMatchObject({
			name: "tool:read",
			order: PROMPT_ORDERS.tool,
			owner: FILE_TOOLS_OWNER,
			source: FILE_TOOLS_OWNER,
		});
	});

	it("omits tool:read while read is inactive", () => {
		const { host } = install();
		expect(names(host, [])).not.toContain("tool:read");
		expect(names(host, ["write"])).not.toContain("tool:read");
	});

	it("renders the read guidance verbatim", () => {
		const { host } = install();
		expect(textFor(host, ["read"], "tool:read")).toBe(
			[
				"- File/directory reads → `read`; directory path lists entries.",
				"- Use `read` offset/limit, not whole-file reads.",
			].join("\n"),
		);
	});

	it("removes tool:read when the plugin registration is disposed", () => {
		const { host, dispose } = install();
		expect(names(host, ["read"])).toContain("tool:read");
		dispose();
		expect(names(host, ["read"])).not.toContain("tool:read");
	});
});

describe("file-tools plugin: write", () => {
	it("registers and gates tool:write on the write tool", () => {
		const { host } = install();
		expect(names(host, ["write"])).toEqual(["tool:write"]);
		expect(names(host, ["bash"])).toEqual([]);
	});

	it("renders the write guidance verbatim", () => {
		const { host } = install();
		expect(textFor(host, ["write"], "tool:write")).toBe("- Create/overwrite → `write`.");
	});

	it("removes tool:write when the owner is released", () => {
		const { host } = install();
		host.removeByOwner(FILE_TOOLS_OWNER);
		expect(names(host, ["write"])).toEqual([]);
	});
});

describe("file-tools plugin: edit", () => {
	it("registers and gates tool:edit on the edit tool", () => {
		const { host } = install();
		expect(names(host, ["edit"])).toEqual(["tool:edit"]);
		expect(names(host, ["bash"])).toEqual([]);
	});

	it("activates through the real apply_patch wire name and renders it", () => {
		const { host } = install();
		expect(textFor(host, ["apply_patch"], "tool:edit")).toBe("- Surgical edits → `apply_patch`.");
	});

	it("removes tool:edit when the plugin registration is disposed", () => {
		const { host, dispose } = install();
		dispose();
		expect(names(host, ["edit"])).toEqual([]);
	});
});

describe("file-tools plugin: grep", () => {
	it("registers and gates tool:grep on the grep tool", () => {
		const { host } = install();
		expect(names(host, ["grep"])).toEqual(["tool:grep"]);
		expect(names(host, ["bash"])).toEqual([]);
	});

	it("renders the search routing and data-source retrieval contract", () => {
		const { host } = install();
		const text = textFor(host, ["grep"], "tool:grep");
		expect(text).toContain("- Regex search/target location → `grep`, not shell `grep`, `rg`, `awk`.");
		expect(text).toContain("# Data Sources");
		expect(text).toContain("Text-retrieve BEFORE semantic query");
		expect(text).toContain("`grep` the file for the identifier or literal you need");
		expect(text).toContain("NOT evidence the field is missing");
		expect(text).toContain("WKT, alias, nested key");
		expect(text).toContain("invisible to them");
	});

	it("removes tool:grep when the owner is released", () => {
		const { host } = install();
		host.removeByOwner(FILE_TOOLS_OWNER);
		expect(names(host, ["grep"])).toEqual([]);
	});
});

describe("file-tools plugin: glob", () => {
	it("registers and gates tool:glob on the glob tool", () => {
		const { host } = install();
		expect(names(host, ["glob"])).toEqual(["tool:glob"]);
		expect(names(host, ["bash"])).toEqual([]);
	});

	it("renders the glob guidance verbatim", () => {
		const { host } = install();
		expect(textFor(host, ["glob"], "tool:glob")).toBe(
			"- Structure mapping/globbing → `glob`, not `ls **/*.ext` or `fd`.",
		);
	});

	it("removes tool:glob when the plugin registration is disposed", () => {
		const { host, dispose } = install();
		dispose();
		expect(names(host, ["glob"])).toEqual([]);
	});
});

describe("file-tools plugin: AST", () => {
	it("registers one tool:ast section gated on either AST tool", () => {
		const { host } = install();
		expect(names(host, ["ast_grep"])).toEqual(["tool:ast"]);
		expect(names(host, ["ast_edit"])).toEqual(["tool:ast"]);
		expect(names(host, ["bash"])).toEqual([]);
	});

	it("renders only the active AST lines", () => {
		const { host } = install();
		const grepOnly = textFor(host, ["ast_grep"], "tool:ast");
		expect(grepOnly).toContain("# AST");
		expect(grepOnly).toContain("- Structural discovery → `ast_grep`.");
		expect(grepOnly).not.toContain("Codemods");

		const editOnly = textFor(host, ["ast_edit"], "tool:ast");
		expect(editOnly).toContain("- Codemods → `ast_edit`.");
		expect(editOnly).not.toContain("Structural discovery");
	});

	it("renders both AST lines through the active tool refs", () => {
		const { host } = install();
		const text = host
			.assemble({
				activeTools: ["sg", "codemod"],
				context: { toolRefs: { ast_grep: "sg", ast_edit: "codemod" } },
			})
			.sections.find(section => section.name === "tool:ast")?.text;
		expect(text).toContain("- Structural discovery → `sg`.");
		expect(text).toContain("- Codemods → `codemod`.");
	});

	it("removes tool:ast when the owner is released", () => {
		const { host } = install();
		host.removeByOwner(FILE_TOOLS_OWNER);
		expect(names(host, ["ast_grep", "ast_edit"])).toEqual([]);
	});
});

describe("file-tools plugin lifecycle", () => {
	it("registers one section per tool and re-registration stays idempotent", () => {
		const host = new PromptHost();
		registerFileToolPrompts(host);
		registerFileToolPrompts(host);
		const sections = host.assemble({
			activeTools: ["read", "write", "edit", "grep", "glob", "ast_grep", "ast_edit"],
		}).sections;
		expect(sections).toHaveLength(6);
		expect(new Set(sections.map(section => section.owner))).toEqual(new Set([FILE_TOOLS_OWNER]));
	});

	it("does not leak sections after owner release", () => {
		const { host } = install();
		expect(host.assemble({ activeTools: ["read", "write", "edit", "grep", "glob"] }).sections).toHaveLength(5);
		host.removeByOwner(FILE_TOOLS_OWNER);
		expect(host.assemble({ activeTools: ["read", "write", "edit", "grep", "glob"] }).sections).toEqual([]);
	});
});
