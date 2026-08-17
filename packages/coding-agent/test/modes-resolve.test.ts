import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createModeResolver, ModeError, resolveMode, validateMode } from "@musepi/pi-coding-agent/presets/resolve";

// Modes 聚合层(§4):拓扑序、环/悬空、并集、三态、同名覆盖、promptComplete、runtimeContext。

describe("presets/resolve 继承展开", () => {
	it("拓扑序展开(先引用的先应用),sources 记录继承链", () => {
		const out = resolveMode("design-research", id => ({
			id,
			...(id === "design-research"
				? { extends: ["design", "autoresearch"], label: "Design+Research" }
				: id === "design"
					? {
							label: "Design",
							extensions: ["image-tools"],
							prompt: [{ name: "p:design", order: 10, text: "design persona" }],
						}
					: id === "autoresearch"
						? {
								label: "AutoResearch",
								extensions: ["literature-survey"],
								prompt: [{ name: "p:research", order: 20, text: "research persona" }],
							}
						: undefined),
		}));
		expect(out.sources).toEqual(["design", "autoresearch", "design-research"]);
		expect(out.label).toBe("Design+Research");
		expect(out.extensions).toEqual(["image-tools", "literature-survey"]); // 并集,拓扑序
	});

	it("环检测抛 ModeError", () => {
		expect(() => resolveMode("a", id => ({ id, extends: id === "a" ? ["b"] : ["a"] }))).toThrow(ModeError);
		expect(() => resolveMode("a", id => ({ id, extends: id === "a" ? ["b"] : ["a"] }))).toThrow(/环/);
	});

	it("悬空 extends 抛 ModeError", () => {
		expect(() => resolveMode("a", id => (id === "a" ? { id, extends: ["ghost"] } : undefined))).toThrow(
			/未定义的预设/,
		);
	});

	it("扩展三态:缺省=全部,[]=仅内置,数组=白名单", () => {
		const none = resolveMode("none", id => ({ id }));
		expect(none.extensions).toBeUndefined();
		expect(none.extensionsExplicit).toBe(false);

		const empty = resolveMode("empty", id => ({ id, extensions: [] }));
		expect(empty.extensions).toEqual([]);
		expect(empty.extensionsExplicit).toBe(true);

		const list = resolveMode("list", id => ({ id, extensions: ["a", "b"] }));
		expect(list.extensions).toEqual(["a", "b"]);
	});

	it("扩展并集去重;子显式 [] 不贡献(共存语义,决策 #15)", () => {
		const out = resolveMode("child", id => ({
			id,
			...(id === "child" ? { extends: ["parent"], extensions: [] } : { extensions: ["a", "a", "b"] }),
		}));
		expect(out.extensions).toEqual(["a", "b"]);
		expect(out.extensionsExplicit).toBe(true);
	});

	it("prompt 同名子胜父,异名共存;string 快捷语法展开", () => {
		const out = resolveMode("child", id => ({
			id,
			...(id === "child"
				? { extends: ["parent"], prompt: [{ name: "p:role", order: 30, text: "child role" }, "child string rule"] }
				: {
						prompt: [
							{ name: "p:role", order: 10, text: "parent role" },
							{ name: "p:other", order: 20, text: "parent other" },
						],
					}),
		}));
		expect(out.prompt.map(p => p.name)).toContain("p:role");
		expect(out.prompt.find(p => p.name === "p:role")!.text).toBe("child role"); // 子胜
		expect(out.prompt.find(p => p.name === "p:other")!.text).toBe("parent other"); // 异名共存
		const shorthand = out.prompt.find(p => p.name.startsWith("mode:child:"));
		expect(shorthand).toBeDefined();
		expect(shorthand!.order).toBe(25);
	});

	it("promptComplete:最后声明者胜,其 prompt 集丢弃继承链其他 prompt", () => {
		const out = resolveMode("child", id => ({
			id,
			...(id === "child"
				? { extends: ["parent"], promptComplete: true, prompt: [{ name: "p:child", order: 5, text: "child only" }] }
				: { promptComplete: true, prompt: [{ name: "p:parent", order: 5, text: "parent only" }] }),
		}));
		expect(out.promptComplete).toBe(true);
		expect(out.prompt.map(p => p.name)).toEqual(["p:child"]); // 继承链 prompt 被丢弃
	});

	it("runtimeContext:链上任一显式 false 即 false(决策 #16)", () => {
		const off = resolveMode("child", id => ({
			id,
			...(id === "child" ? { extends: ["parent"] } : { runtimeContext: false }),
		}));
		expect(off.runtimeContext).toBe(false);
		const on = resolveMode("child", id => ({
			id,
			...(id === "child" ? { extends: ["parent"] } : { runtimeContext: true }),
		}));
		expect(on.runtimeContext).toBe(true);
	});

	it("settings 后者胜(拓扑序),缺省无覆盖", () => {
		const out = resolveMode("child", id => ({
			id,
			...(id === "child" ? { extends: ["parent"], settings: { a: 2, c: 3 } } : { settings: { a: 1, b: "x" } }),
		}));
		expect(out.settings).toEqual({ a: 2, b: "x", c: 3 });
	});

	it("modelRole 后者胜;未指定为 undefined", () => {
		const out = resolveMode("child", id => ({
			id,
			...(id === "child" ? { extends: ["parent"], modelRole: "fast" } : { modelRole: "slow" }),
		}));
		expect(out.modelRole).toBe("fast");
		expect(resolveMode("none", id => ({ id })).modelRole).toBeUndefined();
	});
});

describe("presets/resolve 校验", () => {
	it("非法 id / 非法 extends / 重复 section name / 非法 order", () => {
		const badId = validateMode({ id: "..", extends: ["../x"] });
		expect(badId.some(e => e.startsWith('id ".." 不合法'))).toBe(true);
		expect(badId).toContain('extends "../x" 不是合法预设 id');
		expect(
			validateMode({
				id: "ok",
				prompt: [
					{ name: "dup", order: 1, text: "a" },
					{ name: "dup", order: 2, text: "b" },
				],
			}),
		).toContain('prompt 区块 name "dup" 重复');
		expect(validateMode({ id: "ok", prompt: [{ name: "x", order: Number.NaN, text: "t" }] })).toContain(
			'prompt 区块 "x" 的 order 非法',
		);
	});

	it("knownExtensions 校验扩展存在性", () => {
		expect(validateMode({ id: "ok", extensions: ["ghost-tool"] }, { knownExtensions: ["real-tool"] })).toContain(
			'扩展 "ghost-tool" 未找到',
		);
		expect(validateMode({ id: "ok", extensions: ["real-tool"] }, { knownExtensions: ["real-tool"] })).toEqual([]);
	});
});

describe("presets/resolve 文件缓存", () => {
	const dir = join(import.meta.dir, ".tmp-modes-test");
	beforeEach(() => {
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("mtime 失效后重新展开;未定义 id 报错带 available 列表", () => {
		writeFileSync(join(dir, "base.json"), JSON.stringify({ label: "Base", extensions: ["a"] }));
		writeFileSync(join(dir, "child.json"), JSON.stringify({ extends: ["base"], settings: { x: 1 } }));
		const resolver = createModeResolver(dir);
		const first = resolver.resolve("child");
		expect(first.settings).toEqual({ x: 1 });
		expect(first.extensions).toEqual(["a"]);

		// 修改 base → 下次 resolve 重建(utimesSync 强制 mtime 变化,防同刻度 flaky)
		writeFileSync(join(dir, "base.json"), JSON.stringify({ label: "Base", extensions: ["a", "b"] }));
		const bump = Date.now() / 1000 + 1;
		utimesSync(join(dir, "base.json"), bump, bump);
		const second = resolver.resolve("child");
		expect(second.extensions).toEqual(["a", "b"]);

		expect(() => resolver.resolve("missing")).toThrow(/未找到预设\(available: base, child\)/);
	});

	it("环经文件加载同样抛错", () => {
		writeFileSync(join(dir, "a.json"), JSON.stringify({ extends: ["b"] }));
		writeFileSync(join(dir, "b.json"), JSON.stringify({ extends: ["a"] }));
		const resolver = createModeResolver(dir);
		expect(() => resolver.resolve("a")).toThrow(/环/);
	});
});

describe("presets/resolve 扩展声明预设(extraModes, modes v2 §5.5)", () => {
	it("文件层未命中时兜底查扩展 mode", () => {
		const resolver = createModeResolver("/nonexistent/dir", {
			extraModes: id => (id === "ext-mode" ? { id, label: "Ext Mode", modelRole: "fast" } : undefined),
		});
		const out = resolver.resolve("ext-mode");
		expect(out.label).toBe("Ext Mode");
		expect(out.modelRole).toBe("fast");
		expect(out.extensions).toBeUndefined(); // 无显式声明 → 全部启用
		expect(out.sources).toEqual(["ext-mode"]);
	});

	it("文件 mode 优先于扩展 mode(用户数据层压扩展代码层)", () => {
		const dir = mkdtempSync();
		writeFileSync(join(dir, "dup.json"), JSON.stringify({ label: "File Wins" }));
		const resolver = createModeResolver(dir, {
			extraModes: () => ({ id: "dup", label: "Extension Loses" }),
		});
		expect(resolver.resolve("dup").label).toBe("File Wins");
	});

	it("extends 链可混用文件与扩展 mode", () => {
		const dir = mkdtempSync();
		writeFileSync(join(dir, "base.json"), JSON.stringify({ extensions: ["file-ext"] }));
		const resolver = createModeResolver(dir, {
			extraModes: id => (id === "child" ? { id, extends: ["base"], extensions: ["ext-ext"] } : undefined),
		});
		const out = resolver.resolve("child");
		expect(out.sources).toEqual(["base", "child"]);
		expect(out.extensions).toEqual(["file-ext", "ext-ext"]); // 并集,拓扑序
	});

	it("纯扩展 mode 不因缺文件 mtime 而反复重建", () => {
		let calls = 0;
		const resolver = createModeResolver("/nonexistent/dir", {
			extraModes: id => {
				calls++;
				return id === "ext" ? { id } : undefined;
			},
		});
		resolver.resolve("ext");
		const afterFirst = calls; // 存在性检查 + dfs 各一次
		resolver.resolve("ext"); // 命中缓存,不重复调用 load
		expect(calls).toBe(afterFirst);
	});
});

function mkdtempSync(): string {
	const dir = join(import.meta.dir, `.tmp-modes-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	afterEach(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}
