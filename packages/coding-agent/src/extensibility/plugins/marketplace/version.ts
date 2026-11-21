/**
 * Version comparison and discovery shared by the marketplace catalog view
 * (`list-entries`), the detail dialog's version list, and the upgrade planner
 * (`MarketplaceManager.checkForUpdates` / `upgradePlugin`).
 *
 * All of them must agree on what "newer" means: a version the UI offers has to
 * be one the installer will actually fetch, and a downgrade must be refused.
 * Semver ordering comes from Bun; tags that are not valid semver (git SHAs,
 * date stamps, free-form channel names) fall back to plain inequality so a
 * changed tag still surfaces as an update.
 */
import { logger } from "@musepi/pi-utils";
import * as git from "../../../utils/git";

export function isNewerVersion(candidate: string, current: string): boolean {
	if (candidate === current) return false;
	try {
		return Bun.semver.order(candidate, current) > 0;
	} catch {
		return true;
	}
}

// ── Available versions ────────────────────────────────────────────────────

/**
 * One selectable version: the label the UI shows, and the Git ref that
 * delivers it. They differ for the common `v1.2.3` tag, which installs as
 * version `1.2.3` — the same form a catalog or plugin manifest declares.
 * `ref` is empty for a version that only the catalog or the installed registry
 * names: it is listed so the UI can explain the ends of the range, but no tag
 * publishes it.
 */
export interface PluginVersionRef {
	version: string;
	ref: string;
}

const TAG_LIST_TIMEOUT_MS = 12_000;

/** `v1.2.3` → `1.2.3`; other tags (`build-42`) keep their name. */
export function normalizeVersionLabel(tag: string): string {
	const trimmed = tag.trim();
	return /^v\d/i.test(trimmed) ? trimmed.slice(1) : trimmed;
}

/** Newest first. Semver when both sides parse, numeric-aware text otherwise. */
export function compareVersionsDescending(left: string, right: string): number {
	try {
		const order = Bun.semver.order(left, right);
		if (order !== 0) return -order;
	} catch {
		// Not semver on both sides — fall through to text ordering.
	}
	return right.localeCompare(left, undefined, { numeric: true });
}

export function sortVersionsDescending(versions: readonly string[]): string[] {
	return [...versions].sort(compareVersionsDescending);
}

export function sortVersionRefs(refs: readonly PluginVersionRef[]): PluginVersionRef[] {
	return [...refs].sort((left, right) => compareVersionsDescending(left.version, right.version));
}

/**
 * Versions a repository publishes: its tags.
 *
 * MusePi catalogs name one version per plugin and npm sources are unsupported,
 * so the repository's tags are the only place an older-but-real version can
 * come from — a version the UI offers has to be one the installer can actually
 * fetch. A repository with no tags (or one that is not a Git repository, or is
 * offline) yields no versions; callers fall back to the catalog version, which
 * keeps the single-version install path unchanged.
 */
export async function listRemotePluginVersions(
	repo: string,
	timeoutMs = TAG_LIST_TIMEOUT_MS,
): Promise<PluginVersionRef[]> {
	try {
		return sortVersionRefs(versionRefsFromTags(await git.remote.lsTags(repo, { timeoutMs })));
	} catch (err) {
		logger.debug("Listing plugin repository tags failed", { repo, error: String(err) });
		return [];
	}
}

function versionRefsFromTags(tags: readonly string[]): PluginVersionRef[] {
	const seen = new Map<string, PluginVersionRef>();
	for (const tag of tags) {
		const version = normalizeVersionLabel(tag);
		// `v1.0.0` and `1.0.0` are one version; `ls-remote` lists refs by name,
		// so the unprefixed tag wins and the prefixed alias is dropped.
		if (version.length > 0 && !seen.has(version)) seen.set(version, { version, ref: tag });
	}
	return [...seen.values()];
}
