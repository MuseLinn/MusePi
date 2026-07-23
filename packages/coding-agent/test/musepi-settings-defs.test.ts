// MusePi settings panel definitions — coverage and round-trip tests.
// Guards the contract between the settings selector's MusePi submenu,
// the @musepi/core schema defaults, and MUSEPI_SETTINGS_DOCS: every
// exposed def must resolve against the schema defaults, carry a schema
// description, and parse its own display values back to typed values.
import { MUSEPI_DEFAULTS } from "@musepi/core";
import { describe, expect, it } from "vitest";
import {
	formatMusepiValue,
	getMusepiPathValue,
	MUSEPI_SETTING_DEFS,
	musepiSettingDescription,
	parseMusepiValue,
} from "../src/modes/interactive/components/musepi-settings-defs.ts";

describe("MUSEPI_SETTING_DEFS", () => {
	it("has unique paths", () => {
		const paths = MUSEPI_SETTING_DEFS.map((def) => def.path);
		expect(new Set(paths).size).toBe(paths.length);
	});

	it("exposes every feature area of the musepi schema", () => {
		const topLevel = new Set(MUSEPI_SETTING_DEFS.map((def) => def.path.split(".")[0]));
		for (const area of Object.keys(MUSEPI_DEFAULTS)) {
			expect(topLevel.has(area), `missing defs for musepi.${area}`).toBe(true);
		}
	});

	it("resolves every def path against the schema defaults", () => {
		for (const def of MUSEPI_SETTING_DEFS) {
			const value = getMusepiPathValue(MUSEPI_DEFAULTS, def.path);
			expect(value, `musepi.${def.path} missing from MUSEPI_DEFAULTS`).not.toBeUndefined();
		}
	});

	it("reuses a non-empty schema description for every def", () => {
		for (const def of MUSEPI_SETTING_DEFS) {
			expect(musepiSettingDescription(def.path), `no MUSEPI_SETTINGS_DOCS entry for ${def.path}`).not.toBe("");
		}
	});

	it("declares enum options that include the schema default", () => {
		for (const def of MUSEPI_SETTING_DEFS) {
			if (def.kind !== "enum") continue;
			const value = getMusepiPathValue(MUSEPI_DEFAULTS, def.path);
			expect(def.options ?? [], `enum ${def.path}`).toContain(value);
		}
	});

	it("declares number presets of positive numbers", () => {
		for (const def of MUSEPI_SETTING_DEFS) {
			if (def.kind !== "number") continue;
			expect(def.presets?.length, `number ${def.path} needs presets`).toBeGreaterThan(0);
			for (const preset of def.presets ?? []) {
				expect(preset).toBeGreaterThan(0);
			}
		}
	});
});

describe("format/parse round-trip", () => {
	it("formats and parses booleans", () => {
		const def = MUSEPI_SETTING_DEFS.find((d) => d.path === "memory.enabled")!;
		expect(formatMusepiValue(def, MUSEPI_DEFAULTS)).toBe("false");
		expect(parseMusepiValue(def, "true")).toBe(true);
		expect(parseMusepiValue(def, "false")).toBe(false);
		expect(parseMusepiValue(def, "maybe")).toBeUndefined();
	});

	it("formats and parses enums, rejecting values outside the options", () => {
		const def = MUSEPI_SETTING_DEFS.find((d) => d.path === "compaction.strategy")!;
		expect(formatMusepiValue(def, MUSEPI_DEFAULTS)).toBe("default");
		expect(parseMusepiValue(def, "snapcompact")).toBe("snapcompact");
		expect(parseMusepiValue(def, "bogus")).toBeUndefined();
	});

	it("formats and parses numbers, rejecting non-positive input", () => {
		const def = MUSEPI_SETTING_DEFS.find((d) => d.path === "mcp.idleTimeoutMs")!;
		expect(formatMusepiValue(def, MUSEPI_DEFAULTS)).toBe("600000");
		expect(parseMusepiValue(def, "300000")).toBe(300000);
		expect(parseMusepiValue(def, "0")).toBeUndefined();
		expect(parseMusepiValue(def, "abc")).toBeUndefined();
	});

	it("formats unset text as (unset) and parses typed text verbatim", () => {
		const def = MUSEPI_SETTING_DEFS.find((d) => d.path === "modelRoles.default")!;
		expect(formatMusepiValue(def, MUSEPI_DEFAULTS)).toBe("(unset)");
		expect(parseMusepiValue(def, "openai/gpt-5:high")).toBe("openai/gpt-5:high");
	});

	it("renders info defs as an ellipsis and never parses a change", () => {
		const def = MUSEPI_SETTING_DEFS.find((d) => d.path === "mcp.servers")!;
		expect(formatMusepiValue(def, MUSEPI_DEFAULTS)).toBe("…");
		expect(parseMusepiValue(def, "anything")).toBeUndefined();
		expect(def.info?.length).toBeGreaterThan(0);
	});
});
