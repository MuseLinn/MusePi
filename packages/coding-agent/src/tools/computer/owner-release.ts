/** Releases whatever a computer owner still holds when its session ends. */
type OwnerRelease = () => void | Promise<void>;

const owned = new Map<string, Set<OwnerRelease>>();

/** Registers one owner-scoped release; the returned removal runs synchronously
 *  and does not perform the release itself. */
export function registerOwnerRelease(ownerId: string | undefined, release: OwnerRelease): () => void {
	if (!ownerId) return () => {};
	const releases = owned.get(ownerId) ?? new Set<OwnerRelease>();
	releases.add(release);
	owned.set(ownerId, releases);
	return () => {
		releases.delete(release);
		if (releases.size === 0) owned.delete(ownerId);
	};
}

/** Runs every release the owner still holds; one failure does not block the rest. */
export async function releaseOwnerResources(ownerId: string | undefined): Promise<void> {
	if (!ownerId) return;
	const releases = owned.get(ownerId);
	if (!releases) return;
	owned.delete(ownerId);
	await Promise.allSettled(Array.from(releases, release => release()));
}
