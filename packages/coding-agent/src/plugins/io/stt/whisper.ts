import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { activateSttEngine } from "@musepi/pi-coding-agent/voice/engine-registry";

export const name = "stt-engine-whisper";

export default function whisper(ctx: PluginAPI): void {
	ctx.effect!(activateSttEngine("whisper"), "stt-engine:whisper");
}
