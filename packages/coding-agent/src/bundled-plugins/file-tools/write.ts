import { activateCapability } from "../../extensibility/capability-activation";
import type { ExtensionAPI } from "../../extensibility/extensions/types";

export default function write(pi: ExtensionAPI): void {
	pi.effect!(activateCapability("file", "write"), "file-backend:write");
}
