import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { migrateLegacyPiAgentDir } from "../src/migrations.ts";

describe("legacy pi agent dir migration", () => {
	const tempDirs: string[] = [];
	let savedAgentDirEnv: string | undefined;

	beforeEach(() => {
		savedAgentDirEnv = process.env[ENV_AGENT_DIR];
		delete process.env[ENV_AGENT_DIR];
	});

	afterEach(() => {
		if (savedAgentDirEnv === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = savedAgentDirEnv;
		}
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeTempDir(prefix: string): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
		tempDirs.push(dir);
		return dir;
	}

	function makeLegacyDir(files: Record<string, string>): string {
		const legacy = path.join(makeTempDir("pi-legacy-home-"), "agent");
		fs.mkdirSync(legacy, { recursive: true });
		for (const [name, content] of Object.entries(files)) {
			fs.writeFileSync(path.join(legacy, name), content, "utf-8");
		}
		return legacy;
	}

	it("does nothing when the legacy agent dir does not exist", () => {
		const root = makeTempDir("pi-migration-test-");
		const legacy = path.join(root, "legacy", "agent");
		const target = path.join(root, "target", "agent");

		const copied = migrateLegacyPiAgentDir({ legacyAgentDir: legacy, targetAgentDir: target });

		expect(copied).toEqual([]);
		expect(fs.existsSync(target)).toBe(false);
	});

	it("copies all four core config files when present", () => {
		const legacy = makeLegacyDir({
			"auth.json": '{"anthropic":{"type":"api_key","key":"k"}}',
			"settings.json": '{"theme":"dark"}',
			"models.json": '{"providers":{}}',
			"keybindings.json": "{}",
		});
		const target = path.join(makeTempDir("pi-migration-test-"), "target", "agent");

		const copied = migrateLegacyPiAgentDir({ legacyAgentDir: legacy, targetAgentDir: target });

		expect(copied.sort()).toEqual(["auth.json", "keybindings.json", "models.json", "settings.json"]);
		for (const file of copied) {
			expect(fs.readFileSync(path.join(target, file), "utf-8")).toBe(
				fs.readFileSync(path.join(legacy, file), "utf-8"),
			);
		}
	});

	it("copies only the files that exist when some are missing", () => {
		const legacy = makeLegacyDir({
			"auth.json": "{}",
			"models.json": "{}",
		});
		const target = path.join(makeTempDir("pi-migration-test-"), "target", "agent");

		const copied = migrateLegacyPiAgentDir({ legacyAgentDir: legacy, targetAgentDir: target });

		expect(copied.sort()).toEqual(["auth.json", "models.json"]);
		expect(fs.existsSync(path.join(target, "settings.json"))).toBe(false);
		expect(fs.existsSync(path.join(target, "keybindings.json"))).toBe(false);
	});

	it("does not copy extensions, sessions, or npm directories", () => {
		const legacy = makeLegacyDir({ "settings.json": "{}" });
		for (const dir of ["extensions", "sessions", "npm"]) {
			const subdir = path.join(legacy, dir);
			fs.mkdirSync(subdir, { recursive: true });
			fs.writeFileSync(path.join(subdir, "marker.txt"), "do not copy", "utf-8");
		}
		const target = path.join(makeTempDir("pi-migration-test-"), "target", "agent");

		const copied = migrateLegacyPiAgentDir({ legacyAgentDir: legacy, targetAgentDir: target });

		expect(copied).toEqual(["settings.json"]);
		for (const dir of ["extensions", "sessions", "npm"]) {
			expect(fs.existsSync(path.join(target, dir))).toBe(false);
		}
	});

	it("skips when the target agent dir already exists", () => {
		const legacy = makeLegacyDir({ "settings.json": '{"theme":"dark"}' });
		const target = path.join(makeTempDir("pi-migration-test-"), "target", "agent");
		fs.mkdirSync(target, { recursive: true });
		fs.writeFileSync(path.join(target, "settings.json"), '{"theme":"light"}', "utf-8");

		const copied = migrateLegacyPiAgentDir({ legacyAgentDir: legacy, targetAgentDir: target });

		expect(copied).toEqual([]);
		expect(fs.readFileSync(path.join(target, "settings.json"), "utf-8")).toBe('{"theme":"light"}');
	});

	it("skips when a custom agent dir override is set", () => {
		const legacy = makeLegacyDir({ "settings.json": "{}" });
		const target = path.join(makeTempDir("pi-migration-test-"), "target", "agent");
		process.env[ENV_AGENT_DIR] = target;

		const copied = migrateLegacyPiAgentDir({ legacyAgentDir: legacy, targetAgentDir: target });

		expect(copied).toEqual([]);
		expect(fs.existsSync(target)).toBe(false);
	});
});
