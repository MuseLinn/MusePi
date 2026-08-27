import { describe, expect, it } from "bun:test";
import { PromptComposer } from "@musepi/pi-coding-agent/prompts/composer";
import { prompt } from "@musepi/pi-utils";
import extensionsInventoryTemplate from "../src/prompts/system/extensions-inventory.md" with { type: "text" };

// PromptComposer(§5):插槽排序、同名覆盖、removeBySource、promptComplete、无注入回归锚。

const BASE_FULL = ["core", "safety", "project", "repo"];
const BASE_SHORT = ["core", "safety"]; // 条件 push 缺失的场景

describe("prompts/composer compose", () => {
	it("无注入时 compose(base) 原样返回(回归锚)", () => {
		const composer = new PromptComposer();
		expect(composer.compose(BASE_FULL)).toBe(BASE_FULL);
		expect(composer.compose(BASE_SHORT)).toBe(BASE_SHORT);
		expect(composer.compose([])).toEqual([]);
	});

	it("order 插槽分组:10→core 后,150→safety 后,250→project 后,350→repo 后", () => {
		const composer = new PromptComposer();
		composer.add({ name: "m:a", order: 10, text: "INJ-10" }, "mode:test");
		composer.add({ name: "m:b", order: 150, text: "INJ-150" }, "mode:test");
		composer.add({ name: "m:c", order: 250, text: "INJ-250" }, "mode:test");
		composer.add({ name: "m:d", order: 350, text: "INJ-350" }, "mode:test");
		const out = composer.compose(BASE_FULL);
		expect(out).toEqual(["core", "INJ-10", "safety", "INJ-150", "project", "INJ-250", "repo", "INJ-350"]);
	});

	it("base tail 缺失时区块顺延追加", () => {
		const composer = new PromptComposer();
		composer.add({ name: "m:a", order: 150, text: "INJ-150" }, "mode:test");
		composer.add({ name: "m:b", order: 350, text: "INJ-350" }, "mode:test");
		const out = composer.compose(BASE_SHORT); // [core, safety],无 project/repo
		expect(out).toEqual(["core", "safety", "INJ-150", "INJ-350"]);
	});

	it("同 order 稳定排序(name 字典序)", () => {
		const composer = new PromptComposer();
		composer.add({ name: "z", order: 10, text: "z" }, "mode:test");
		composer.add({ name: "a", order: 10, text: "a" }, "mode:test");
		expect(composer.compose(["core"])).toEqual(["core", "a", "z"]);
	});

	it("同名替换(后 add 胜),异名共存", () => {
		const composer = new PromptComposer();
		composer.add({ name: "p:role", order: 10, text: "first" }, "mode:a");
		composer.add({ name: "p:role", order: 20, text: "second" }, "mode:b");
		composer.add({ name: "p:other", order: 15, text: "other" }, "mode:b");
		expect(composer.compose(["core"])).toEqual(["core", "other", "second"]); // other(15) 在 second(20) 前
	});

	it("removeBySource 按贡献方整体卸载", () => {
		const composer = new PromptComposer();
		composer.add({ name: "a", order: 10, text: "A" }, "mode:design");
		composer.add({ name: "b", order: 11, text: "B" }, "mode:design");
		composer.add({ name: "c", order: 12, text: "C" }, "ext:ui");
		composer.removeBySource("mode:design");
		expect(composer.compose(["core"])).toEqual(["core", "C"]);
	});

	it("add 未传 source 回退参数/默认", () => {
		const composer = new PromptComposer();
		composer.add({ name: "a", order: 10, text: "A" });
		composer.add({ name: "b", order: 11, text: "B" }, "ext:x");
		composer.removeBySource("anonymous");
		expect(composer.compose(["core"])).toEqual(["core", "B"]);
	});

	// Modes v2(§5.6/§10):热切换增量 —— removeBySource(mode:<old>) → add 新
	// mode 区块 → compose 重算,base 沿用初始、其余贡献方(用户/ext)不动。
	it("热切换增量:换 mode 只动注入层,用户/ext 区块保留", () => {
		const composer = new PromptComposer();
		composer.add({ name: "u:rule", order: 20, text: "USER" }, "user");
		composer.add({ name: "x:note", order: 15, text: "EXT" }, "ext:ui");
		composer.add({ name: "m:role", order: 10, text: "OLD-ROLE" }, "mode:work");
		expect(composer.compose(["core"])).toEqual(["core", "OLD-ROLE", "EXT", "USER"]);

		// 热切到 design:旧 mode 区块整源卸载,新 mode 区块按 order 插入
		composer.removeBySource("mode:work");
		composer.add({ name: "m:role", order: 10, text: "NEW-ROLE" }, "mode:design");
		composer.add({ name: "m:palette", order: 12, text: "PALETTE" }, "mode:design");
		expect(composer.compose(["core"])).toEqual(["core", "NEW-ROLE", "PALETTE", "EXT", "USER"]);

		// 切回/再切:旧 design 区块卸载后只剩 user/ext(回归锚:无残留)
		composer.removeBySource("mode:design");
		expect(composer.compose(["core"])).toEqual(["core", "EXT", "USER"]);
	});
});

describe("prompts/composer composeComplete", () => {
	it("promptComplete:仅注入层按 order 输出,忽略 base(DSH complete:true)", () => {
		const composer = new PromptComposer();
		composer.add({ name: "p:role", order: 30, text: "role" }, "mode:minimal");
		composer.add({ name: "p:style", order: 10, text: "style" }, "mode:minimal");
		expect(composer.composeComplete()).toEqual(["style", "role"]);
		expect(composer.composeComplete()).not.toEqual(expect.arrayContaining(["core"]));
	});
});

describe("extensions-inventory block (agent awareness, §5.7)", () => {
	it("inventory block composes into the injection slot and re-hangs on source reload", () => {
		const composer = new PromptComposer();
		const inventoryText = [
			"# 已安装扩展",
			"",
			"- **my-ext**（工具：probe_tool, scan_tool）",
			"",
			"你可以主动使用这些扩展的能力，或用 /extensions 查看与管理。",
		].join("\n");
		composer.add({ name: "extensions-inventory", order: 25, text: inventoryText }, "ext:inventory");
		expect(composer.compose(["core"])).toEqual(["core", inventoryText]);
		// Whole-source re-hang (hot-switch): the old inventory is replaced.
		composer.removeBySource("ext:inventory");
		expect(composer.compose(["core"])).toEqual(["core"]);
		const emptyText =
			"# 已安装扩展\n\n（当前没有已启用的扩展。）\n\n你可以主动使用这些扩展的能力，或用 /extensions 查看与管理。";
		composer.add({ name: "extensions-inventory", order: 25, text: emptyText }, "ext:inventory");
		expect(composer.compose(["core"])).toEqual(["core", emptyText]);
	});
});

describe("extensions-inventory template (Handlebars render)", () => {
	const template = extensionsInventoryTemplate;
	it("renders extension names + tools from the .md template", () => {
		const out = prompt.render(template, {
			extensions: [
				{ label: "my-ext", tools: "probe_tool, scan_tool" },
				{ label: "other", tools: "" },
			],
		});
		expect(out).toContain("# 已安装扩展");
		expect(out).toContain("**my-ext**（工具：probe_tool, scan_tool）");
		expect(out).toContain("**other**");
	});
	it("renders the empty state when no extensions", () => {
		const out = prompt.render(template, { extensions: [] });
		expect(out).toContain("（当前没有已启用的扩展。）");
		expect(out).not.toContain("**");
	});
});
