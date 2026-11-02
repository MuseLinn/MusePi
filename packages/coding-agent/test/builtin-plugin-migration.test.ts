import { describe, expect, it } from "bun:test";
import { discoverBundledPluginPaths } from "../src/discovery/builtin";
import { readExtensionPluginMeta } from "../src/extensibility/extensions/plugin-manifest";
import { loadAllExtensions } from "../src/extensibility/extensions-center/state-manager";
import { STT_MODELS } from "../src/stt/models";
import { KOKORO_VOICES, TTS_LOCAL_MODELS } from "../src/tts/models";

const EXPECTED_PLUGINS = [
	"task-card-style",
	"desktop-shell",
	"builtin-themes",
	"tool-cards",
	"stt",
	"tts",
	"terminal",
	"browser",
	"computer",
	"lsp",
	"file-tools",
] as const;

const RETIRED_ENTRY_IDS = [
	"style:task-card-swarm",
	"desktop-shell:shell",
	"theme:builtin-themes",
	"tool-render:builtin-cards",
	"voice:stt",
	"voice:tts",
	"terminal:terminal",
	"browser:browser",
	"computer:computer",
	"lsp:lsp",
	"file:file",
] as const;

describe("first-party subsystem plugin packages", () => {
	it("discovers each subsystem once under its canonical package name", async () => {
		const entries = await loadAllExtensions(process.cwd(), []);
		const plugins = entries.filter(entry =>
			EXPECTED_PLUGINS.includes(entry.name as (typeof EXPECTED_PLUGINS)[number]),
		);
		expect(plugins.map(entry => entry.name).sort()).toEqual([...EXPECTED_PLUGINS].sort());
		for (const plugin of plugins) {
			expect(plugin.id).toBe(plugin.name);
			expect(plugin.kind).toBe("plugin-module");
			expect(plugin.builtin).toBe(true);
			expect(plugin.source.level).toBe("native");
			expect(plugin.path.endsWith(".ts") || plugin.path.endsWith(".js")).toBe(true);
		}
		expect(entries.some(entry => RETIRED_ENTRY_IDS.includes(entry.id as (typeof RETIRED_ENTRY_IDS)[number]))).toBe(
			false,
		);
	}, 120_000);

	it("keeps model catalogs and settings-backed configuration on the manifests", async () => {
		const paths = await discoverBundledPluginPaths();
		const byName = new Map<string, string>();
		for (const entry of paths) {
			const name = entry.replaceAll("\\", "/").match(/bundled-plugins\/([^/]+)\//)?.[1];
			if (name) byName.set(name, entry);
		}
		const stt = await readExtensionPluginMeta(byName.get("stt")!);
		expect(stt?.host?.configStorage).toBe("settings");
		expect(stt?.components?.map(component => component.id)).toEqual(["whisper", "sensevoice", "parakeet"]);
		expect(stt?.fields.find(field => field.key === "stt.modelName")?.options).toEqual(
			STT_MODELS.map(model => model.key),
		);

		const tts = await readExtensionPluginMeta(byName.get("tts")!);
		expect(tts?.fields.find(field => field.key === "tts.localModel")?.options).toEqual(
			TTS_LOCAL_MODELS.map(model => model.key),
		);
		expect(tts?.fields.find(field => field.key === "tts.localVoice")?.options).toEqual([
			...KOKORO_VOICES.map(voice => voice.id),
			...TTS_LOCAL_MODELS.filter(model => model.key !== "kokoro").flatMap(model =>
				model.voices.map(voice => voice.id),
			),
		]);

		const file = await readExtensionPluginMeta(byName.get("file-tools")!);
		expect(file?.host?.readonly).toBe(true);
		expect(file?.components?.map(component => component.id)).toEqual(["read", "write", "search", "index"]);
	});
});
