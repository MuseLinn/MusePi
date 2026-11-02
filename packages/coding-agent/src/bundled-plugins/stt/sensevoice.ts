import type { ExtensionAPI } from "../../extensibility/extensions/types";
import { activateSttEngine } from "../../voice/engine-registry";

export const name = "stt-engine-sensevoice";

export default function sensevoice(pi: ExtensionAPI): void {
	pi.effect!(activateSttEngine("sensevoice"), "stt-engine:sensevoice");
}
