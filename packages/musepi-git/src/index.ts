import type { ExtensionAPI } from "@musepi/pi-coding-agent";
import registerGitCommand from "./git-command.ts";

/**
 * musepi-git — first-party plugin entry point.
 *
 * Loaded through the legacy Pi compat loader (`loadLegacyPiModule`), so the
 * module shape is a default-exported function receiving the extension API —
 * not a cordis `Plugin.Object`, which is the shape builtin units use.
 *
 * Deliberately multi-file: the entry wires modules together and does nothing
 * else, so the install → load → submodule-HMR path has a real consumer instead
 * of only being exercised by fixtures.
 */
export default function activate(pi: ExtensionAPI): void {
	registerGitCommand(pi);
}
