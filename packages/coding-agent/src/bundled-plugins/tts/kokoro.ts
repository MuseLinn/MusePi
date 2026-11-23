import type { PluginAPI } from "../../extensibility/extensions/types";
import { activateTtsEngine } from "../../voice/engine-registry";

export const name = "tts-engine-kokoro";

export default function kokoro(ctx: PluginAPI): void {
	ctx.effect!(activateTtsEngine("kokoro"), "tts-engine:kokoro");
}
