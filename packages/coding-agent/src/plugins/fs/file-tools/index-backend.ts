import { activateCapability } from "../../../extensibility/capability-activation";
import type { PluginAPI } from "../../../extensibility/extensions/types";

export default function indexBackend(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("file", "index"), "file-backend:index");
}
