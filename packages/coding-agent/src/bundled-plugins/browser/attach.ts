import { activateCapability } from "../../extensibility/capability-activation";
import type { ExtensionAPI } from "../../extensibility/extensions/types";

export default function attach(pi: ExtensionAPI): void {
	pi.effect!(activateCapability("browser", "attach"), "browser-backend:attach");
}
