import type { ExtensionAPI } from "../../extensibility/extensions/types";
import { activateTtsEngine } from "../../voice/engine-registry";

export const name = "tts-engine-melotts-zh";

export default function melottsZh(pi: ExtensionAPI): void {
	pi.effect!(activateTtsEngine("melotts-zh"), "tts-engine:melotts-zh");
}
