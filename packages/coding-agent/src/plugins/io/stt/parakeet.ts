import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { activateSttEngine } from "@musepi/pi-coding-agent/voice/engine-registry";

export const name = "stt-engine-parakeet";

export default function parakeet(ctx: PluginAPI): void {
	ctx.effect!(activateSttEngine("parakeet"), "stt-engine:parakeet");
}
