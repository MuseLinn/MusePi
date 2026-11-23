import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";

export default function indexBackend(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("file", "index"), "file-backend:index");
}
