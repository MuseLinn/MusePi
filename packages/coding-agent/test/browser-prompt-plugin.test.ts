/**
 * Contract: browser verification guidance is owned by the `browser` bundled
 * plugin, gated on the active browser tool, and released with the plugin.
 */
import { describe, expect, it } from "bun:test";
import { PromptHost } from "@musepi/pi-coding-agent/prompts/host";
import { PROMPT_ORDERS } from "@musepi/pi-coding-agent/prompts/orders";
import { BROWSER_PROMPT_OWNER, registerBrowserPrompts } from "../src/bundled-plugins/browser/prompts";

function install(): { host: PromptHost; dispose: () => void } {
	const host = new PromptHost();
	return { host, dispose: registerBrowserPrompts(host) };
}

function section(host: PromptHost, activeTools: readonly string[]) {
	return host.assemble({ activeTools }).sections[0];
}

describe("browser plugin prompt", () => {
	it("registers tool:browser at the tool anchor under the plugin owner", () => {
		const { host } = install();
		expect(section(host, ["browser"])).toMatchObject({
			name: "tool:browser",
			order: PROMPT_ORDERS.tool,
			owner: BROWSER_PROMPT_OWNER,
		});
	});

	it("omits the section while browser is inactive", () => {
		const { host } = install();
		expect(host.assemble({ activeTools: [] }).sections).toEqual([]);
		expect(host.assemble({ activeTools: ["computer"] }).sections).toEqual([]);
	});

	it("renders the browser verification rule verbatim", () => {
		const { host } = install();
		expect(section(host, ["browser"])?.text).toBe(
			"- **Web UI** → browser-drive with `browser`; visual confirmation is proof; no tests unless existing suite really breaks.",
		);
	});

	it("removes the section when the registration is disposed", () => {
		const { host, dispose } = install();
		dispose();
		expect(host.assemble({ activeTools: ["browser"] }).sections).toEqual([]);
	});

	it("removes the section when the owner is released", () => {
		const { host } = install();
		host.removeByOwner(BROWSER_PROMPT_OWNER);
		expect(host.assemble({ activeTools: ["browser"] }).sections).toEqual([]);
	});
});
