/**
 * Contract: every enum the GUI settings can render declares ui.options.
 *
 * The daemon synthesizes { value, label: value } for enums without options,
 * and SchemaSettings resolves each label with t(). A bare id like "sanitize"
 * or "one-at-a-time" has no translation entry, so the dropdown prints the
 * stored id instead of a localized label (设置 → 语音 → 朗读内容 regression).
 * Runtime option lists (theme registries) and hidden rows are exempt.
 */
import { describe, expect, it } from "bun:test";
import { SETTINGS_SCHEMA } from "../src/config/settings-schema";

interface LooseDef {
	type?: string;
	values?: readonly string[];
	ui?: { tab?: string; hidden?: boolean; options?: unknown };
}

type Option = { value: string; label: string };

const VISIBLE_ENUMS = (Object.entries(SETTINGS_SCHEMA) as [string, LooseDef][]).filter(([, def]) => {
	if (def.type !== "enum") return false;
	// Only enums with `values` get the daemon's { value, label: value }
	// synthesis. terminal.provider declares top-level options but no values,
	// so the GUI renders its text-input fallback instead of a dropdown.
	if (!def.values) return false;
	return Boolean(def.ui?.tab) && !def.ui?.hidden && def.ui?.options !== "runtime";
}) as [string, LooseDef & { ui: { options: Option[] } }][];

describe("settings enum options", () => {
	it("declares an option list for every visible enum", () => {
		expect(VISIBLE_ENUMS.length).toBeGreaterThan(50);
		for (const [key, def] of VISIBLE_ENUMS) {
			expect(Array.isArray(def.ui.options), `${key} is missing ui.options`).toBe(true);
		}
	});

	it("never uses a bare stored id as a label", () => {
		// Technical identifiers stay verbatim on purpose: ONNX quantisation
		// dtypes, filesystem names and thinking-effort tokens are model/CLI
		// vocabulary, not UI copy (translating "q4" or "xhigh" would mislead).
		const technical = new Set([
			"q1",
			"q1f16",
			"q2",
			"q2f16",
			"q4",
			"q4f16",
			"q8",
			"fp16",
			"fp32",
			"int8",
			"uint8",
			"bnb4",
			"btrfs",
			"auto",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		for (const [key, def] of VISIBLE_ENUMS) {
			for (const opt of def.ui.options) {
				// Numeric choices (advisor.syncBacklog 1/3/5) are locale-free.
				if (/^\d+$/.test(opt.value) || technical.has(opt.value)) continue;
				expect(opt.label, `${key}.${opt.value}`).not.toBe(opt.value);
			}
		}
	});

	it("covers every declared value exactly once", () => {
		for (const [key, def] of VISIBLE_ENUMS) {
			const declared = [...(def.values ?? [])].map(String).sort();
			const options = def.ui.options.map(o => o.value).sort();
			expect(options, key).toEqual(declared);
		}
	});
});
