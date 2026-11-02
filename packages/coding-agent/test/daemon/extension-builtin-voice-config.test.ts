import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import type { CordisDynamicPluginRuntime } from "../../src/daemon/cordis-dynamic-plugins";
import { ExtensionService } from "../../src/daemon/services/extension-service";
import { createBundledPluginRuntime } from "../helpers/bundled-plugin-runtime";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

interface VoiceFixture {
	agentDir: string;
	tmpCwd: string;
	settings: Settings;
	service: ExtensionService;
	runtime: CordisDynamicPluginRuntime;
	changedCount: () => number;
	dispose(): Promise<void>;
}

async function createVoiceFixture(prefix: string): Promise<VoiceFixture> {
	const agentDir = await isolateAgentDirForTest(prefix);
	const tmpCwd = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}cwd-`));
	const settings = Settings.isolated();
	const bundled = createBundledPluginRuntime();
	let changedCount = 0;
	const service = new ExtensionService({
		settings: () => settings,
		ensureRegistry: async () => {},
		cwd: () => tmpCwd,
		webUrl: () => null,
		webPortFile: () => path.join(agentDir, "web.port"),
		dynamicRuntime: async () => bundled.runtime,
		onChanged: () => {
			changedCount++;
		},
	});
	return {
		agentDir,
		tmpCwd,
		settings,
		service,
		runtime: bundled.runtime,
		changedCount: () => changedCount,
		async dispose() {
			await bundled.dispose();
			await restoreAgentDirForTest(agentDir);
			await fs.rm(tmpCwd, { recursive: true, force: true });
		},
	};
}

describe("first-party voice packages", () => {
	let fixture: VoiceFixture;

	beforeAll(async () => {
		fixture = await createVoiceFixture("omp-builtin-voice-");
	}, 30_000);

	afterAll(async () => {
		await fixture.dispose();
	}, 30_000);

	beforeEach(() => {
		fixture.settings.set("stt.enabled", true);
		fixture.settings.set("speech.enabled", true);
	});

	test("lists declared fields and settings-backed values", async () => {
		fixture.settings.set("stt.modelName", "sensevoice");
		const listed = await fixture.service.list();
		const stt = listed.extensions.find(entry => entry.id === "stt");
		expect(stt?.builtin).toBe(true);
		expect(stt?.config?.map(field => field.key)).toEqual([
			"stt.modelName",
			"stt.language",
			"stt.vadEndMs",
			"stt.submitTrigger",
		]);
		expect(stt?.configValues?.["stt.modelName"]).toBe("sensevoice");
		expect(stt?.configValues?.["stt.vadEndMs"]).toBe(700);

		const tts = listed.extensions.find(entry => entry.id === "tts");
		expect(tts?.config?.map(field => field.key)).toEqual([
			"tts.localModel",
			"tts.localVoice",
			"tts.rate",
			"tts.inputMode",
			"tts.autoRead",
		]);
		expect(tts?.configValues?.["tts.rate"]).toBe(1);
	});

	test("writes declared configuration and reads it back", async () => {
		const before = fixture.changedCount();
		const result = await fixture.service.setConfig({ id: "tts", key: "tts.rate", value: 1.5 });
		expect(result.restart).toBe("none");
		expect(fixture.settings.getRaw("tts.rate")).toBe(1.5);
		expect(fixture.changedCount()).toBe(before + 1);
		const tts = (await fixture.service.list()).extensions.find(entry => entry.id === "tts");
		expect(tts?.configValues?.["tts.rate"]).toBe(1.5);
	});

	test("clamps numeric configuration and rejects undeclared keys", async () => {
		await fixture.service.setConfig({ id: "tts", key: "tts.rate", value: 42 });
		expect(fixture.settings.getRaw("tts.rate")).toBe(2);
		const before = fixture.changedCount();
		await expect(fixture.service.setConfig({ id: "stt", key: "rogue", value: 1 })).rejects.toThrow(
			/not a declared config field/,
		);
		expect(fixture.changedCount()).toBe(before);
	});

	test("package toggles change only package state and the real fiber", async () => {
		await fixture.service.getExtensionRuntimeLoad();
		fixture.settings.set("stt.enabled", true);
		await fixture.service.setEnabled({ id: "stt", enabled: false });
		expect(fixture.settings.getRaw("stt.enabled")).toBe(true);
		expect(fixture.settings.get("disabledExtensions")).toContain("stt");
		expect(fixture.runtime.inspect().find(plugin => plugin.name === "stt")?.status).toBe("unloaded");
		expect((await fixture.service.list()).extensions.find(entry => entry.id === "stt")?.state).toBe("disabled");

		await fixture.service.setEnabled({ id: "stt", enabled: true });
		expect(fixture.settings.getRaw("stt.enabled")).toBe(true);
		expect(fixture.settings.get("disabledExtensions")).not.toContain("stt");
	}, 30_000);

	test("rejects the retired voice ID without writing either state", async () => {
		await expect(fixture.service.setEnabled({ id: "voice:stt", enabled: false })).rejects.toThrow(
			/unknown extension/,
		);
		expect(fixture.settings.getRaw("stt.enabled")).toBe(true);
		expect(fixture.settings.get("disabledExtensions")).not.toContain("stt");
	});
});

describe("other first-party packages", () => {
	let agentDir: string;
	let tmpCwd: string;
	let service: ExtensionService;
	let settings: Settings;

	beforeAll(async () => {
		agentDir = await isolateAgentDirForTest("omp-builtin-subs-");
	}, 30_000);

	afterAll(async () => {
		await restoreAgentDirForTest(agentDir);
	}, 30_000);

	beforeEach(async () => {
		tmpCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-builtin-subs-cwd-"));
		settings = Settings.isolated();
		service = new ExtensionService({
			settings: () => settings,
			ensureRegistry: async () => {},
			cwd: () => tmpCwd,
			webUrl: () => null,
			webPortFile: () => path.join(agentDir, "web.port"),
			onChanged: () => {},
		});
	});

	afterEach(async () => {
		await fs.rm(tmpCwd, { recursive: true, force: true });
	});

	test("terminal is read-only and uses canonical config IDs", async () => {
		const terminal = (await service.list()).extensions.find(entry => entry.id === "terminal");
		expect(terminal?.readonly).toBe(true);
		expect(terminal?.config?.map(field => field.key)).toEqual([
			"terminal.provider",
			"terminal.showImages",
			"terminal.showProgress",
		]);
		await service.setConfig({ id: "terminal", key: "terminal.showImages", value: false });
		expect(settings.getRaw("terminal.showImages")).toBe(false);
		await expect(service.setEnabled({ id: "terminal", enabled: false })).rejects.toThrow(/read-only/);
	});

	test("browser package disable does not rewrite browser.enabled", async () => {
		settings.set("browser.enabled", true);
		await service.setEnabled({ id: "browser", enabled: false });
		expect(settings.getRaw("browser.enabled")).toBe(true);
		expect(settings.get("disabledExtensions")).toContain("browser");
		expect((await service.list()).extensions.find(entry => entry.id === "browser")?.state).toBe("disabled");
		await service.setConfig({ id: "browser", key: "browser.headless", value: false });
		expect(settings.getRaw("browser.headless")).toBe(false);
	});

	test("computer and lsp use canonical package and config IDs", async () => {
		settings.set("computer.enabled", true);
		await service.setEnabled({ id: "computer", enabled: false });
		expect(settings.getRaw("computer.enabled")).toBe(true);
		expect((await service.list()).extensions.find(entry => entry.id === "computer")?.state).toBe("disabled");
		await service.setConfig({ id: "lsp", key: "lsp.lazy", value: false });
		expect(settings.getRaw("lsp.lazy")).toBe(false);
	});
});

describe("entry components", () => {
	let fixture: VoiceFixture;

	beforeAll(async () => {
		fixture = await createVoiceFixture("omp-builtin-components-");
	}, 30_000);

	afterAll(async () => {
		await fixture.dispose();
	}, 30_000);

	test("lists manifest components and toggles computer independently", async () => {
		const { settings, service } = fixture;
		const listed = await service.list();
		expect(
			listed.extensions.find(entry => entry.id === "browser")?.components?.map(component => component.id),
		).toEqual(["launch", "attach", "gui"]);
		expect(listed.extensions.find(entry => entry.id === "stt")?.components?.map(component => component.id)).toEqual([
			"whisper",
			"sensevoice",
			"parakeet",
		]);
		const before = listed.extensions.find(entry => entry.id === "computer");
		await service.setComponentEnabled({ id: "computer", component: "computer", enabled: false });
		expect(settings.get("tools.disabled")).toEqual([]);
		expect(settings.get("disabledExtensionComponents")).toEqual(["computer/computer"]);
		const after = (await service.list()).extensions.find(entry => entry.id === "computer");
		expect(after?.components?.[0]?.enabled).toBe(false);
		expect(after?.state).toBe(before?.state);
		await service.setComponentEnabled({ id: "computer", component: "computer", enabled: true });
	}, 30_000);

	test("rejects retired IDs and undeclared components", async () => {
		await expect(
			fixture.service.setComponentEnabled({ id: "terminal:terminal", component: "bun-pty", enabled: false }),
		).rejects.toThrow(/not a declared component/);
		await expect(
			fixture.service.setComponentEnabled({ id: "browser", component: "rogue", enabled: false }),
		).rejects.toThrow(/not a declared component/);
		expect(fixture.settings.get("disabledExtensionComponents")).toEqual([]);
	});

	test("voice engine fibers change model catalogs and fallback", async () => {
		const { service } = fixture;
		const { enabledSttModels, enabledTtsModels, resolveEnabledSttModel, resolveEnabledTtsModel } = await import(
			"../../src/voice/engine-denylist"
		);
		await service.setComponentEnabled({ id: "stt", component: "whisper", enabled: false });
		await service.setComponentEnabled({ id: "tts", component: "melotts-zh", enabled: false });
		expect(enabledSttModels().map(model => model.key)).toEqual(["parakeet", "sensevoice"]);
		expect(resolveEnabledSttModel("balanced").key).toBe("parakeet");
		expect(enabledTtsModels().map(model => model.key)).toEqual(["kokoro"]);
		expect(resolveEnabledTtsModel("melotts-zh").key).toBe("kokoro");

		await service.setComponentEnabled({ id: "stt", component: "whisper", enabled: true });
		await service.setComponentEnabled({ id: "tts", component: "melotts-zh", enabled: true });
		expect(enabledSttModels().map(model => model.key)).toContain("balanced");
		expect(resolveEnabledTtsModel("melotts-zh").key).toBe("melotts-zh");
	}, 30_000);
});

describe("extensions.list preset plane", () => {
	let agentDir: string;
	let tmpCwd: string;
	let modesDir: string;
	let service: ExtensionService;

	beforeAll(async () => {
		agentDir = await isolateAgentDirForTest("omp-ext-preset-plane-");
	}, 30_000);

	afterAll(async () => {
		await restoreAgentDirForTest(agentDir);
	}, 30_000);

	beforeEach(async () => {
		tmpCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ext-preset-plane-cwd-"));
		modesDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ext-preset-plane-modes-"));
		service = new ExtensionService({
			settings: () => Settings.isolated(),
			ensureRegistry: async () => {},
			cwd: () => tmpCwd,
			webUrl: () => null,
			webPortFile: () => path.join(agentDir, "web.port"),
			modesDir: () => modesDir,
			onChanged: () => {},
		});
	});

	afterEach(async () => {
		await fs.rm(tmpCwd, { recursive: true, force: true });
		await fs.rm(modesDir, { recursive: true, force: true });
	});

	test("explicit extension whitelists feed enabledInPresets", async () => {
		await fs.mkdir(path.join(tmpCwd, ".musepi", "extensions", "my-ext"), { recursive: true });
		await fs.writeFile(path.join(tmpCwd, ".musepi", "extensions", "my-ext", "index.ts"), "export default {};\n");
		await fs.writeFile(
			path.join(modesDir, "my-preset.json"),
			JSON.stringify({ id: "my-preset", label: "My Preset", extensions: ["my-ext"] }),
		);
		await fs.writeFile(
			path.join(modesDir, "no-explicit.json"),
			JSON.stringify({ id: "no-explicit", label: "No Explicit" }),
		);
		const listed = await service.list();
		const mine = listed.extensions.find(entry => entry.kind === "extension-module" && entry.name === "my-ext");
		expect(mine?.enabledInPresets).toEqual(["My Preset"]);
		expect(listed.presets?.some(preset => preset.id === "my-preset")).toBe(true);
		expect(listed.presets?.some(preset => preset.id === "no-explicit")).toBe(false);
	});

	test("extensions outside the whitelist have no preset annotation", async () => {
		await fs.mkdir(path.join(tmpCwd, ".musepi", "extensions", "other-ext"), { recursive: true });
		await fs.writeFile(path.join(tmpCwd, ".musepi", "extensions", "other-ext", "index.ts"), "export default {};\n");
		await fs.writeFile(
			path.join(modesDir, "my-preset.json"),
			JSON.stringify({ id: "my-preset", label: "My Preset", extensions: ["unrelated"] }),
		);
		const other = (await service.list()).extensions.find(
			entry => entry.kind === "extension-module" && entry.name === "other-ext",
		);
		expect(other?.enabledInPresets).toBeUndefined();
	});
});

describe("extensions.list runtime state", () => {
	let fixture: VoiceFixture;

	beforeAll(async () => {
		fixture = await createVoiceFixture("omp-ext-runtime-plane-");
		await fixture.service.getExtensionRuntimeLoad();
	}, 30_000);

	afterAll(async () => {
		await fixture.dispose();
	}, 30_000);

	test("runtime follows the package fiber, not domain switches", async () => {
		fixture.settings.set("stt.enabled", false);
		const stt = (await fixture.service.list()).extensions.find(entry => entry.id === "stt");
		const inspected = fixture.runtime.inspect().find(plugin => plugin.name === "stt");
		expect(inspected).toBeDefined();
		if (!inspected?.fiberState) throw new Error("stt runtime inspection missing");
		expect(stt?.activation).toBeUndefined();
		expect(stt?.runtime).toEqual({
			fiberState: inspected.fiberState,
			effects: inspected.effectLabels.length,
			operational: "running",
		});
		expect(stt?.state).toBe("active");
	});

	test("host inspection is optional", async () => {
		const service = new ExtensionService({
			settings: () => fixture.settings,
			ensureRegistry: async () => {},
			cwd: () => fixture.tmpCwd,
			webUrl: () => null,
			webPortFile: () => path.join(fixture.agentDir, "web.port"),
			onChanged: () => {},
		});
		const stt = (await service.list()).extensions.find(entry => entry.id === "stt");
		expect(stt).toBeDefined();
		expect(stt?.runtime).toBeUndefined();
		expect(stt?.activation).toBeUndefined();
	});
});
