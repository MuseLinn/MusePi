import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { migratePluginOwnedBundledSkills } from "../src/sdk";

let agentDir: string;

beforeEach(() => {
	agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-plugin-skill-migration-"));
});

afterEach(() => {
	fs.rmSync(agentDir, { recursive: true, force: true });
});

function hash(content: string): string {
	let value = 0x811c9dc5;
	for (let index = 0; index < content.length; index++) {
		value ^= content.charCodeAt(index);
		value = Math.imul(value, 0x01000193);
	}
	return String(value >>> 0);
}

describe("plugin-owned bundled skill migration", () => {
	it("removes only untouched legacy copies and preserves user edits", async () => {
		const source = path.resolve(
			import.meta.dir,
			"../src/bundled-plugins/android-emulator/skills/android-emulator/SKILL.md",
		);
		const content = await Bun.file(source).text();
		for (const [name, disk] of [
			["untouched", content],
			["edited", `${content}\nUser note.\n`],
		] as const) {
			const dir = path.join(agentDir, name, "android-emulator");
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "SKILL.md"), disk);
			fs.writeFileSync(
				path.join(agentDir, name, ".bundled-manifest.json"),
				JSON.stringify({ "android-emulator": hash(content) }),
			);
		}

		for (const name of ["untouched", "edited"]) {
			const skillsDir = path.join(agentDir, name);
			const manifest = { "android-emulator": hash(content) };
			migratePluginOwnedBundledSkills(skillsDir, manifest);
			if (name === "untouched") {
				expect(fs.existsSync(path.join(skillsDir, "android-emulator", "SKILL.md"))).toBe(false);
				expect(manifest["android-emulator"]).toBeUndefined();
			} else {
				expect(fs.existsSync(path.join(skillsDir, "android-emulator", "SKILL.md"))).toBe(true);
				expect(manifest["android-emulator"]).toBe(hash(content));
			}
		}
	});

	it("migrates a product skill together with its resources", async () => {
		const sourceDir = path.resolve(import.meta.dir, "../src/bundled-plugins/product-skills/skills/ui-ux-pro-max");
		const source = path.join(sourceDir, "SKILL.md");
		const content = await Bun.file(source).text();
		const script = await Bun.file(path.join(sourceDir, "scripts/search.py")).text();
		for (const name of ["untouched", "edited"]) {
			const skillsDir = path.join(agentDir, name);
			const dir = path.join(skillsDir, "ui-ux-pro-max");
			fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
			fs.writeFileSync(path.join(dir, "SKILL.md"), name === "edited" ? `${content}\nUser note.\n` : content);
			fs.writeFileSync(path.join(dir, "scripts/search.py"), script);
			fs.writeFileSync(
				path.join(skillsDir, ".bundled-manifest.json"),
				JSON.stringify({ "ui-ux-pro-max": hash(content) }),
			);
			const manifest = { "ui-ux-pro-max": hash(content) };
			migratePluginOwnedBundledSkills(skillsDir, manifest);
			expect(fs.existsSync(dir)).toBe(name === "edited");
			if (name === "edited") expect(manifest["ui-ux-pro-max"]).toBe(hash(content));
			else expect(manifest["ui-ux-pro-max"]).toBeUndefined();
		}
	});
});
