import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectProfilePresetDefinitions, readDefaultPresetId, writeDefaultPresetId } from "./profile-presets";

let home: string;
let profileDir: string;
let bundleDir: string;

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-profile-presets-"));
	profileDir = path.join(home, ".musepi", "profiles", "desktop");
	bundleDir = path.join(profileDir, "node_modules", "@musepi", "preset-bundle");
	fs.mkdirSync(bundleDir, { recursive: true });
	fs.mkdirSync(path.join(home, ".musepi", "plugins", "node_modules"), { recursive: true });
});

afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
});

function write(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf8");
}

describe("collectProfilePresetDefinitions", () => {
	it("projects an Agent preset and its persona and nested plugin states", async () => {
		write(
			path.join(profileDir, "package.json"),
			JSON.stringify({ musepi: { profile: { bundles: ["@musepi/preset-bundle"] } } }),
		);
		write(
			path.join(bundleDir, "package.json"),
			JSON.stringify({ name: "@musepi/preset-bundle", dsh: { bundle: { patch: "./cordis.patch.yml" } } }),
		);
		write(
			path.join(bundleDir, "cordis.patch.yml"),
			[
				"- insert:",
				"    - id: preset-review",
				"      name: '@deepseek-ai/dsh-agent-preset'",
				"      config:",
				"        id: review",
				"        plugins:",
				"          - id: persona",
				"            name: '@musepi/persona'",
				"            config:",
				"              prefix: Reviewer",
				"              complete: true",
				"              includeRuntimeContext: false",
				"          - id: active-tool",
				"            name: '@demo/active'",
				"          - id: off-tool",
				"            name: '@demo/off'",
				"            disabled: true",
				"",
			].join("\n"),
		);

		const definitions = await collectProfilePresetDefinitions(profileDir, home, "desktop");

		expect(definitions).toHaveLength(1);
		expect(definitions[0]).toMatchObject({
			id: "review",
			label: "review",
			promptComplete: true,
			runtimeContext: false,
			prompt: [{ name: "mode:review:persona", order: 0, text: "Reviewer" }],
			plugins: [
				{ id: "persona", name: "@musepi/persona" },
				{ id: "active-tool", name: "@demo/active" },
				{ id: "off-tool", name: "@demo/off", enabled: false },
			],
		});
	});

	it("returns no definitions when the profile declares no composition", async () => {
		await expect(collectProfilePresetDefinitions(profileDir, home, "desktop")).resolves.toEqual([]);
	});

	it("reads and writes the default preset in the profile registry patch", async () => {
		write(
			path.join(profileDir, "cordis.patch.yml"),
			[
				"# keep this comment",
				"- insert:",
				"    - id: preset-review",
				"      name: '@musepi/agent-preset'",
				"      config:",
				"        id: review",
				"        plugins: []",
				"    - id: agent-preset-registry",
				"      name: '@musepi/agent-preset-registry'",
				"      config:",
				"        default: work",
				"",
			].join("\n"),
		);

		await expect(readDefaultPresetId(profileDir, home, "desktop")).resolves.toBe("work");
		await expect(writeDefaultPresetId(profileDir, home, "review", "desktop")).resolves.toBe("review");
		await expect(readDefaultPresetId(profileDir, home, "desktop")).resolves.toBe("review");
		const patch = fs.readFileSync(path.join(profileDir, "cordis.patch.yml"), "utf8");
		expect(patch).toContain("# keep this comment");
		expect(patch).toContain("selectedDefault: review");
	});

	it("allows a built-in file preset as the default without a bundle declaration", async () => {
		await expect(writeDefaultPresetId(profileDir, home, "work", "desktop")).resolves.toBe("work");
		const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, "package.json"), "utf8")) as {
			musepi: { profile: { bundles: string[] } };
		};
		expect(manifest.musepi.profile.bundles).toEqual([]);
	});
});
