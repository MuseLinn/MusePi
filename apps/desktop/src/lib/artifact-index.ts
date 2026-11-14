import { useCallback, useEffect, useState } from "react";
import type { ArtifactRow } from "../components/ArtifactsPanel";
import type { RpcClient } from "./rpc";

/**
 * The workspace's artifact manifests, indexed for the file pane.
 *
 * The artifacts panel owns the discovery UI; the file pane needs the same scan
 * to answer a different question about the same files: "is the file I am about
 * to preview part of a declared artifact, and what does its manifest say". Both
 * surfaces read the one daemon scan (`artifact.list`), which is also where the
 * manifest validation lives — the GUI never re-guesses the manifest shape.
 *
 * The index is keyed by the manifest's directory with a `/`-separated relative
 * path, matching what the daemon reports, so a file's path resolves against it
 * without a second normalization rule.
 *
 * A failed scan is reported as an empty index rather than an error: the file
 * pane previews files with or without manifests, and a scan that could not run
 * must not take the pane's primary purpose down with it. The artifacts panel,
 * whose whole subject is the scan, surfaces its own failure there.
 */
export function useArtifactIndex(
	rpc: RpcClient | null,
	cwd: string,
): {
	/** Manifest directory → artifact. Empty when the scan failed or found none. */
	byDir: Map<string, ArtifactRow>;
	loading: boolean;
} {
	const [artifacts, setArtifacts] = useState<ArtifactRow[]>([]);
	const [loading, setLoading] = useState(false);

	const reload = useCallback(() => {
		if (!rpc || !cwd) return;
		setLoading(true);
		rpc.request<{ artifacts: ArtifactRow[] }>("artifact.list", { cwd })
			.then(res => {
				setArtifacts(res?.artifacts ?? []);
				setLoading(false);
			})
			.catch(() => {
				setArtifacts([]);
				setLoading(false);
			});
	}, [rpc, cwd]);

	useEffect(() => {
		reload();
	}, [reload]);

	const byDir = new Map<string, ArtifactRow>();
	for (const artifact of artifacts) byDir.set(artifact.dir, artifact);
	return { byDir, loading };
}

/**
 * Find the artifact a file belongs to, if any.
 *
 * A file is part of an artifact when it sits inside the manifest's directory —
 * which includes the entry file itself and any asset the entry references. The
 * walk checks each ancestor from the file upward, so a file three levels under
 * the manifest still resolves.
 *
 * @param filePath - the file's workspace-relative path (`/`-separated).
 * @param byDir - the index from {@link useArtifactIndex}.
 * @returns the owning artifact, or `undefined` when the file is outside every
 * manifest directory.
 */
export function owningArtifact(filePath: string, byDir: Map<string, ArtifactRow>): ArtifactRow | undefined {
	const normalized = filePath.replace(/\\/g, "/");
	let current = normalized;
	for (;;) {
		const hit = byDir.get(current);
		if (hit) return hit;
		const cut = current.lastIndexOf("/");
		if (cut === -1) return undefined;
		current = current.slice(0, cut);
	}
}
