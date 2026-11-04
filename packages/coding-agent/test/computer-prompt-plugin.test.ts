/**
 * Contract: computer-use guidance is owned by the `computer` bundled plugin,
 * gated on the active computer tool, and released with the plugin.
 */
import { describe, expect, it } from "bun:test";
import { PromptHost } from "@musepi/pi-coding-agent/prompts/host";
import { PROMPT_ORDERS } from "@musepi/pi-coding-agent/prompts/orders";
import { COMPUTER_PROMPT_OWNER, registerComputerPrompts } from "../src/bundled-plugins/computer/prompts";

function install(): { host: PromptHost; dispose: () => void } {
	const host = new PromptHost();
	return { host, dispose: registerComputerPrompts(host) };
}

function section(host: PromptHost, activeTools: readonly string[]) {
	return host.assemble({ activeTools }).sections[0];
}

describe("computer plugin prompt", () => {
	it("registers tool:computer at the tool anchor under the plugin owner", () => {
		const { host } = install();
		expect(section(host, ["computer"])).toMatchObject({
			name: "tool:computer",
			order: PROMPT_ORDERS.tool,
			owner: COMPUTER_PROMPT_OWNER,
		});
	});

	it("omits the section while computer is inactive", () => {
		const { host } = install();
		expect(host.assemble({ activeTools: [] }).sections).toEqual([]);
		expect(host.assemble({ activeTools: ["browser"] }).sections).toEqual([]);
	});

	it("keeps desktop routing and verification in the plugin-owned text", () => {
		const { host } = install();
		const text = section(host, ["computer"])?.text ?? "";
		expect(text).toContain("# Computer Use");
		expect(text).toContain("`computer` enabled/available.");
		expect(text).toContain("NEVER substitute Browser, Bash, Eval, AppleScript");
		expect(text).toContain("After UI change, re-run `ax()` or `screenshot()`");
		expect(text).toContain("**Native desktop UI** → drive with `computer`");
	});

	it("removes the section when the registration is disposed", () => {
		const { host, dispose } = install();
		dispose();
		expect(host.assemble({ activeTools: ["computer"] }).sections).toEqual([]);
	});

	it("removes the section when the owner is released", () => {
		const { host } = install();
		host.removeByOwner(COMPUTER_PROMPT_OWNER);
		expect(host.assemble({ activeTools: ["computer"] }).sections).toEqual([]);
	});
});
