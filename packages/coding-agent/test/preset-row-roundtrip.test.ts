import { describe, expect, it } from "bun:test";
import { presetToRowConfig, rowConfigToPreset } from "../src/extensibility/plugins/profile/preset-row";
import type { ModeDefinition } from "../src/presets/resolve";

/**
 * Contract: a preset survives a round trip through a Cordis declaration row's
 * `config` without losing a field.
 *
 * Why this exists: a preset used to be a JSON file of its own, and its shape was
 * whatever that file held. Storing it as one `- insert:` row (the same place any
 * Cordis plugin declaration lives) makes the row's `config` the store, so every
 * field the file format could express — inheritance, settings overrides, model
 * and tool selection, several prompt blocks — has to encode into that block and
 * decode back out. A field that encodes but does not decode is a preset the user
 * saves and silently loses.
 */

const FULL: ModeDefinition = {
	id: "design",
	label: "Design",
	description: "A design-flavoured session",
	extends: ["work"],
	modelRole: "designer",
	extensions: ["@musepi/foo", "@musepi/bar"],
	topLevelTools: ["read", "write"],
	plugins: [
		{ name: "@musepi/persona", id: "persona", config: { prefix: "You design.", complete: true } },
		{ name: "@musepi/tools", enabled: false },
		{ name: "@musepi/group", group: true, config: [{ name: "@musepi/leaf" }] },
		{ name: "@musepi/isolated", isolate: { storage: true }, inject: ["storage"] },
	],
	prompt: [
		{ name: "mode:design:role", order: 10, text: "You are a designer." },
		{ name: "mode:design:rules", order: 20, text: "Prefer type over density." },
	],
	promptComplete: true,
	runtimeContext: false,
	settings: { "display.taskCardStyle": "classic", "tools.approvalMode": "ask" },
	builtinRevision: 12,
};

describe("preset row round trip", () => {
	it("keeps every field a preset can carry", () => {
		const back = rowConfigToPreset(presetToRowConfig(FULL, 3) as never);
		expect(back).not.toBeNull();
		const { id, label, description, extends: ext, modelRole, extensions, topLevelTools, prompt } = back!;
		const plugins = back!.plugins ?? [];
		expect({ id, label, description, ext, modelRole, extensions, topLevelTools }).toEqual({
			id: "design",
			label: "Design",
			description: "A design-flavoured session",
			ext: ["work"],
			modelRole: "designer",
			extensions: ["@musepi/foo", "@musepi/bar"],
			topLevelTools: ["read", "write"],
		});
		expect(back!.settings).toEqual(FULL.settings);
		expect(back!.promptComplete).toBe(true);
		expect(back!.runtimeContext).toBe(false);
		expect(back!.builtinRevision).toBe(12);
		// Plugin rows keep their nested config, disabled state and isolation.
		expect(plugins).toHaveLength(4);
		expect(plugins[0]?.config).toEqual({ prefix: "You design.", complete: true });
		expect(plugins[1]?.enabled).toBe(false);
		expect(plugins[2]?.group).toBe(true);
		expect(Array.isArray(plugins[2]?.config)).toBe(true);
		expect(plugins[3]?.isolate).toEqual({ storage: true });
		expect(plugins[3]?.inject).toEqual(["storage"]);
		// Both prompt blocks survive, with their order.
		expect(prompt).toEqual(FULL.prompt);
	});

	it("writes the Cordis declaration fields a consumer reads", () => {
		const config = presetToRowConfig(FULL, 3);
		// These five are what any Cordis consumer of an `agent-preset` row reads.
		expect(config.id).toBe("design");
		expect(config.name).toBe("Design");
		expect(config.order).toBe(3);
		expect(config.description).toBe("A design-flavoured session");
		expect(Array.isArray(config.plugins)).toBe(true);
	});

	it("does not invent keys for absent fields", () => {
		const minimal: ModeDefinition = { id: "plain", plugins: [] };
		const config = presetToRowConfig(minimal, 0);
		expect(Object.keys(config).sort()).toEqual(["id", "name", "order", "plugins"]);
		const back = rowConfigToPreset(config as never)!;
		expect(back.label).toBe("plain");
		expect(back.settings).toBeUndefined();
		expect(back.extends).toBeUndefined();
		expect(back.promptComplete).toBeUndefined();
	});

	it("rejects a config without an id instead of returning an empty preset", () => {
		expect(rowConfigToPreset({ name: "no id" })).toBeNull();
		expect(rowConfigToPreset(undefined)).toBeNull();
		expect(rowConfigToPreset({ id: "" })).toBeNull();
	});

	it("expands the string prompt shorthand the file format allowed", () => {
		const back = rowConfigToPreset({ id: "shorthand", prompt: ["one line"] })!;
		expect(back.prompt).toEqual([{ name: "mode:block:0", order: 25, text: "one line" }]);
	});
});
