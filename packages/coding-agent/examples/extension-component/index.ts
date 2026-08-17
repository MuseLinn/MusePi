/**
 * Example extension: contributes a renderer-side component to the GUI
 * "settings.extensions" slot (the 设置 → 插件 page). The daemon compiles
 * ui/greeting.tsx to self-contained ESM and the GUI dynamically mounts it.
 *
 * Install: copy this directory to ~/.musepi/agent/extensions/extension-component/
 * (or symlink it), then open 设置 → 插件 in the desktop GUI.
 */
import type { ExtensionAPI } from "../../src/extensibility/extensions/types";

export default function (pi: ExtensionAPI): void {
	pi.registerComponent({
		slot: "settings.extensions",
		moduleUrl: "./ui/greeting.tsx",
		label: "Greeting card",
	});
}
