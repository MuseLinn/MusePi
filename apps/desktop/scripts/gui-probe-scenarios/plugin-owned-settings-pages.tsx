/**
 * Settings pages that became plugin-owned, rendered from real component code.
 *
 * These two moved out of the host during the settings-plugin migration. A unit
 * test can show the registration payload; only a real render shows whether the
 * page still has the shape it had before the move — a title above its body and
 * no leftover wrapper from the old host shell.
 *
 * Run at the settings column's own width (`--width 900`): the rows are
 * `justify-between`, so a wider mount pushes the trailing control away from the
 * label and reads as a layout bug that is not there.
 */
import { t } from "@musepi/client-core";
import AgentPresetPage from "../../src/plugins/ui-agent-preset/page";
import SubagentsSettingsPage from "../../src/plugins/ui-settings-subagent/page";
import { type GuiScenario, measure, mount } from "../gui-probe-helpers";

/** Daemon stand-in carrying enough schema to render these pages' bodies: both
 *  render `SchemaTabSection`, which reads `settings.schema` then `settings.get`,
 *  so an empty answer would show an empty page and prove nothing. */
function stubRpc(): never {
	const rows = [
		{
			key: "subagent.maxConcurrent",
			type: "number",
			default: 4,
			ui: { tab: "tasks", group: "Limits", label: "Max concurrent subagents" },
		},
		{
			key: "subagent.isolation",
			type: "enum",
			values: ["none", "worktree"],
			default: "none",
			ui: { tab: "tasks", group: "Isolation", label: "Isolation" },
		},
	] as const;
	return {
		request: async (method: string) => {
			if (method === "settings.schema") return { tasks: rows, modes: rows };
			if (method === "settings.get") return { "subagent.maxConcurrent": 4, "subagent.isolation": "none" };
			if (method === "models.catalog" || method === "models.list") return [];
			if (method === "presets.list") return [];
			return {};
		},
		addEventListener: () => () => {},
	} as never;
}

const SELECTORS = {
	title: ".gui-settings-page-title",
	desc: ".gui-settings-page-desc",
	row: ".gui-settings-row",
	schemaCard: ".gui-schema-card",
	select: "select",
};

export default {
	"settings-subagents": {
		async render(root) {
			await mount(<SubagentsSettingsPage rpc={stubRpc()} />, root);
		},
		async measure(body) {
			return {
				elements: measure(body, SELECTORS),
				titleText: body.querySelector(SELECTORS.title)?.textContent ?? null,
			};
		},
		expect: {
			// A page heading: one line tall, not boxed, and carrying the page's own
			// label (the move must not leave the host's copy or an empty heading).
			title: { display: "block", "box.h": { min: 16, max: 48 }, "box.w": { min: 200 } },
		},
	},

	"ui-agent-preset": {
		async render(root) {
			await mount(<AgentPresetPage rpc={stubRpc()} onCreateChat={() => {}} />, root);
		},
		async measure(body) {
			return {
				elements: measure(body, SELECTORS),
				titleText: body.querySelector(SELECTORS.title)?.textContent ?? null,
			};
		},
		expect: {
			title: { display: "block", "box.h": { min: 16, max: 48 }, "box.w": { min: 200 } },
		},
	},
} satisfies Record<string, GuiScenario>;
