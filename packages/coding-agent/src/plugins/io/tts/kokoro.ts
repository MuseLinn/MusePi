import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { activateTtsEngine } from "@musepi/pi-coding-agent/voice/engine-registry";

export const name = "tts-engine-kokoro";

export default function kokoro(ctx: PluginAPI): void {
	ctx.effect!(activateTtsEngine("kokoro"), "tts-engine:kokoro");
}
