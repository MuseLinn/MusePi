import { activateCapability } from "../../extensibility/capability-activation";
import type { ExtensionAPI } from "../../extensibility/extensions/types";

export default function search(ctx: ExtensionAPI): void {
	ctx.effect!(activateCapability("file", "search"), "file-backend:search");
}
