import { activateCapability } from "../../../extensibility/capability-activation";
import type { PluginAPI } from "../../../extensibility/extensions/types";
import { BrowserTool } from "../../../tools/browser";
import { registerToolProvider } from "../../../tools/tool-ownership";

/**
 * The browser package provides the `browser` tool itself; the `launch` /
 * `attach` / `gui` components decide which backends it may use. Disabling this
 * component removes the tool; disabling a backend keeps the tool but narrows
 * what it can do (the tool reports which backends are unavailable).
 */
export default function launch(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("browser", "launch"), "browser-backend:launch");
	ctx.effect!(
		registerToolProvider("browser", session => new BrowserTool(session)),
		"browser:provide",
	);
}
