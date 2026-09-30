import { describe, expect, test } from "bun:test";
import {
	collectChainIds,
	DEFAULT_PROMPT_ORDER,
	MAX_MODE_CHAIN_DEPTH,
	type ModeDefLike,
	normalizePromptEntry,
	resolveModeView,
} from "../src/lib/resolve-mode-view";

/** 链式 fixture：base → mid → top（extends 方向 top → mid → base）。 */
function chain(): Map<string, ModeDefLike> {
	return new Map<string, ModeDefLike>([
		[
			"base",
			{
				id: "base",
				label: "Base",
				extends: [],
				extensions: ["ext-a"],
				prompt: [{ name: "sec-a", order: 10, text: "A" }],
				settings: { "compaction.enabled": true, keep: "base" },
			},
		],
		[
			"mid",
			{
				id: "mid",
				extends: ["base"],
				prompt: [
					{ name: "sec-b", order: 20, text: "B" },
					{ name: "sec-a", order: 15, text: "A-override" },
				],
				settings: { keep: "mid" },
			},
		],
		["top", { id: "top", label: "Top", extends: ["mid"] }],
	]);
}

describe("resolveModeView · 线性链合并（resolveMode §4.1 语义对照）", () => {
	const view = resolveModeView("top", id => chain().get(id));

	test("拓扑序：父先子后，根最后", () => {
		expect(view.sources).toEqual(["base", "mid", "top"]);
		expect(view.cycle).toBeNull();
		expect(view.missing).toEqual([]);
		expect(view.truncated).toBe(false);
	});

	test("settings 后者胜（子覆盖父），未冲突键保留", () => {
		expect(view.resolved.settings).toEqual({ "compaction.enabled": true, keep: "mid" });
	});

	test("prompt 同名子胜父（sec-a 被 mid 重写），其余按拓扑序收集", () => {
		const byName = new Map(view.resolved.prompt.map(s => [s.name, s]));
		expect(byName.get("sec-a")?.text).toBe("A-override");
		expect(byName.get("sec-a")?.order).toBe(15);
		expect(byName.get("sec-b")?.text).toBe("B");
	});

	test("extensions 链上并集 + 显式标记；label/description 取顶层定义", () => {
		expect(view.resolved.extensions).toEqual(["ext-a"]);
		expect(view.resolved.extensionsExplicit).toBe(true);
		expect(view.resolved.label).toBe("Top");
		expect(view.resolved.description).toBeUndefined();
	});

	test("链上无显式 extensions 时结果 undefined（全部启用），区别于空数组", () => {
		const defs = new Map<string, ModeDefLike>([
			["plain", { id: "plain", extends: ["leaf"] }],
			["leaf", { id: "leaf" }],
		]);
		const v = resolveModeView("plain", id => defs.get(id));
		expect(v.resolved.extensions).toBeUndefined();
		expect(v.resolved.extensionsExplicit).toBe(false);
	});

	test("显式空数组（仅内置核心）与缺省（全部启用）区分开", () => {
		const defs = new Map<string, ModeDefLike>([
			["core", { id: "core", extends: ["leaf"] }],
			["leaf", { id: "leaf", extensions: [] }],
		]);
		const v = resolveModeView("core", id => defs.get(id));
		expect(v.resolved.extensions).toEqual([]);
		expect(v.resolved.extensionsExplicit).toBe(true);
	});
});

describe("resolveModeView · runtimeContext / promptComplete / modelRole", () => {
	test("runtimeContext 任一显式 false 即 false", () => {
		const defs = new Map<string, ModeDefLike>([
			["child", { id: "child", extends: ["parent"] }],
			["parent", { id: "parent", runtimeContext: false }],
		]);
		expect(resolveModeView("child", id => defs.get(id)).resolved.runtimeContext).toBe(false);
	});

	test("promptComplete 取最后声明者，且其 prompt 集成为唯一结果（继承 prompt 被丢弃）", () => {
		const defs = new Map<string, ModeDefLike>([
			[
				"child",
				{
					id: "child",
					extends: ["parent"],
					promptComplete: true,
					prompt: [{ name: "own", order: 1, text: "own-text" }],
				},
			],
			["parent", { id: "parent", prompt: [{ name: "inherited", order: 1, text: "inherited-text" }] }],
		]);
		const v = resolveModeView("child", id => defs.get(id));
		expect(v.resolved.promptComplete).toBe(true);
		expect(v.resolved.promptCompleteSource).toBe("child");
		expect(v.resolved.prompt.map(s => s.name)).toEqual(["own"]);
	});

	test("modelRole 链上最后定义者胜", () => {
		const defs = new Map<string, ModeDefLike>([
			["child", { id: "child", extends: ["parent"], modelRole: "fast" }],
			["parent", { id: "parent", modelRole: "max" }],
		]);
		expect(resolveModeView("child", id => defs.get(id)).resolved.modelRole).toBe("fast");
	});

	test("string 快捷语法展开为默认 order 的具名区块（与 daemon normalizePromptEntry 同规则）", () => {
		const section = normalizePromptEntry("做一件事", "m");
		expect(section.order).toBe(DEFAULT_PROMPT_ORDER);
		expect(section.name).toBe("mode:m:做一件事".slice(0, 29));
		expect(section.text).toBe("做一件事");
		const defs = new Map<string, ModeDefLike>([["s", { id: "s", prompt: ["快捷文本"] }]]);
		const v = resolveModeView("s", id => defs.get(id));
		expect(v.resolved.prompt).toEqual([{ name: "mode:s:快捷文本", order: DEFAULT_PROMPT_ORDER, text: "快捷文本" }]);
	});
});

describe("resolveModeView · 菱形继承", () => {
	const defs = new Map<string, ModeDefLike>([
		["root", { id: "root", extends: ["left", "right"] }],
		["left", { id: "left", extends: ["shared"], settings: { a: 1 } }],
		["right", { id: "right", extends: ["shared"], settings: { b: 2 } }],
		["shared", { id: "shared", prompt: [{ name: "s", order: 1, text: "shared" }] }],
	]);

	test("共享父只合并一次，双侧 settings 都进结果", () => {
		const v = resolveModeView("root", id => defs.get(id));
		expect(v.sources.filter(id => id === "shared")).toHaveLength(1);
		expect(v.resolved.settings).toEqual({ a: 1, b: 2 });
		expect(v.resolved.prompt.map(s => s.name)).toEqual(["s"]);
	});
});

describe("resolveModeView · 容错（读路径不抛错，只记标记）", () => {
	test("extends 环：cycle 记录闭合路径，其余分支仍展开", () => {
		const defs = new Map<string, ModeDefLike>([
			["a", { id: "a", extends: ["b", "ok"] }],
			["b", { id: "b", extends: ["a"] }],
			["ok", { id: "ok" }],
		]);
		const v = resolveModeView("a", id => defs.get(id));
		expect(v.cycle).toEqual(["a", "b", "a"]);
		expect(v.sources).toContain("ok");
		expect(v.sources).toContain("b");
	});

	test("悬空引用：missing 记录且去重，不中断其他分支", () => {
		const defs = new Map<string, ModeDefLike>([
			["a", { id: "a", extends: ["ghost", "ghost", "real"] }],
			["real", { id: "real" }],
		]);
		const v = resolveModeView("a", id => defs.get(id));
		expect(v.missing).toEqual(["ghost"]);
		expect(v.sources).toEqual(["real", "a"]);
	});

	test("自引用环：a extends a", () => {
		const defs = new Map<string, ModeDefLike>([["a", { id: "a", extends: ["a"] }]]);
		const v = resolveModeView("a", id => defs.get(id));
		expect(v.cycle).toEqual(["a", "a"]);
		expect(v.sources).toEqual(["a"]);
	});

	test("超深链截断：truncated 置位，sources 不超上限，结果仍为部分合并", () => {
		const defs = new Map<string, ModeDefLike>();
		for (let i = 0; i < MAX_MODE_CHAIN_DEPTH + 4; i++) {
			defs.set(`m${i}`, { id: `m${i}`, extends: [`m${i + 1}`], settings: { [`k${i}`]: i } });
		}
		const v = resolveModeView("m0", id => defs.get(id));
		expect(v.truncated).toBe(true);
		expect(v.sources).toHaveLength(MAX_MODE_CHAIN_DEPTH);
		expect(Object.keys(v.resolved.settings)).toHaveLength(MAX_MODE_CHAIN_DEPTH);
	});

	test("根定义缺失：missing 含根 id，结果回落根 id 作 label", () => {
		const v = resolveModeView("nope", () => undefined);
		expect(v.missing).toEqual(["nope"]);
		expect(v.resolved.label).toBe("nope");
		expect(v.resolved.prompt).toEqual([]);
	});
});

describe("collectChainIds · 闭包收集（并行 fetch 的 id 清单）", () => {
	const rows = new Map<string, string[]>([
		["top", ["mid"]],
		["mid", ["base", "extra"]],
		["base", []],
		["extra", ["base"]],
	]);

	test("BFS 去重：共享父只出现一次，返回发现顺序", () => {
		expect(collectChainIds("top", id => rows.get(id))).toEqual(["top", "mid", "base", "extra"]);
	});

	test("cap 截断：超出上限后不再入队", () => {
		const ids = collectChainIds("top", id => rows.get(id), 2);
		expect(ids).toEqual(["top", "mid"]);
	});

	test("extendsOf 返回 undefined（摘要缺行）按无父处理，不抛错", () => {
		expect(collectChainIds("ghost", () => undefined)).toEqual(["ghost"]);
	});
});
