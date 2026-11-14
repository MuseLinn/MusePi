import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { stageDaemon } from "../scripts/stage-desktop-daemon";
import { compileComponentModule } from "../src/daemon/extension-artifact-compiler";

const temporaryDirs: string[] = [];

async function fixture(): Promise<{ repoRoot: string; outputDir: string; binaryPath: string }> {
	const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-stage-daemon-"));
	temporaryDirs.push(repoRoot);
	const binaryPath = path.join(repoRoot, "musepi.exe");
	await Bun.write(binaryPath, "compiled daemon");
	const codingAgentRoot = path.join(repoRoot, "packages", "coding-agent");
	await Bun.write(path.join(codingAgentRoot, "src", "daemon", "pty-bridge.cjs"), "// staged PTY bridge\n");
	await Bun.write(
		path.join(codingAgentRoot, "node_modules", "bun-pty", "package.json"),
		JSON.stringify({ name: "bun-pty" }),
	);
	await Bun.write(
		path.join(codingAgentRoot, "node_modules", "bun-pty", "rust-pty", "target", "release", "rust_pty.dll"),
		"bun native asset",
	);
	await Bun.write(
		path.join(codingAgentRoot, "node_modules", "node-pty", "package.json"),
		JSON.stringify({ name: "node-pty" }),
	);
	await Bun.write(
		path.join(codingAgentRoot, "node_modules", "node-pty", "prebuilds", "win32-x64", "pty.node"),
		"node native asset",
	);
	for (const [root, name] of [
		["packages/coding-agent/src/bundled-plugins", "daemon-plugin"],
		["apps/desktop/src/plugins", "desktop-plugin"],
	] as const) {
		const pluginDir = path.join(repoRoot, root, name);
		await Bun.write(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name,
				musepi: {
					extensions: ["./index.ts"],
					components: [{ id: "backend", entry: "./component.ts", description: "Backend component" }],
				},
			}),
		);
		await Bun.write(path.join(pluginDir, "label.ts"), `export const label = ${JSON.stringify(name)};\n`);
		await Bun.write(
			path.join(repoRoot, "node_modules", "@musepi", "pi-utils", "package.json"),
			JSON.stringify({ name: "@musepi/pi-utils", type: "module", exports: "./index.js" }),
		);
		await Bun.write(
			path.join(repoRoot, "node_modules", "cross-spawn", "package.json"),
			JSON.stringify({ name: "cross-spawn", type: "module", exports: "./index.js" }),
		);
		await Bun.write(
			path.join(repoRoot, "node_modules", "cross-spawn", "index.js"),
			`export const transitiveLabel = "transitive";\n`,
		);
		await Bun.write(
			path.join(repoRoot, "node_modules", "@musepi", "pi-utils", "index.js"),
			`import { transitiveLabel } from "cross-spawn";\nexport const internalLabel = "self-contained:" + transitiveLabel;\n`,
		);
		await Bun.write(
			path.join(pluginDir, "component.ts"),
			`import { internalLabel } from "@musepi/pi-utils";\nimport { label } from "./label";\nexport default function component(pi) { pi.effect(() => {}, label + ":" + internalLabel); }\n`,
		);
		await Bun.write(
			path.join(pluginDir, "index.ts"),
			`import { label } from "./label";\nexport function apply(pi) { pi.registerComponent({ slot: "panel.tab.test", moduleUrl: "./page.tsx", label }); }\nexport default apply;\n`,
		);
		await Bun.write(
			path.join(pluginDir, "page.tsx"),
			`import "./page.css";\nexport default function Page() { return <main>Plugin</main>; }\n`,
		);
		await Bun.write(path.join(pluginDir, "page.css"), "main { color: red; }\n");
		await Bun.write(
			path.join(pluginDir, "skills", "fixture-skill", "SKILL.md"),
			"---\nname: fixture-skill\ndescription: Fixture skill\n---\nUse the fixture resource.\n",
		);
		await Bun.write(path.join(pluginDir, "skills", "fixture-skill", "scripts", "search.py"), "print('fixture')\n");
	}
	const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-staged-standalone-"));
	temporaryDirs.push(outputDir);
	return { repoRoot, outputDir, binaryPath };
}

afterEach(async () => {
	await Promise.all(temporaryDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("desktop daemon staging", () => {
	it("ships loadable plugin bundles without their source dependency graph", async () => {
		const options = await fixture();
		await stageDaemon(options);

		expect(await Bun.file(path.join(options.outputDir, "musepi.exe")).text()).toBe("compiled daemon");
		expect(
			await Bun.file(
				path.join(options.outputDir, "node_modules", "bun-pty", "rust-pty", "target", "release", "rust_pty.dll"),
			).text(),
		).toBe("bun native asset");
		expect(
			await Bun.file(
				path.join(options.outputDir, "node_modules", "node-pty", "prebuilds", "win32-x64", "pty.node"),
			).text(),
		).toBe("node native asset");
		expect(await Bun.file(path.join(options.outputDir, "bundled-plugins", "terminal", "pty-bridge.cjs")).text()).toBe(
			"// staged PTY bridge\n",
		);
		for (const [root, name] of [
			["bundled-plugins", "daemon-plugin"],
			["desktop-plugins", "desktop-plugin"],
		] as const) {
			const pluginDir = path.join(options.outputDir, root, name);
			const manifest = await Bun.file(path.join(pluginDir, "package.json")).json();
			expect(manifest.musepi.extensions).toEqual(["./index.js"]);
			expect(manifest.musepi.components).toEqual([
				{ id: "backend", entry: "./component.js", description: "Backend component" },
			]);
			expect(await Bun.file(path.join(pluginDir, "label.ts")).exists()).toBe(false);
			expect(await Bun.file(path.join(pluginDir, "skills", "fixture-skill", "SKILL.md")).text()).toContain(
				"name: fixture-skill",
			);
			expect(await Bun.file(path.join(pluginDir, "skills", "fixture-skill", "scripts", "search.py")).text()).toBe(
				"print('fixture')\n",
			);

			const effects: Array<{ label: string }> = [];
			const component = await import(`file:///${path.join(pluginDir, "component.js").replaceAll("\\", "/")}`);
			component.default({ effect: (_dispose: () => void, label: string) => effects.push({ label }) });
			expect(effects).toEqual([{ label: `${name}:self-contained:transitive` }]);

			const registrations: Array<{ slot: string; moduleUrl: string; label: string }> = [];
			const entry = await import(`file:///${path.join(pluginDir, "index.js").replaceAll("\\", "/")}`);
			entry.default({
				registerComponent: (component: (typeof registrations)[number]) => registrations.push(component),
			});
			expect(registrations).toEqual([{ slot: "panel.tab.test", moduleUrl: "./page.js", label: name }]);
			expect((await compileComponentModule(path.join(pluginDir, "page.js"))).css).toContain("color:red");
		}
	});

	it("rejects a staged plugin whose declared entry is missing", async () => {
		const options = await fixture();
		const brokenEntry = path.join(
			options.repoRoot,
			"apps",
			"desktop",
			"src",
			"plugins",
			"desktop-plugin",
			"index.ts",
		);
		await fs.rm(brokenEntry);

		await expect(stageDaemon(options)).rejects.toThrow("ENOENT");
	});
});
