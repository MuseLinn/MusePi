/**
 * Update-state version comparison shared by the marketplace catalog view
 * (`list-entries`) and the upgrade planner (`MarketplaceManager.checkForUpdates`).
 *
 * Both surfaces must agree on what "newer" means: a card that says
 * "update available" has to be a card `marketplace.upgrade` will actually
 * move. Semver ordering comes from Bun; tags that are not valid semver
 * (git SHAs, date stamps, free-form channel names) fall back to plain
 * inequality so a changed tag still surfaces as an update.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
	if (candidate === current) return false;
	try {
		return Bun.semver.order(candidate, current) > 0;
	} catch {
		return true;
	}
}
