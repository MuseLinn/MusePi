import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { CordisDynamicPluginRuntime } from "../../src/daemon/cordis-dynamic-plugins";
import { DaemonHostContext } from "../../src/daemon/host-context";
import { enabledSttModels, enabledTtsModels } from "../../src/voice/engine-denylist";
import { resetVoiceEngineActivations } from "../../src/voice/engine-registry";

const STT_PACKAGE = path.resolve(import.meta.dir, "../../src/bundled-plugins/stt");
const TTS_PACKAGE = path.resolve(import.meta.dir, "../../src/bundled-plugins/tts");

describe("bundled voice engine component lifecycle", () => {
	it("changes the usable model catalogs when engine fibers stop and restart", async () => {
		const host = new DaemonHostContext();
		const runtime = new CordisDynamicPluginRuntime(host);
		try {
			await runtime.load(STT_PACKAGE, process.cwd());
			await runtime.load(TTS_PACKAGE, process.cwd());
			expect(enabledSttModels().map(model => model.key)).toContain("balanced");
			expect(enabledTtsModels().map(model => model.key)).toContain("kokoro");

			await runtime.setComponentEnabled("stt", "whisper", false);
			expect(enabledSttModels().map(model => model.key)).toEqual(["parakeet", "sensevoice"]);
			await runtime.setComponentEnabled("stt", "whisper", true);
			expect(enabledSttModels().map(model => model.key)).toContain("balanced");

			await runtime.setComponentEnabled("tts", "kokoro", false);
			expect(enabledTtsModels().map(model => model.key)).toEqual(["melotts-zh"]);

			await runtime.unloadPlugin("stt");
			await runtime.unloadPlugin("tts");
			expect(enabledSttModels()).toEqual([]);
			expect(enabledTtsModels()).toEqual([]);
		} finally {
			await runtime.dispose();
			await host.dispose();
			resetVoiceEngineActivations();
		}
	}, 30_000);
});
