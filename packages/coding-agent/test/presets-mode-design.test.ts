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
