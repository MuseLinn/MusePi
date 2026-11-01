import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listPluginManagementPackages } from "./plugin-management";

let home: string;
let cwd: string;
let profileDir: string;

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-plugin-management-home-"));
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-plugin-management-cwd-"));
	profileDir = path.join(home, ".musepi", "profiles", "desktop");
});

afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
	fs.rmSync(cwd, { recursive: true, force: true });
});

function write(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf8");
}

function packageJson(name: string, bundle = false): string {
	return JSON.stringify({
		name,
		version: "1.0.0",
		musepi: { extensions: ["./index.ts"] },
		...(bundle ? { dsh: { bundle: { patch: "./cordis.patch.yml" } } } : {}),
	});
}

describe("plugin management inventory", () => {
	it("merges ordinary packages and bundle selection without losing missing bundles", async () => {
		const pluginsRoot = path.join(home, ".musepi", "plugins");
		write(path.join(pluginsRoot, "node_modules", "@demo", "plain", "package.json"), packageJson("@demo/plain"));
		write(
			path.join(pluginsRoot, "musepi-plugins.lock.json"),
			JSON.stringify({ plugins: { "@demo/plain": { version: "1.0.0", enabled: true, enabledFeatures: null } } }),
		);
		for (const name of ["selected", "optional"]) {
			const fullName = `@demo/${name}`;
			write(path.join(profileDir, "node_modules", "@demo", name, "package.json"), packageJson(fullName, true));
			write(path.join(profileDir, "node_modules", "@demo", name, "cordis.patch.yml"), "[]\n");
		}
		write(
			path.join(profileDir, "package.json"),
			JSON.stringify({ musepi: { profile: { bundles: ["@demo/selected", "@demo/missing"] } } }),
		);

		const rows = await listPluginManagementPackages(cwd, home, "desktop");
		expect(rows.map(row => [row.name, row.management, row.enabled, row.readable])).toEqual([
			["@demo/plain", "package", true, undefined],
			["@demo/selected", "bundle", true, true],
			["@demo/missing", "bundle", true, false],
			["@demo/optional", "bundle", false, true],
		]);
	});
});
