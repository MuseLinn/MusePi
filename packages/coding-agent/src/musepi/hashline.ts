// ============================================================
// MusePi hashline — host-side glue.
//
// The engine (parser/applier/recovery/SnapshotStore) lives in
// @musepi/core/hashline with zero pi imports. This module owns the
// per-session shared state the read/grep/edit tools must see: one
// SnapshotStore that mints and resolves [path#TAG] anchors, plus the
// resolved feature flags. AgentSession creates the context once per
// session (the store must survive _buildRuntime rebuilds so tags
// minted before a model switch stay resolvable) and hands it to the
// tool definitions through ToolsOptions.hashline.
// ============================================================

import type { ResolvedMusepiSettings } from "@musepi/core";
import type { HashlineFs } from "@musepi/core/hashline/index.js";
import { HashlineEngine, SnapshotStore } from "@musepi/core/hashline/index.js";

export interface HashlineContext {
	readonly store: SnapshotStore;
	readonly enforceSeenLines: boolean;
	/** Build an engine bound to this session's store and the caller's fs seam. */
	createEngine(fs: HashlineFs, resolvePath: (path: string) => string): HashlineEngine;
}

/**
 * Returns undefined when hashline is disabled — tools then take the
 * pi-native path with zero behavior change.
 */
export function createHashlineContext(settings: ResolvedMusepiSettings): HashlineContext | undefined {
	if (!settings.edit.hashline) return undefined;
	const store = new SnapshotStore();
	const enforceSeenLines = settings.edit.enforceSeenLines;
	return {
		store,
		enforceSeenLines,
		createEngine: (fs, resolvePath) => new HashlineEngine({ fs, store, resolvePath, enforceSeenLines }),
	};
}
