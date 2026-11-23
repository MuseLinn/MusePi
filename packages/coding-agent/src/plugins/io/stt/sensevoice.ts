import type { PluginAPI } from "../../../extensibility/extensions/types";
import { activateSttEngine } from "../../../voice/engine-registry";

export const name = "stt-engine-sensevoice";

export default function sensevoice(ctx: PluginAPI): void {
	ctx.effect!(activateSttEngine("sensevoice"), "stt-engine:sensevoice");
}
