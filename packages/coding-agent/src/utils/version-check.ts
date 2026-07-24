import { compare, valid } from "semver";

/**
 * MusePi fork: update checks run against the fork's own GitHub Releases
 * (MuseLinn/MusePi), not the dormant upstream pi.dev endpoint. The latest
 * release tag (`vX.Y.Z`) is compared against the running VERSION.
 */
const GITHUB_LATEST_RELEASE_URL = "https://api.github.com/repos/MuseLinn/MusePi/releases/latest";
export const MUSEPI_RELEASES_URL = "https://github.com/MuseLinn/MusePi/releases";
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

export interface LatestPiReleaseAsset {
	name: string;
	/** Direct download URL (browser_download_url). */
	url: string;
}

export interface LatestPiRelease {
	version: string;
	/** Browser URL of the GitHub release (falls back to the releases page). */
	url?: string;
	/** Downloadable assets attached to the release (used by the binary self-update). */
	assets?: LatestPiReleaseAsset[];
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = valid(leftVersion.trim());
	const right = valid(rightVersion.trim());
	if (!left || !right) {
		return undefined;
	}
	return compare(left, right);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

/** Strip an optional leading "v"/"V" from a git release tag. */
export function versionFromReleaseTag(tag: string): string | undefined {
	const version = tag.trim().replace(/^[vV]/, "");
	return valid(version) ? version : undefined;
}

function getMusepiUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `musepi/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}

export async function getLatestPiRelease(
	currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<LatestPiRelease | undefined> {
	if (process.env.PI_OFFLINE) return undefined;

	const response = await fetch(GITHUB_LATEST_RELEASE_URL, {
		headers: {
			"User-Agent": getMusepiUserAgent(currentVersion),
			accept: "application/vnd.github+json",
		},
		signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS),
	});
	if (!response.ok) return undefined;

	const data = (await response.json()) as {
		tag_name?: unknown;
		html_url?: unknown;
		assets?: unknown;
	};
	if (typeof data.tag_name !== "string") {
		return undefined;
	}
	const version = versionFromReleaseTag(data.tag_name);
	if (!version) {
		return undefined;
	}
	const url = typeof data.html_url === "string" && data.html_url.trim() ? data.html_url.trim() : undefined;
	const assets: LatestPiReleaseAsset[] = [];
	if (Array.isArray(data.assets)) {
		for (const asset of data.assets) {
			if (typeof asset !== "object" || asset === null) continue;
			const { name, browser_download_url } = asset as { name?: unknown; browser_download_url?: unknown };
			if (
				typeof name === "string" &&
				name.trim() &&
				typeof browser_download_url === "string" &&
				browser_download_url.trim()
			) {
				assets.push({ name: name.trim(), url: browser_download_url.trim() });
			}
		}
	}
	return { version, ...(url ? { url } : {}), ...(assets.length > 0 ? { assets } : {}) };
}

export async function getLatestPiVersion(
	currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<string | undefined> {
	return (await getLatestPiRelease(currentVersion, options))?.version;
}

export async function checkForNewPiVersion(currentVersion: string): Promise<LatestPiRelease | undefined> {
	if (process.env.PI_SKIP_VERSION_CHECK) return undefined;

	try {
		const latestRelease = await getLatestPiRelease(currentVersion);
		if (latestRelease && isNewerPackageVersion(latestRelease.version, currentVersion)) {
			return latestRelease;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
