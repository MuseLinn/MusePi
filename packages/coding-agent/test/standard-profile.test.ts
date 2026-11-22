import { expect, test } from "bun:test";
import { STANDARD_TOP_LEVEL_TOOL_NAMES } from "@musepi/pi-coding-agent/presets/standard-profile";
import { ESSENTIAL_BUILTIN_TOOL_NAMES } from "@musepi/pi-coding-agent/tools/essential-tools";
import { XDEV_KEEP_TOP_LEVEL } from "@musepi/pi-coding-agent/tools/xdev";

/**
 * The standard work surface is one reviewable list. It must stay equal to the
 * registries it mirrors, otherwise a new essential tool silently drops out of
 * the top-level schema for the default profile.
 */
test("the declared standard surface matches essentials plus the xdev keep list", () => {
	const expected = new Set([...Object.keys(ESSENTIAL_BUILTIN_TOOL_NAMES), ...Object.keys(XDEV_KEEP_TOP_LEVEL)]);
	expect(new Set(STANDARD_TOP_LEVEL_TOOL_NAMES)).toEqual(expected);
});
