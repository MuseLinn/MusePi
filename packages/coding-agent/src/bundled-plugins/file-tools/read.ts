import { activateCapability } from "../../extensibility/capability-activation";
import type { ExtensionAPI } from "../../extensibility/extensions/types";

export default function read(pi: ExtensionAPI): void {
	pi.effect!(activateCapability("file", "read"), "file-backend:read");
}
