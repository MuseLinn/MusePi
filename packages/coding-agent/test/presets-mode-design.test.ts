/**
 * Contract: the built-in `design` preset is a complete design workflow, not a
 * persona stub, and built-in template upgrades must never clobber a preset the
 * user edited.
 *
 * Why this exists: `design` shipped as one persona line, which made the mode
 * indistinguishable from a plain chat with a role prefix. `ensureModeTemplates`
 * also only wrote MISSING files, so any change to a built-in template silently
 * never reached existing users — and the obvious fix (overwrite on startup)
 * would destroy user edits. The upgrade path therefore has to be provably
 * conservative: same-content → upgrade, touched → leave alone.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BUILTIN_MODE_TEMPLATES,
	BUILTIN_TEMPLATE_REVISION,
	ensureModeTemplates,
	type ModeDefinition,
	modeFilePath,
	resolveMode,
	validateMode,
} from "@musepi/pi-coding-agent/presets/resolve";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "musepi-modes-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const readJson = (id: string): Record<string, unknown> =>
	JSON.parse(readFileSync(modeFilePath(dir, id), "utf8")) as Record<string, unknown>;

describe("built-in design preset", () => {
	it("carries the full workflow, not just a persona", () => {
		const design = BUILTIN_MODE_TEMPLATES.design;
		expect(design).toBeDefined();
		const sections = (design?.prompt ?? []).map(p => (typeof p === "string" ? p : p.name));
		for (const expected of [
			"mode:design:role",
			"mode:design:workflow",
			"mode:design:brief",
			"mode:design:artifact",
			"mode:design:boundary",
		]) {
			expect(sections).toContain(expected);
		}
	});

	it("teaches the radius/glass token rules the design system enforces", () => {
		const prompt = JSON.stringify(BUILTIN_MODE_TEMPLATES.design?.prompt ?? []);
		// docs/gui-design.md: literal px radii are banned, glass needs content behind it.
		expect(prompt).toContain("--radius-");
		expect(prompt).toContain("--glass-");
	});

	it("stays valid under validateMode", () => {
		for (const def of Object.values(BUILTIN_MODE_TEMPLATES)) {
			expect(validateMode(def)).toEqual([]);
		}
	});
});

describe("ensureModeTemplates upgrade path", () => {
	it("stamps new files with the current revision", () => {
		ensureModeTemplates(dir);
		expect(readJson("design").builtinRevision).toBe(BUILTIN_TEMPLATE_REVISION);
	});

	it("upgrades an untouched v1 design preset", () => {
		// The exact v1 file shape that old installs have on disk.
		writeFileSync(
			modeFilePath(dir, "design"),
			`${JSON.stringify(
				{
					id: "design",
					label: "Design",
					description: "设计模式:全量工具 + 设计师 persona(视觉方案优先)",
					prompt: [
						{
							name: "mode:design:role",
							order: 25,
							text: "你是一名资深 UI/UX 设计师。优先给出视觉方案而非代码;涉及布局时先做结构判断,再给实现细节。",
						},
					],
				},
				null,
				2,
			)}\n`,
			"utf8",
		);
		ensureModeTemplates(dir);
		const upgraded = readJson("design");
		expect(upgraded.builtinRevision).toBe(BUILTIN_TEMPLATE_REVISION);
		expect(JSON.stringify(upgraded)).toContain("mode:design:workflow");
	});

	it("upgrades an untouched v3 design preset (creation-prompts absorption)", () => {
		// The exact rev3 file shape (pre-2026-09-29) that existing installs have
		// on disk. Guards the upgrade chain itself: if LEGACY_TEMPLATES[3] is
		// missing or drifts, this file would no longer match and the preset
		// would silently stay on the old prompts.
		writeFileSync(
			modeFilePath(dir, "design"),
			`${JSON.stringify(
				{
					id: "design",
					label: "Design",
					description:
						"设计模式:视觉方案优先 —— 简报 → 结构判断 → 视觉方案 → 可预览产物 → 交付(落地代码切回 work 模式)",
					prompt: [
						{
							name: "mode:design:role",
							order: 25,
							text: "你是一名资深 UI/UX 设计师。优先给出视觉方案而非代码;涉及布局时先做结构判断,再给实现细节。",
						},
						{
							name: "mode:design:workflow",
							order: 30,
							text: "五步工作流:① 对齐简报(目标/平台/风格基准/参考/交付物)② 先做结构判断——信息层级与主导区域,不先挑颜色 ③ 给视觉方案(版式/节奏/层级)④ 产出可预览产物,并配 manifest ⑤ 交付:要落地实现代码时明确建议切回 work 模式,不要在本模式里顺手写实现。",
						},
						{
							name: "mode:design:brief",
							order: 35,
							text: "简报协议:开工前若目标、平台、风格基准、交付物有任何一项未知,先问最少必要的问题再动手,不要臆造需求。已有简报就沿用它,并在会话里保持可修改。",
						},
						{
							name: "mode:design:artifact",
							order: 40,
							text: "产物契约:每个可预览产物都要在产物目录写一份 sidecar manifest,文件名固定为 artifact.manifest.json,声明 entry 文件(相对路径,不得越出产物目录)、kind(page/component/poster/deck)、renderer(html/markdown/react-component/deck-html)、exports(导出格式)。没有 manifest 的产物无法被预览面板识别。",
						},
						{
							name: "mode:design:boundary",
							order: 45,
							text: "风格边界:客户端样式改动一律走设计 token —— 圆角只用 --radius-xs/sm/md/lg/xl/2xl(2/4/6/8/12/16),禁止字面 px 圆角;玻璃效果只用 --glass-* 阶梯(背景/模糊/内高光/外阴影四件套齐备),且只有背后有内容的悬浮层才允许用玻璃。任何偏离都要先说明理由。",
						},
					],
					builtinRevision: 3,
				},
				null,
				2,
			)}\n`,
			"utf8",
		);
		ensureModeTemplates(dir);
		const upgraded = readJson("design");
		expect(upgraded.builtinRevision).toBe(BUILTIN_TEMPLATE_REVISION);
		// New-content marker from the creation-prompts absorption: every design
		// judgment must be verifiable (evidence / scale / revision condition).
		expect(JSON.stringify(upgraded)).toContain("可验证");
	});

	it("leaves a user-edited preset alone", () => {
		const edited = {
			id: "design",
			label: "我的设计预设",
			description: "我自己改过的",
			prompt: [{ name: "mode:mine", order: 1, text: "只做扁平线框" }],
		};
		writeFileSync(modeFilePath(dir, "design"), `${JSON.stringify(edited, null, 2)}\n`, "utf8");
		ensureModeTemplates(dir);
		const after = readJson("design");
		expect(after.label).toBe("我的设计预设");
		expect(JSON.stringify(after)).not.toContain("mode:design:workflow");
	});

	it("does not touch a malformed preset file", () => {
		writeFileSync(modeFilePath(dir, "design"), "{ not json", "utf8");
		ensureModeTemplates(dir);
		expect(readFileSync(modeFilePath(dir, "design"), "utf8")).toBe("{ not json");
	});
});

describe("resolved design mode", () => {
	it("keeps the full toolset (no extension whitelist)", () => {
		ensureModeTemplates(dir);
		const load = (modeId: string) => JSON.parse(readFileSync(modeFilePath(dir, modeId), "utf8")) as ModeDefinition;
		const resolved = resolveMode("design", load);
		expect(resolved.id).toBe("design");
		// Design needs to read/write the repo; narrowing tools would detach it
		// from engineering reality (see the comment on the template).
		expect(resolved.extensions).toBeUndefined();
		expect(resolved.prompt.length).toBeGreaterThanOrEqual(5);
	});
});
