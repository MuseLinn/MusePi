import { activateCapability } from "../../extensibility/capability-activation";
import type { ExtensionAPI } from "../../extensibility/extensions/types";

export default function launch(pi: ExtensionAPI): void {
	pi.effect!(activateCapability("browser", "launch"), "browser-backend:launch");
}
