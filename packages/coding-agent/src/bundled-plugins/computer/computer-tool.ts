import { activateCapability } from "../../extensibility/capability-activation";
import type { ExtensionAPI } from "../../extensibility/extensions/types";

export default function computerTool(pi: ExtensionAPI): void {
	pi.effect!(activateCapability("tool", "computer"), "tool:computer");
}
