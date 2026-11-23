import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";

export const name = "musepi-desktop-shell";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: PluginAPI): void {
	desktopShell(ctx);
}

function desktopShell(ctx: PluginAPI): void {}
