/**
 * Whether a registered tool belongs in one session's slate.
 *
 * Extension-registered tools used to bypass both gates: `tools.disabled` only
 * reached built-in factories, and the per-tool `enabled` predicate did not
 * exist. That was invisible while every presentation tool was a built-in, and
 * wrong the moment `widget` moved to a builtin plugin — it would have ignored
 * the switch that turns it off and the presets that deny it.
 *
 * The rule is shared by every registered tool (bundled or user), so a plugin
 * cannot accidentally opt out of the user's denylist.
 */
import type { RegisteredTool, ToolEnablementSettings } from "../extensibility/extensions/types";

/** True when the session should offer this registered tool. */
export function isRegisteredToolEnabled(tool: RegisteredTool, settings: ToolEnablementSettings): boolean {
	const disabled = settings.get("tools.disabled");
	if (Array.isArray(disabled) && disabled.includes(tool.definition.name)) return false;
	return tool.definition.enabled?.({ settings }) !== false;
}
