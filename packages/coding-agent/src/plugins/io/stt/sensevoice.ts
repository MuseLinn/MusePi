import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { activateSttEngine } from "@musepi/pi-coding-agent/voice/engine-registry";

export const name = "stt-engine-sensevoice";

export default function sensevoice(ctx: PluginAPI): void {
	ctx.effect!(activateSttEngine("sensevoice"), "stt-engine:sensevoice");
}
