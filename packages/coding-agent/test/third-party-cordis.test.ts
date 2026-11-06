import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { ExtensionRuntime } from "@musepi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@musepi/pi-coding-agent/extensibility/extensions/runner";
import { adaptThirdPartyCordisPlugin } from "@musepi/pi-coding-agent/extensibility/plugins/compat/third-party-cordis";
import { MarketplaceManager } from "@musepi/pi-coding-agent/extensibility/plugins/marketplace/manager";
import { mountPlugin } from "@musepi/pi-coding-agent/extensibility/plugins/runtime/mount";
import { EventBus } from "../src/utils/event-bus";

const tempDirs: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempRoot(kind: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `third-party-${kind}-`));
	tempDirs.push(dir);
	return dir;
}

async function superpowersRoot(): Promise<string> {
	const root = await tempRoot("superpowers");
	await Bun.write(
		path.join(root, "package.json"),
		JSON.stringify({
			name: "superpowers",
			version: "7.0.2",
			pi: { extensions: ["./.pi/extensions/superpowers.ts"] },
		}),
	);
	await Bun.write(
		path.join(root, ".codex-plugin", "plugin.json"),
		JSON.stringify({ interface: { logo: "./assets/app-icon.png" } }),
	);
	await Bun.write(path.join(root, "assets", "app-icon.png"), "superpowers icon");
	await Bun.write(
		path.join(root, ".pi", "extensions", "superpowers.ts"),
		`export default function (pi) {
			pi.on("session_start", async () => {});
			pi.on("session_compact", async () => {});
			pi.on("context", async event => ({
				messages: [{ role: "user", content: [{ type: "text", text: "superpowers bootstrap" }] }, ...event.messages],
			}));
		}`,
	);
	await Bun.write(
		path.join(root, "skills", "using-superpowers", "SKILL.md"),
		"---\nname: using-superpowers\ndescription: bootstrap\n---\nUse superpowers.\n",
	);
	return root;
}

async function modernWebRoot(): Promise<string> {
	const root = await tempRoot("modern-web");
	await Bun.write(
		path.join(root, "package.json"),
		JSON.stringify({ name: "modern-web-guidance", version: "0.0.197" }),
	);
	await Bun.write(
		path.join(root, ".codex-plugin", "plugin.json"),
		JSON.stringify({ interface: { logo: "./assets/logo.png" } }),
	);
	await Bun.write(path.join(root, "assets", "logo.png"), "modern web icon");
	await Bun.write(
		path.join(root, "skills", "modern-web-guidance", "SKILL.md"),
		"---\nname: modern-web-guidance\ndescription: Modern web best practices\n---\nUse modern web guidance.\n",
	);
	return root;
}

async function readManifest(root: string): Promise<Record<string, unknown>> {
	return (await Bun.file(path.join(root, "package.json")).json()) as Record<string, unknown>;
}

describe("third-party Cordis cache adaptation", () => {
	it("writes declarations only into cache and is idempotent", async () => {
		const superSource = await superpowersRoot();
		const modernSource = await modernWebRoot();
		const superCache = await superpowersRoot();
		const modernCache = await modernWebRoot();
		const superSourceBefore = await readManifest(superSource);
		const modernSourceBefore = await readManifest(modernSource);

		await adaptThirdPartyCordisPlugin(superCache);
		await adaptThirdPartyCordisPlugin(modernCache);
		await adaptThirdPartyCordisPlugin(superCache);
		await adaptThirdPartyCordisPlugin(modernCache);

		expect(await readManifest(superSource)).toEqual(superSourceBefore);
		expect(await readManifest(modernSource)).toEqual(modernSourceBefore);
		expect(await readManifest(superCache)).toMatchObject({
			musepi: {
				extensions: ["./.pi/extensions/superpowers.ts"],
				icon: pathToFileURL(path.join(superCache, "assets", "app-icon.png")).href,
			},
		});
		expect(await readManifest(modernCache)).toMatchObject({
			musepi: {
				extensions: ["./cordis/index.ts"],
				icon: pathToFileURL(path.join(modernCache, "assets", "logo.png")).href,
			},
		});
		expect(await Bun.file(path.join(modernCache, "cordis", "index.ts")).exists()).toBe(true);
	});

	it("does not adopt codex logo paths outside the plugin cache", async () => {
		const cache = await modernWebRoot();
		await Bun.write(
			path.join(cache, ".codex-plugin", "plugin.json"),
			JSON.stringify({ interface: { logo: "../outside.png" } }),
		);
		await Bun.write(path.join(cache, "..", "outside.png"), "outside icon");

		await adaptThirdPartyCordisPlugin(cache);

		const manifest = await readManifest(cache);
		expect((manifest.musepi as { icon?: unknown }).icon).toBeUndefined();
	});

	it("mounts Superpowers and returns bootstrap on initial and post-compaction contexts", async () => {
		const cache = await superpowersRoot();
		await adaptThirdPartyCordisPlugin(cache);
		const entryPath = path.join(cache, ".pi", "extensions", "superpowers.ts");
		const mounted = await mountPlugin({
			entryPath,
			cwd: cache,
			eventBus: new EventBus(),
			runtime: new ExtensionRuntime() as never,
			readConfig: async () => ({ fields: [], values: {} }),
		});
		if (!mounted.ok) throw new Error(mounted.message);
		const handlers = mounted.extension.handlers.get("context");
		expect(handlers).toHaveLength(1);
		const handler = handlers![0] as unknown as (event: { messages: unknown[] }) => Promise<{ messages: unknown[] }>;
		for (const eventType of ["session_start", "session_compact"]) {
			const result = await handler({ messages: [] });
			expect(JSON.stringify(result.messages)).toContain("superpowers bootstrap");
			expect(mounted.extension.handlers.has(eventType)).toBe(true);
		}
	});
});

async function mountModernWeb(cache?: string) {
	const root = cache ?? (await modernWebRoot());
	await adaptThirdPartyCordisPlugin(root);
	const entryPath = path.join(root, "cordis", "index.ts");
	const mounted = await mountPlugin({
		entryPath,
		cwd: root,
		eventBus: new EventBus(),
		runtime: new ExtensionRuntime() as never,
		readConfig: async () => ({ fields: [], values: {} }),
	});
	if (!mounted.ok) throw new Error(mounted.message);
	return { extension: mounted.extension, entryPath };
}

function processResult(stdout: string, exitCode = 0) {
	return {
		stdout: new Response(stdout).body,
		stderr: new Response("").body,
		exited: Promise.resolve(exitCode),
		kill: vi.fn(),
	};
}

describe("Modern Web Guidance Cordis plugin", () => {
	it("registers the upstream skill and returns real tool output before detach", async () => {
		const { extension, entryPath } = await mountModernWeb();
		expect(extension.skills.map(skill => skill.name)).toEqual(["modern-web-guidance"]);
		expect(extension.skills[0]?.content).toContain("Use modern web guidance");
		const spawn = vi.spyOn(Bun, "spawn").mockImplementation(() => processResult('[{"id":"dialog"}]') as never);
		const tool = extension.tools.get("modern_web_guidance");
		expect(tool).toBeDefined();
		const result = await tool!.definition.execute(
			"call-1",
			{ operation: "search", query: "accessible dialog" },
			undefined,
			undefined,
			{} as never,
		);
		const firstContent = result.content[0];
		expect(firstContent?.type === "text" ? firstContent.text : "").toContain("dialog");
		const [[executable, ...args]] = spawn.mock.calls[0]!;
		expect(executable).toBe(process.platform === "win32" ? "npx.cmd" : "npx");
		expect(args).toEqual(["-y", "modern-web-guidance@0.0.197", "search", "accessible dialog"]);

		const runner = new ExtensionRunner(
			[extension],
			new ExtensionRuntime(),
			path.dirname(entryPath),
			{} as never,
			{} as never,
		);
		expect(runner.getRegisteredTool("modern_web_guidance")).toBeDefined();
		expect(runner.removeExtension(entryPath)).toEqual(["modern_web_guidance"]);
		expect(runner.getRegisteredTool("modern_web_guidance")).toBeUndefined();
		expect(runner.getExtensionByPath(entryPath)).toBeUndefined();
	});

	it("validates operations and fails nonzero process exits", async () => {
		const { extension } = await mountModernWeb();
		const spawn = vi.spyOn(Bun, "spawn").mockImplementation(() => processResult("failed", 4) as never);
		const tool = extension.tools.get("modern_web_guidance")!;
		await expect(
			tool.definition.execute("call-1", { operation: "unknown" }, undefined, undefined, {} as never),
		).rejects.toThrow("operation");
		expect(spawn).not.toHaveBeenCalled();
		await expect(
			tool.definition.execute("call-1", { operation: "list" }, undefined, undefined, {} as never),
		).rejects.toThrow("4");
	});

	it("passes skill version and caps process output", async () => {
		const { extension } = await mountModernWeb();
		const child = processResult("x".repeat(300_000));
		const spawn = vi.spyOn(Bun, "spawn").mockImplementation(() => child as never);
		const tool = extension.tools.get("modern_web_guidance")!;
		const result = await tool.definition.execute(
			"call-1",
			{
				operation: "retrieve",
				query: "dialog",
				skillVersion: "2026_10_30-58d055df",
			},
			undefined,
			undefined,
			{} as never,
		);
		const firstContent = result.content[0];
		expect(firstContent?.type === "text" ? firstContent.text.length : 0).toBeLessThanOrEqual(256 * 1024);
		expect(firstContent?.type === "text" ? firstContent.text : "").toContain("truncated");
		const [[, ...args]] = spawn.mock.calls[0]!;
		expect(args).toContain("--skill-version");
		expect(args).toContain("2026_10_30-58d055df");
		expect(child.kill).toHaveBeenCalled();
	});
});

it("kills the child when the caller aborts", async () => {
	const { extension } = await mountModernWeb();
	const child = processResult("done");
	const spawned = Promise.withResolvers<void>();
	vi.spyOn(Bun, "spawn").mockImplementation(() => {
		spawned.resolve();
		return child as never;
	});
	const controller = new AbortController();
	child.exited = Bun.sleep(10).then(() => 0);
	const tool = extension.tools.get("modern_web_guidance")!;
	const execution = tool.definition.execute(
		"call-1",
		{ operation: "list" },
		controller.signal,
		undefined,
		{} as never,
	);
	await spawned.promise;
	controller.abort();
	await expect(execution).rejects.toThrow("abort");
	expect(child.kill).toHaveBeenCalled();
});

describe("curated marketplace install and upgrade", () => {
	it("mounts the adapted cache and preserves disabled state across upgrade", async () => {
		const source = await modernWebRoot();
		const root = await tempRoot("marketplace");
		const catalogPath = path.join(source, ".claude-plugin", "marketplace.json");
		await Bun.write(
			catalogPath,
			JSON.stringify({
				name: "test-modern",
				owner: { name: "Test" },
				plugins: [
					{
						name: "modern-web-guidance",
						source: "./",
						version: "0.0.197",
					},
				],
			}),
		);
		const manager = new MarketplaceManager({
			marketplacesRegistryPath: path.join(root, "marketplaces.json"),
			installedRegistryPath: path.join(root, "installed_plugins.json"),
			marketplacesCacheDir: path.join(root, "cache", "marketplaces"),
			pluginsCacheDir: path.join(root, "cache", "plugins"),
			compatibilityExemptionsPath: path.join(root, "compatibility.json"),
			clearPluginRootsCache: () => {},
		});

		await manager.addMarketplace(source);
		const installed = await manager.installPlugin("modern-web-guidance", "test-modern");
		expect(installed.version).toBe("0.0.197");
		expect(await readManifest(installed.installPath)).toMatchObject({
			version: "0.0.197",
			musepi: { extensions: ["./cordis/index.ts"] },
		});
		const { extension } = await mountModernWeb(installed.installPath);
		expect(extension.tools.has("modern_web_guidance")).toBe(true);

		const pluginId = "modern-web-guidance@test-modern";
		await manager.setPluginEnabled(pluginId, false);
		const catalog = (await Bun.file(catalogPath).json()) as { plugins: Array<{ version: string }> };
		catalog.plugins[0]!.version = "0.0.198";
		await Bun.write(catalogPath, JSON.stringify(catalog));
		await Bun.write(
			path.join(source, "package.json"),
			JSON.stringify({ name: "modern-web-guidance", version: "0.0.198" }),
		);
		await manager.updateMarketplace("test-modern");

		expect(await manager.checkForUpdates()).toEqual([{ pluginId, scope: "user", from: "0.0.197", to: "0.0.198" }]);
		const upgraded = await manager.upgradePlugin(pluginId);
		expect(upgraded.version).toBe("0.0.198");
		const summaries = await manager.listInstalledPlugins();
		expect(summaries).toHaveLength(1);
		expect(summaries[0]?.entries[0]).toMatchObject({ version: "0.0.198", enabled: false });
		expect(await readManifest(upgraded.installPath)).toMatchObject({
			version: "0.0.198",
			musepi: { extensions: ["./cordis/index.ts"] },
		});
		expect(await Bun.file(path.join(upgraded.installPath, "cordis", "index.ts")).exists()).toBe(true);
	});
});
