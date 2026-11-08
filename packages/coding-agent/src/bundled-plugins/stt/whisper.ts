import type { ExtensionAPI } from "../../extensibility/extensions/types";
import { activateSttEngine } from "../../voice/engine-registry";

export const name = "stt-engine-whisper";

export default function whisper(ctx: ExtensionAPI): void {
	ctx.effect!(activateSttEngine("whisper"), "stt-engine:whisper");
}
