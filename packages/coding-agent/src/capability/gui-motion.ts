/**
 * GUI Motion Capability
 *
 * CSS motion packs loaded from extension-package `motion/` directories.
 * A pack is one .css file that overrides the standard motion tokens and
 * keyframes (--spring curves, durations, gui-menu-in/out, gui-chip-in, …).
 * Same-name keyframes win by load order, so a pack injected after the
 * built-in stylesheet naturally overrides the defaults — no extra
 * mechanism needed.
 *
 * The GUI renderer reads the file content itself (fs.read on `path`);
 * the daemon only inventories the pack (name/path) so extension scans
 * stay cheap and the 16 KiB extensions.raw cap never truncates a pack.
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * A CSS motion pack.
 */
export interface GuiMotion {
	/** Pack name (file basename without the .css extension) */
	name: string;
	/** Absolute path to the .css file */
	path: string;
	/** Source metadata */
	_source: SourceMeta;
}

export const guiMotionCapability = defineCapability<GuiMotion>({
	id: "gui-motion",
	displayName: "GUI Motion",
	description: "CSS motion packs that override the standard motion tokens and keyframes",
	key: motion => motion.name,
	toExtensionId: motion => `gui-motion:${motion.name}`,
	validate: motion => {
		if (!motion.name) return "Missing name";
		if (!motion.path) return "Missing path";
		return undefined;
	},
});
