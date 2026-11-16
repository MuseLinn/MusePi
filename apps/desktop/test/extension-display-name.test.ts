import "./happy-dom-shim";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { extensionDescription, extensionDisplayName } from "../src/lib/slot-host";

/**
 * 插件在界面语言下的名字：包内 `locale/<tag>.json` → 清单单句文案 → 模块名。
 *
 * 这三段回退是扩展中心、能力中心诊断页与信息卡「插件」分区共用的唯一判定；
 * 任何一个消费者自己再拼一遍名字，同一个插件就会在两处叫两个名字。
 */
describe("extensionDisplayName", () => {
	it("prefers the package's own locale file for the interface language", () => {
		const item = {
			name: "musepi-session-info-resources",
			displayName: "Session Resources",
			displayNameI18n: { en: "Session Resources", "zh-CN": "会话资源监控" },
		};
		expect(extensionDisplayName(item, "zh-CN")).toBe("会话资源监控");
		expect(extensionDisplayName(item, "en-US")).toBe("Session Resources");
	});

	it("falls back to the single manifest label, then to the module name", () => {
		expect(
			extensionDisplayName({ name: "musepi-stats-pills", displayName: "Usage and Performance Stats" }, "zh-CN"),
		).toBe("Usage and Performance Stats");
		// A module that never declared a label is still named by its package id.
		expect(extensionDisplayName({ name: "musepi-bare", displayName: "" }, "zh-CN")).toBe("musepi-bare");
	});

	it("resolves the same way for a description, with no placeholder when absent", () => {
		expect(
			extensionDescription({ description: "Kanban", descriptionI18n: { en: "Kanban", "zh-CN": "看板" } }, "zh-CN"),
		).toBe("看板");
		expect(extensionDescription({ description: "Kanban" }, "zh-CN")).toBe("Kanban");
		expect(extensionDescription({}, "zh-CN")).toBeUndefined();
	});
});

/**
 * The desktop plugins name themselves exactly once. `musepi.label` is the name
 * the agent's extension inventory shows (single-language surface); the locale
 * files are the interface names. A `ctx.setLabel` call here would be a second
 * declaration free to drift from both.
 */
describe("desktop plugin manifests", () => {
	it("declare a label and never override it at runtime", async () => {
		const root = path.join(import.meta.dir, "..", "src", "plugins");
		const dirs = (await fs.readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory());
		const problems: string[] = [];
		for (const dir of dirs) {
			const manifest = JSON.parse(await fs.readFile(path.join(root, dir.name, "package.json"), "utf8")) as {
				musepi?: { label?: string };
			};
			if (!manifest.musepi?.label) problems.push(`${dir.name}: no label`);
			const entry = await fs.readFile(path.join(root, dir.name, "index.ts"), "utf8").catch(() => "");
			if (/\.setLabel\(/.test(entry)) problems.push(`${dir.name}: calls setLabel`);
			const chinese = await fs.readFile(path.join(root, dir.name, "locale", "zh-CN.json"), "utf8").catch(() => "");
			if (!chinese.includes('"title"')) problems.push(`${dir.name}: no zh-CN title`);
		}
		expect(problems).toEqual([]);
	});
});
