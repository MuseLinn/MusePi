import { activateCapability } from "../../extensibility/capability-activation";
import type { ExtensionAPI } from "../../extensibility/extensions/types";

export default function read(ctx: ExtensionAPI): void {
	ctx.effect!(activateCapability("file", "read"), "file-backend:read");
}
