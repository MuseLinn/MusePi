import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveLocalizedText } from "@musepi/pi-wire";
import { readExtensionPluginMeta } from "../src/extensibility/extensions/plugin-manifest";

/**
 * Every bundled plugin names itself in both shipped interface languages.
 *
 * The seam is opt-in (`locale/<tag>.json`), so nothing forces a package to use
 * it — which is exactly how an inventory ends up half English, half Chinese, or
 * showing bare module ids. This guard makes the inventory a contract: a package
 * that ships with the product declares a label and a zh-CN title.
 */
const BUNDLED = path.join(import.meta.dir, "..", "src", "bundled-plugins");

async function pluginDirs(): Promise<string[]> {
	const entries = await fs.readdir(BUNDLED, { withFileTypes: true });
	return entries.filter(entry => entry.isDirectory()).map(entry => path.join(BUNDLED, entry.name));
}

describe("bundled plugin display text", () => {
	test("every bundled package resolves an English and a Chinese name", async () => {
		const problems: string[] = [];
		for (const dir of await pluginDirs()) {
			const entry = path.join(dir, "index.ts");
			const meta = await readExtensionPluginMeta(entry);
			if (!meta) {
				problems.push(`${path.basename(dir)}: no musepi manifest`);
				continue;
			}
			const en = resolveLocalizedText(meta.labelText, "en-US", meta.label);
			const zh = resolveLocalizedText(meta.labelText, "zh-CN", meta.label);
			if (!en) problems.push(`${path.basename(dir)}: no label`);
			if (!zh) problems.push(`${path.basename(dir)}: no zh-CN title`);
			// A package that only translated the title leaves the shared inventory
			// half-translated in its detail pane.
			if (!resolveLocalizedText(meta.descriptionText, "zh-CN", meta.description)) {
				problems.push(`${path.basename(dir)}: no zh-CN description`);
			}
		}
		expect(problems).toEqual([]);
	});

	test("a language the product does not ship falls back to English, not to Chinese", async () => {
		const meta = await readExtensionPluginMeta(path.join(BUNDLED, "terminal", "index.ts"));
		expect(resolveLocalizedText(meta?.labelText, "fr-FR", meta?.label)).toBe("Terminal");
		expect(resolveLocalizedText(meta?.labelText, "zh-CN", meta?.label)).toBe("终端");
	});
});
