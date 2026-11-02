import type { ExtensionAPI } from "../../extensibility/extensions/types";
import { activateSttEngine } from "../../voice/engine-registry";

export const name = "stt-engine-parakeet";

export default function parakeet(pi: ExtensionAPI): void {
	pi.effect!(activateSttEngine("parakeet"), "stt-engine:parakeet");
}
