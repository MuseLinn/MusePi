import type { ExtensionAPI } from "../../extensibility/extensions/types";

export const name = "musepi-desktop-shell";
export const inject = [] as const;
export const provide = [] as const;

export function apply(pi: ExtensionAPI): void {
	desktopShell(pi);
}

export default function desktopShell(pi: ExtensionAPI): void {
	pi.setLabel("MusePi 桌面壳");
}
