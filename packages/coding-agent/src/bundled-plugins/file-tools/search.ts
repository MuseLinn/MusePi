import { activateCapability } from "../../extensibility/capability-activation";
import type { ExtensionAPI } from "../../extensibility/extensions/types";

export default function search(pi: ExtensionAPI): void {
	pi.effect!(activateCapability("file", "search"), "file-backend:search");
}
