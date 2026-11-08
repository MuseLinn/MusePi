/**
 * Cwds to preload extension presets for at daemon startup.
 *
 * A preset declared by an extension is host-level (dsh), so the daemon warms
 * every known workspace — not only its own cwd — before the first session.
 * The primary cwd comes first; workspaces and their additional roots follow,
 * deduplicated (the same folder can be a primary root and another project's
 * additional directory).
 */
export interface PresetPreloadWorkspace {
	readonly root: string;
	readonly additionalDirs?: readonly string[];
}

export function presetPreloadCwds(primary: string, workspaces: readonly PresetPreloadWorkspace[]): string[] {
	const cwds = new Set<string>([primary]);
	for (const workspace of workspaces) {
		cwds.add(workspace.root);
		for (const directory of workspace.additionalDirs ?? []) cwds.add(directory);
	}
	return [...cwds];
}
