import { activateCapability } from "../../extensibility/capability-activation";
import type { ExtensionAPI } from "../../extensibility/extensions/types";

export default function indexBackend(ctx: ExtensionAPI): void {
	ctx.effect!(activateCapability("file", "index"), "file-backend:index");
}
