import { activateCapability } from "../../extensibility/capability-activation";
import type { ExtensionAPI } from "../../extensibility/extensions/types";

export default function write(ctx: ExtensionAPI): void {
	ctx.effect!(activateCapability("file", "write"), "file-backend:write");
}
