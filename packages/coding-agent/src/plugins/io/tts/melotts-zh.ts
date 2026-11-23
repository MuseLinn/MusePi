import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { activateTtsEngine } from "@musepi/pi-coding-agent/voice/engine-registry";

export const name = "tts-engine-melotts-zh";

export default function melottsZh(ctx: PluginAPI): void {
	ctx.effect!(activateTtsEngine("melotts-zh"), "tts-engine:melotts-zh");
}
