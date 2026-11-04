/**
 * Contract: LSP guidance is owned by the `lsp` bundled plugin, gated on the
 * active lsp tool, and released with the plugin.
 */
import { describe, expect, it } from "bun:test";
import { PromptHost } from "@musepi/pi-coding-agent/prompts/host";
import { PROMPT_ORDERS } from "@musepi/pi-coding-agent/prompts/orders";
import { LSP_PROMPT_OWNER, registerLspPrompts } from "../src/bundled-plugins/lsp/prompts";

function install(): { host: PromptHost; dispose: () => void } {
	const host = new PromptHost();
	return { host, dispose: registerLspPrompts(host) };
}

function sections(host: PromptHost, activeTools: readonly string[]) {
	return host.assemble({ activeTools }).sections;
}

describe("lsp plugin prompt", () => {
	it("registers tool:lsp at the tool anchor under the plugin owner", () => {
		const { host } = install();
		expect(sections(host, ["lsp"])).toMatchObject([
			{ name: "tool:lsp", order: PROMPT_ORDERS.tool, owner: LSP_PROMPT_OWNER },
		]);
	});

	it("omits the section while lsp is inactive", () => {
		const { host } = install();
		expect(sections(host, [])).toEqual([]);
		expect(sections(host, ["read"])).toEqual([]);
	});

	it("renders both the routing rule and the references gate", () => {
		const { host } = install();
		const text = sections(host, ["lsp"])[0]?.text ?? "";
		expect(text).toContain(
			"Language server available → MUST use `lsp` for definition, type_definition, implementation, references, hover; refactors/imports/fixes: list code actions, apply one. NEVER search/manual-edit for code intelligence.",
		);
		expect(text).toContain(
			"Before exported-symbol modification, MUST run `lsp` references; missed callsites are bugs.",
		);
	});

	it("removes the section when the registration is disposed", () => {
		const { host, dispose } = install();
		dispose();
		expect(sections(host, ["lsp"])).toEqual([]);
	});

	it("removes the section when the owner is released", () => {
		const { host } = install();
		host.removeByOwner(LSP_PROMPT_OWNER);
		expect(sections(host, ["lsp"])).toEqual([]);
	});
});
