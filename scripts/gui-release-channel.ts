#!/usr/bin/env bun
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "../packages/utils/src/fs-error.ts";
import {
	compareVersions,
	type ReleaseChannel,
	releaseChannelForVersion,
	updateManifestUrlForVersion,
} from "../packages/utils/src/version.ts";

interface FeedFile {
	url: string;
	sha512: string;
	size: number;
}

interface UpdateFeed {
	version: string;
	files: FeedFile[];
	path: string;
	sha512: string;
	releaseDate: string;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

async function readFeed(filePath: string): Promise<UpdateFeed> {
	return Bun.YAML.parse(await Bun.file(filePath).text()) as UpdateFeed;
}

export async function syncWindowsFeedAssets(
	feed: UpdateFeed,
	distDir: string,
	requireDefault = false,
): Promise<UpdateFeed> {
	const files: FeedFile[] = [];
	for (const file of feed.files) {
		const bytes = await fs.readFile(path.join(distDir, file.url));
		files.push({ ...file, sha512: createHash("sha512").update(bytes).digest("base64"), size: bytes.length });
	}
	const defaultFile = files.find(file => file.url === feed.path);
	if (requireDefault && !defaultFile) throw new Error(`Windows feed default asset is not listed: ${feed.path}`);
	return { ...feed, files, ...(defaultFile ? { sha512: defaultFile.sha512 } : {}) };
}

export async function mergeWindowsFeeds(distDir: string, channel: "latest" | "beta"): Promise<string> {
	const x64Path = path.join(distDir, `${channel}-win-x64.yml`);
	const arm64Path = path.join(distDir, `${channel}-win-arm64.yml`);
	const merged = await syncWindowsFeedAssets(await readFeed(x64Path), distDir, true);
	const releaseChannel: ReleaseChannel = channel === "beta" ? "beta" : "stable";
	if (releaseChannelForVersion(merged.version) !== releaseChannel) {
		throw new Error(`${channel} feed contains ${merged.version}`);
	}
	try {
		const arm64 = await syncWindowsFeedAssets(await readFeed(arm64Path), distDir);
		if (arm64.version !== merged.version) {
			throw new Error(`Windows feed version mismatch: ${merged.version} != ${arm64.version}`);
		}
		const known = new Set(merged.files.map(file => file.url));
		for (const file of arm64.files) {
			if (!known.has(file.url)) merged.files.push(file);
		}
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	const output = path.join(distDir, `${channel}.yml`);
	await Bun.write(output, Bun.YAML.stringify(merged));
	await fs.rm(x64Path);
	await fs.rm(arm64Path, { force: true });
	return output;
}

export function assertChannelPromotion(candidateVersion: string, currentVersion?: string): void {
	const candidate = candidateVersion.replace(/^v/, "");
	const current = currentVersion?.replace(/^v/, "");
	if (releaseChannelForVersion(candidate) !== "beta" || !current) return;
	if (releaseChannelForVersion(current) !== "beta" || compareVersions(candidate, current) <= 0) {
		throw new Error(`Beta rollback: refusing to replace ${current} with ${candidate}`);
	}
}

export async function fetchCurrentChannelVersion(fetchImpl: Fetch = fetch): Promise<string | undefined> {
	const response = await fetchImpl(updateManifestUrlForVersion("0.0.0-beta.1"));
	if (response.status === 404) return undefined;
	if (!response.ok) throw new Error(`Current channel manifest returned ${response.status}`);
	const manifest = (await response.json()) as { version?: unknown };
	if (typeof manifest.version !== "string") throw new Error("Current channel manifest has no version");
	return manifest.version;
}

export async function verifyPublishedManifest(expectedVersion: string, fetchImpl: Fetch = fetch): Promise<void> {
	const response = await fetchImpl(updateManifestUrlForVersion(expectedVersion));
	if (!response.ok) throw new Error(`Published manifest returned ${response.status}`);
	const manifest = (await response.json()) as { version?: unknown };
	if (manifest.version !== expectedVersion) {
		throw new Error(
			`Published manifest version mismatch: expected ${expectedVersion}, got ${String(manifest.version)}`,
		);
	}
}

async function readManifestVersion(filePath: string): Promise<string> {
	const manifest = (await Bun.file(filePath).json()) as { version?: unknown };
	if (typeof manifest.version !== "string") throw new Error(`Manifest has no version: ${filePath}`);
	return manifest.version;
}

async function main(): Promise<void> {
	const [command, ...args] = process.argv.slice(2);
	if (command === "merge-windows") {
		const [distDir, channel] = args;
		if (!distDir || (channel !== "latest" && channel !== "beta")) {
			throw new Error("Usage: merge-windows <dist-dir> <latest|beta>");
		}
		const output = await mergeWindowsFeeds(distDir, channel);
		console.log(`Merged Windows feed: ${output}`);
		return;
	}
	if (command === "check-promotion") {
		const [candidate, currentPath] = args;
		if (!candidate) throw new Error("Usage: check-promotion <version|manifest.json> [current-manifest.json]");
		const candidateVersion = candidate.endsWith(".json") ? await readManifestVersion(candidate) : candidate;
		let currentVersion: string | undefined;
		if (currentPath === "--remote") {
			currentVersion = await fetchCurrentChannelVersion();
		} else if (currentPath) {
			try {
				currentVersion = await readManifestVersion(currentPath);
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
		assertChannelPromotion(candidateVersion, currentVersion);
		console.log(`Channel promotion accepted: ${candidateVersion}${currentVersion ? ` > ${currentVersion}` : ""}`);
		return;
	}
	if (command === "verify-published") {
		const expectedVersion = args[0] ?? (await readManifestVersion("packages/desktop-app/package.json"));
		for (let attempt = 1; attempt <= 5; attempt++) {
			try {
				await verifyPublishedManifest(expectedVersion);
				console.log(`Published manifest verified: ${expectedVersion}`);
				return;
			} catch (error) {
				if (attempt === 5) throw error;
				await Bun.sleep(2000);
			}
		}
	}
	throw new Error("Usage: merge-windows | check-promotion | verify-published");
}

if (import.meta.main) await main();
