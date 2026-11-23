import type { PluginAPI } from "../../../extensibility/extensions/types";
import { activateSttEngine } from "../../../voice/engine-registry";

export const name = "stt-engine-parakeet";

export default function parakeet(ctx: PluginAPI): void {
	ctx.effect!(activateSttEngine("parakeet"), "stt-engine:parakeet");
}
