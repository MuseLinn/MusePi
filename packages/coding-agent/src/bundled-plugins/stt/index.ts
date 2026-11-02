import type { ExtensionAPI } from "../../extensibility/extensions/types";

export const name = "musepi-stt";
export const inject = [] as const;
export const provide = [] as const;

export function apply(pi: ExtensionAPI): void {
	stt(pi);
}

export default function stt(pi: ExtensionAPI): void {
	pi.setLabel("语音输入（STT）");
}
