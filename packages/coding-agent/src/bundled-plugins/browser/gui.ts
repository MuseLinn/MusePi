import { activateCapability } from "../../extensibility/capability-activation";
import type { ExtensionAPI } from "../../extensibility/extensions/types";

export default function gui(ctx: ExtensionAPI): void {
	ctx.effect!(activateCapability("browser", "gui"), "browser-backend:gui");
}
