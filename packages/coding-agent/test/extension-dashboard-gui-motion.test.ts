/**
 * GUI motion pack scanning + toggle parity.
 *
 * `motion/*.css` inside an extension package root must surface in the
 * /extensions dashboard as `gui-motion:<name>` items (active by default,
 * disabled via the same disabledExtensions ids every other kind uses), and
 * the item must NOT carry the css body (the renderer reads it via fs.read
 * so extension scans stay cheap and raw never truncates).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@musepi/pi-coding-agent/config/settings";
import { initializeWithSettings, reset as resetDiscoveryCache } from "@musepi/pi-coding-agent/discovery";
import { loadAllExtensions } from "@musepi/pi-coding-agent/extensibility/extensions-center/state-manager";
import { __resetDirsFromEnvForTests, getProjectAgentDir, removeWithRetries, setAgentDir } from "@musepi/pi-utils";

describe("loadAllExtensions — gui-motion packs", () => {
	let projectDir = "";
	let userAgentDir = "";
	let extRoot = "";

	beforeEach(async () => {
		resetSettingsForTest();
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-motion-project-"));
		userAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-motion-user-"));
		extRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-motion-ext-"));
		setAgentDir(userAgentDir);

		await fs.mkdir(path.join(extRoot, "motion"), { recursive: true });
		await fs.writeFile(
			path.join(extRoot, "motion", "bouncy.css"),
			":root { --spring-bouncy: linear(0, 0.2 40%, 1); }",
		);
		await fs.writeFile(
			path.join(extRoot, "motion", "glassy.css"),
			"@keyframes gui-menu-in { from { opacity: 0; filter: blur(8px); } }",
		);
		// Non-css files in motion/ must be ignored.
		await fs.writeFile(path.join(extRoot, "motion", "README.md"), "not a pack");

		// Point the project-scope settings at the extension package root.
		const projectAgentDir = getProjectAgentDir(projectDir);
		await fs.mkdir(projectAgentDir, { recursive: true });
		await fs.writeFile(
			path.join(projectAgentDir, "settings.json"),
			JSON.stringify({ extensions: [extRoot] }),
		);

		const settings = await Settings.init({ inMemory: true, cwd: projectDir });
		initializeWithSettings(settings);
	});

	afterEach(async () => {
		resetSettingsForTest();
		resetDiscoveryCache();
		__resetDirsFromEnvForTests();
		await removeWithRetries(projectDir);
		await removeWithRetries(userAgentDir);
		await removeWithRetries(extRoot);
	});

	test("surfaces motion/*.css as gui-motion items (name without extension)", async () => {
		const extensions = await loadAllExtensions(projectDir, []);
		const bouncy = extensions.find(e => e.id === "gui-motion:bouncy");
		expect(bouncy).toBeDefined();
		expect(bouncy!.kind).toBe("gui-motion");
		expect(bouncy!.name).toBe("bouncy");
		expect(bouncy!.state).toBe("active");
		expect(bouncy!.source.level).toBe("project");

		const glassy = extensions.find(e => e.id === "gui-motion:glassy");
		expect(glassy).toBeDefined();
		expect(glassy!.path.endsWith("glassy.css")).toBe(true);

		// Non-css siblings are ignored.
		expect(extensions.some(e => e.id.includes("README"))).toBe(false);
	});

	test("item does not carry the css body (renderer reads via fs.read)", async () => {
		const extensions = await loadAllExtensions(projectDir, []);
		const bouncy = extensions.find(e => e.id === "gui-motion:bouncy");
		expect(bouncy).toBeDefined();
		expect(JSON.stringify(bouncy!.raw)).not.toContain("--spring-bouncy");
	});

	test("disabledExtensions id toggles the pack off", async () => {
		const extensions = await loadAllExtensions(projectDir, ["gui-motion:bouncy"]);
		const bouncy = extensions.find(e => e.id === "gui-motion:bouncy");
		expect(bouncy!.state).toBe("disabled");
		expect(bouncy!.disabledReason).toBe("item-disabled");

		const glassy = extensions.find(e => e.id === "gui-motion:glassy");
		expect(glassy!.state).toBe("active");
	});
});
