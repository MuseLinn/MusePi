import { activateCapability } from "../../extensibility/capability-activation";
import type { ExtensionAPI } from "../../extensibility/extensions/types";

export default function indexBackend(pi: ExtensionAPI): void {
	pi.effect!(activateCapability("file", "index"), "file-backend:index");
}
