import type { ExtensionAPI } from "../../extensibility/extensions/types";

export const name = "musepi-desktop-shell";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: ExtensionAPI): void {
	desktopShell(ctx);
}

function desktopShell(ctx: ExtensionAPI): void {
	ctx.setLabel("MusePi 桌面壳");
}
