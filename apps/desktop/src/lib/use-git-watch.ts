import { useEffect, useRef } from "react";
import type { RpcClient } from "./rpc";

/**
 * Subscribe the daemon's git-dir watcher for the roots a surface displays.
 *
 * Two surfaces may watch the same root; the daemon refcounts per connection, so
 * unmounting one does not stop the other. The diff against the previous set
 * keeps the RPC traffic to actual additions/removals.
 */
export function useGitWatch(rpc: RpcClient | null, roots: readonly string[]): void {
	const watchedRef = useRef<string[]>([]);
	const rootsKey = roots.filter(root => root.length > 0).join("\n");

	useEffect(() => {
		if (!rpc) return;
		const previous = new Set(watchedRef.current);
		const next = new Set(roots.filter(root => root.length > 0));
		const added = [...next].filter(root => !previous.has(root));
		const removed = [...previous].filter(root => !next.has(root));
		if (added.length > 0) void rpc.request("git.watch", { roots: added }).catch(() => {});
		if (removed.length > 0) void rpc.request("git.unwatch", { roots: removed }).catch(() => {});
		watchedRef.current = [...next];
	}, [rpc, rootsKey]);

	useEffect(
		() => () => {
			const watched = watchedRef.current;
			watchedRef.current = [];
			if (rpc && watched.length > 0) void rpc.request("git.unwatch", { roots: watched }).catch(() => {});
		},
		[rpc],
	);
}
