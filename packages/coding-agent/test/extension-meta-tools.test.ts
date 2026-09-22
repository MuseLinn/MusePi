import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createExtensionManagerTools } from "@musepi/pi-coding-agent/daemon/extension-lifecycle-tools";
import {
	createExtensionRuntimeTools,
	RuntimeToolRegistry,
} from "@musepi/pi-coding-agent/daemon/extension-runtime-tools";
import {
	EXTENSION_META_TOOL_NAMES,
	isExtensionMetaToolName,
} from "@musepi/pi-coding-agent/extensibility/extension-meta-tools";
import { buildSystemPrompt } from "@musepi/pi-coding-agent/system-prompt";

const sessionOf = () => null;

describe("extension meta tools (issue #38 Step 2)", () => {
	test("constants: 10 names, predicate matches exactly", () => {
		expect(EXTENSION_META_TOOL_NAMES).toHaveLength(10);
		for (const name of EXTENSION_META_TOOL_NAMES) {
			expect(isExtensionMetaToolName(name)).toBe(true);
		}
		// extensions_list 保留常驻,不属于默认摘除集合
		expect(isExtensionMetaToolName("extensions_list")).toBe(false);
		expect(isExtensionMetaToolName("read")).toBe(false);
		expect(isExtensionMetaToolName("")).toBe(false);
	});

	test("lifecycle factory: 5 meta tools default-inactive, extensions_list stays active", () => {
		const tools = createExtensionManagerTools(sessionOf);
		const byName = new Map(tools.map(t => [t.name, t]));
		expect(byName.has("extensions_list")).toBe(true);
		for (const name of [
			"extension_load",
			"extension_reload",
			"extension_status",
			"extension_validate",
			"extension_rollback",
		]) {
			expect(byName.get(name)?.defaultInactive).toBe(true);
		}
		expect(byName.get("extensions_list")?.defaultInactive).not.toBe(true);
		// 工厂产出与常量集合一致(lifecycle 侧 5 个)
		const inactive = tools.filter(t => t.defaultInactive === true).map(t => t.name);
		expect(inactive.sort()).toEqual(
			["extension_load", "extension_reload", "extension_rollback", "extension_status", "extension_validate"].sort(),
		);
	});

	test("runtime factory: all 5 bootstrap tools default-inactive", () => {
		const registry = new RuntimeToolRegistry();
		const tools = createExtensionRuntimeTools(sessionOf, () => registry);
		expect(tools).toHaveLength(5);
		for (const t of tools) {
			expect(EXTENSION_META_TOOL_NAMES).toContain(t.name);
			expect(t.defaultInactive).toBe(true);
		}
	});

	test("prefix stability: activating meta tools does not alter prompt text before the tool inventory", async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "musepi-prefix-test-"));
		const baseNames = ["read", "bash", "edit", "task"];
		const withMeta = [...baseNames, ...EXTENSION_META_TOOL_NAMES];

		const common = {
			inlineToolDescriptors: true,
			nativeTools: false,
			cwd,
			includeWorkspaceTree: false,
		} as const;

		const base = await buildSystemPrompt({ ...common, toolNames: baseNames });
		const meta = await buildSystemPrompt({ ...common, toolNames: withMeta });

		const baseText = base.systemPrompt.join("\n");
		const metaText = meta.systemPrompt.join("\n");

		const marker = "## functions";
		const baseMarkerAt = baseText.indexOf(marker);
		const metaMarkerAt = metaText.indexOf(marker);
		expect(baseMarkerAt).toBeGreaterThan(0);
		expect(metaMarkerAt).toBeGreaterThan(0);

		// 前缀缓存性质:inventory 之前的正文逐字节相同
		const sharedPrefix = Math.min(baseMarkerAt, metaMarkerAt);
		expect(baseText.slice(0, sharedPrefix)).toEqual(metaText.slice(0, sharedPrefix));

		// inventory 本体确实包含新增的工具名(证明差异只发生在 inventory 区段)
		expect(metaText).toContain("extension_load");
		expect(metaText).toContain("ext_define");
		expect(baseText).not.toContain("extension_load");

		// 差异起点不得早于 inventory 标记(防回归:工具名泄漏进正文)
		let diffAt = 0;
		const max = Math.min(baseText.length, metaText.length);
		while (diffAt < max && baseText[diffAt] === metaText[diffAt]) diffAt++;
		expect(diffAt).toBeGreaterThanOrEqual(Math.min(baseMarkerAt, metaMarkerAt));
	});
});
