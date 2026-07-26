import { compare, valid } from "semver";

/**
 * MusePi v0.2.0+: version checks query the npm registry for the latest
 * published version of @musepi/coding-agent. The GitHub Releases page is
 * still linked for changelogs.
 */
const NPM_LATEST_URL = "https://registry.npmjs.org/@musepi/coding-agent/latest";
export const MUSEPI_RELEASES_URL = "https://github.com/MuseLinn/MusePi/releases";
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

export interface LatestPiRelease {
	version: string;
	/** Browser URL of the GitHub release (for changelogs). */
	url?: string;
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = valid(leftVersion);
	const right = valid(rightVersion);
	return left !== null && right !== null ? compare(left, right) : undefined;
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const cmp = comparePackageVersions(candidateVersion, currentVersion);
	return cmp !== undefined && cmp > 0;
}

function getMusepiUserAgent(version: string): string {
	return `musepi/${version}`;
}

export async function getLatestPiRelease(
	currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<LatestPiRelease | undefined> {
	if (process.env.PI_OFFLINE) return undefined;

	const response = await fetch(NPM_LATEST_URL, {
		headers: {
			"User-Agent": getMusepiUserAgent(currentVersion),
			accept: "application/vnd.npm.install-v1+json",
		},
		signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS),
	});
	if (!response.ok) return undefined;

	const data = (await response.json()) as { version?: unknown };
	if (typeof data.version !== "string" || !data.version) {
		return undefined;
	}
	return { version: data.version, url: MUSEPI_RELEASES_URL };
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
