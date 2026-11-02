import type { ExtensionAPI } from "../../extensibility/extensions/types";
import { activateTtsEngine } from "../../voice/engine-registry";

export const name = "tts-engine-kokoro";

export default function kokoro(pi: ExtensionAPI): void {
	pi.effect!(activateTtsEngine("kokoro"), "tts-engine:kokoro");
}
