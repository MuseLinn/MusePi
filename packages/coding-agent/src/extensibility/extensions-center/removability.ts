/**
 * Whether an extension-module row is something the user may remove.
 *
 * Removal is a Host-owned fact, not a GUI inference: the listing scans several
 * roots, but only a module directly under a managed `extensions/` root belongs
 * to the user. A bundled unit, a module inside an installed plugin package, or
 * a path configured from elsewhere is not the center's to delete.
 *
 * The GUI must not infer this from path shape: it sees one `extensions.list`
 * payload and cannot tell a bundled path from a user directory on another
 * drive. This module is the single authority both the list and
 * `extensions.remove` call, so a row shown with a trash affordance is exactly
 * a row the Host will remove.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isModuleEntryKind } from "../../capability/extension-module";
import type { Extension } from "./types";

/** Why a module row has no removal affordance. */
export type ExtensionRemoveBlockedReason = "builtin" | "bundled" | "unmanaged-path";

export interface ExtensionRemovalFacts {
	readonly removable: boolean;
	readonly removeBlockedReason?: ExtensionRemoveBlockedReason;
}

/** The roots whose direct children are user-managed extension entries. */
export function managedExtensionRoots(opts: { userAgentDir: string; cwd: string }): string[] {
	return [path.resolve(opts.userAgentDir, "extensions"), path.resolve(opts.cwd, ".musepi", "extensions")];
}

/** The owner root and the entry's top-level segment, or null when unmanaged. */
interface ManagedEntry {
	readonly root: string;
	readonly entry: string;
}

function managedEntry(extensionPath: string, roots: readonly string[]): ManagedEntry | null {
	const absolute = path.resolve(extensionPath);
	for (const root of roots) {
		const relative = path.relative(root, absolute);
		if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) continue;
		const [entry] = relative.split(path.sep);
		// `entry` cannot be `.`/`..` here because `path.relative` would have
		// started with `..`; reject empty segments left by a doubled separator.
		if (!entry || entry === "." || entry === "..") continue;
		return { root, entry };
	}
	return null;
}

/**
 * Host facts for one extension list row. Non-module kinds (skills, MCP rows,
 * prompt packs) are not removable here; their own surfaces own deletion.
 */
export function extensionRemovalFacts(ext: Extension, roots: readonly string[]): ExtensionRemovalFacts {
	if (!isModuleEntryKind(ext.kind)) return { removable: false };
	if (ext.builtin) return { removable: false, removeBlockedReason: "builtin" };
	// A bundled package ships with the client. Its `level` is `native` precisely
	// so the management face does not pretend it is user-owned.
	if (ext.source.level === "native") return { removable: false, removeBlockedReason: "bundled" };
	if (managedEntry(ext.path, roots) === null) return { removable: false, removeBlockedReason: "unmanaged-path" };
	return { removable: true };
}

/**
 * The filesystem target `extensions.remove` deletes, or null when the row is
 * not removable. A directory entry removes the whole directory (the package's
 * supporting modules live beside the entry file); a top-level file removes
 * that file alone.
 */
export function extensionRemovalTarget(ext: Extension, roots: readonly string[]): string | null {
	if (!extensionRemovalFacts(ext, roots).removable) return null;
	const owned = managedEntry(ext.path, roots);
	return owned === null ? null : path.join(owned.root, owned.entry);
}

/** Delete a validated managed entry. Symlinks are unlinked, never followed. */
export async function removeManagedExtension(target: string): Promise<void> {
	const stat = await fs.promises.lstat(target);
	if (stat.isSymbolicLink()) {
		await fs.promises.unlink(target);
		return;
	}
	if (stat.isDirectory()) {
		await fs.promises.rm(target, { recursive: true, force: false });
		return;
	}
	await fs.promises.rm(target, { force: false });
}
