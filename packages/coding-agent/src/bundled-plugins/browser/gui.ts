import { activateCapability } from "../../extensibility/capability-activation";
import type { ExtensionAPI } from "../../extensibility/extensions/types";

export default function gui(pi: ExtensionAPI): void {
	pi.effect!(activateCapability("browser", "gui"), "browser-backend:gui");
}
