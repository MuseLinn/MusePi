import type { ExtensionAPI } from "../../extensibility/extensions/types";

export const name = "musepi-tts";
export const inject = [] as const;
export const provide = [] as const;

export function apply(pi: ExtensionAPI): void {
	tts(pi);
}

export default function tts(pi: ExtensionAPI): void {
	pi.setLabel("语音输出（TTS）");
}
