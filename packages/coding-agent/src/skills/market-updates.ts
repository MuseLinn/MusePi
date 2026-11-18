/**
 * Skill update check (SkillHub + skills.sh + plain git installs).
 *
 * The plugin marketplace compares registry versions; a skill has no registry
 * entry, so it compares the facts its install recorded (`.musepi-skill.json`):
 *
 * - SkillHub publishes `latestVersion` in its detail payload → version compare;
 * - skills.sh and plain git installs are moving commits → `git ls-remote HEAD`
 *   compare (the installed commit is recorded at install time).
 *
 * Everything is best-effort per skill: an unreachable source yields
 * `updateAvailable: null` plus a failure line, never an exception across the
 * RPC boundary. Nothing here writes or installs.
 */
import { isNewerVersion } from "../extensibility/plugins/marketplace/version";
import type { SkillMarketEntry } from "./marketplace-client";
import type { SkillSourceRecord } from "./skill-source";

export interface SkillUpdateInput {
	name: string;
	market?: SkillSourceRecord | null;
}

/** One catalog that also publishes this skill, so the user can pick a source. */
export interface SkillUpdateCandidate {
	source: "skillhub" | "skills.sh";
	slug: string;
	repo?: string;
	name?: string;
	latestVersion?: string;
	/** This candidate is the source the installed copy came from. */
	current: boolean;
}

export interface SkillUpdateStatus {
	name: string;
	source: SkillSourceRecord["source"];
	installedVersion?: string;
	installedCommit?: string;
	latestVersion?: string;
	latestCommit?: string;
	/** true = newer available, false = current, null = not comparable. */
	updateAvailable: boolean | null;
	/** Other catalogs publishing the same skill (same name or slug). */
	alternatives?: SkillUpdateCandidate[];
	checkedAt: number;
	error?: string;
}

export type LatestSkillLookup = (record: SkillSourceRecord) => Promise<{ version?: string; commit?: string } | null>;

export type AlternativesLookup = (record: SkillSourceRecord, skillName: string) => Promise<SkillUpdateCandidate[]>;

const GIT_TIMEOUT_MS = 12_000;

/** First token of `git ls-remote <url> HEAD`; null when git fails or times out. */
export async function lsRemoteHead(url: string, timeoutMs = GIT_TIMEOUT_MS): Promise<string | null> {
	let proc: ReturnType<typeof Bun.spawn> | undefined;
	const timer = setTimeout(() => proc?.kill(), timeoutMs);
	try {
		proc = Bun.spawn(["git", "ls-remote", url, "HEAD"], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const exitCode = await proc.exited;
		if (exitCode !== 0) return null;
		const text = await new Response(proc.stdout as ReadableStream).text();
		const commit = text.trim().split(/\s+/)[0];
		return commit && /^[0-9a-f]{7,40}$/i.test(commit) ? commit : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** Default latest-version source. Exported so tests can swap it. */
export const defaultLatestLookup: LatestSkillLookup = async record => {
	if (record.source === "skillhub") {
		if (!record.slug) return null;
		const { skillHubDetail } = await import("./marketplace-client");
		const detail = await skillHubDetail(record.slug);
		return detail ? { version: detail.latestVersion } : null;
	}
	const url = record.url ?? (record.repo ? `https://github.com/${record.repo}.git` : undefined);
	if (!url) return null;
	const commit = await lsRemoteHead(url);
	return commit ? { commit } : null;
};

/** Exact name/slug matches from both catalogs, recorded source marked. */
export function matchSkillAlternatives(
	entries: readonly SkillMarketEntry[],
	record: SkillSourceRecord,
	skillName: string,
): SkillUpdateCandidate[] {
	const wanted = new Set(
		[skillName.trim().toLowerCase(), record.slug?.trim().toLowerCase()].filter((v): v is string => Boolean(v)),
	);
	const seen = new Set<string>();
	const out: SkillUpdateCandidate[] = [];
	for (const entry of entries) {
		const name = entry.name.trim().toLowerCase();
		const slug = entry.slug.trim().toLowerCase();
		if (!wanted.has(name) && !wanted.has(slug)) continue;
		const key = `${entry.source}:${entry.slug}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({
			source: entry.source,
			slug: entry.slug,
			...(entry.repo ? { repo: entry.repo } : {}),
			name: entry.name,
			...(entry.version ? { latestVersion: entry.version } : {}),
			current: entry.source === record.source && entry.slug === record.slug,
		});
	}
	return out.sort((a, b) => Number(b.current) - Number(a.current));
}

/** Catalog membership changes slowly; a 10-minute cache keeps a list refresh
 *  from spending two searches per installed skill every time. */
const ALTERNATIVES_TTL_MS = 10 * 60_000;
const alternativesCache = new Map<string, { at: number; value: SkillUpdateCandidate[] }>();

/** Default alternatives lookup: search both catalogs by the installed name. */
export const defaultAlternativesLookup: AlternativesLookup = async (record, skillName) => {
	const cacheKey = `${record.source}:${record.slug ?? ""}:${skillName.toLowerCase()}`;
	const cached = alternativesCache.get(cacheKey);
	if (cached && Date.now() - cached.at < ALTERNATIVES_TTL_MS) return cached.value;
	const { searchSkillHub, searchSkillsSh } = await import("./marketplace-client");
	const [hub, sh] = await Promise.all([
		searchSkillHub({ keyword: skillName, pageSize: 20 })
			.then(result => result.entries)
			.catch(() => [] as SkillMarketEntry[]),
		searchSkillsSh(skillName, 20).catch(() => [] as SkillMarketEntry[]),
	]);
	const value = matchSkillAlternatives([...hub, ...sh], record, skillName);
	alternativesCache.set(cacheKey, { at: Date.now(), value });
	return value;
};

/** Compare one install against its source's latest facts. */
export function compareSkillUpdate(
	record: SkillSourceRecord,
	latest: { version?: string; commit?: string } | null,
): boolean | null {
	if (!latest) return null;
	if (record.version && latest.version) return isNewerVersion(latest.version, record.version);
	if (record.commit && latest.commit) return record.commit !== latest.commit;
	return null;
}

export async function checkSkillUpdates(
	items: readonly SkillUpdateInput[],
	lookup: LatestSkillLookup = defaultLatestLookup,
	alternatives: AlternativesLookup = defaultAlternativesLookup,
): Promise<{ updates: SkillUpdateStatus[]; failures: string[] }> {
	const updates: SkillUpdateStatus[] = [];
	const failures: string[] = [];
	const checkedAt = Date.now();
	await Promise.all(
		items.map(async item => {
			const record = item.market;
			if (!record) return;
			let latest: { version?: string; commit?: string } | null = null;
			let error: string | undefined;
			let candidates: SkillUpdateCandidate[] = [];
			try {
				[latest, candidates] = await Promise.all([
					lookup(record),
					alternatives(record, item.name).catch(() => [] as SkillUpdateCandidate[]),
				]);
				if (!latest) error = "source unreachable or has no comparable version";
			} catch (err: unknown) {
				error = err instanceof Error ? err.message : String(err);
			}
			const status: SkillUpdateStatus = {
				name: item.name,
				source: record.source,
				installedVersion: record.version,
				installedCommit: record.commit,
				latestVersion: latest?.version,
				latestCommit: latest?.commit,
				updateAvailable: compareSkillUpdate(record, latest),
				...(candidates.length > 0 ? { alternatives: candidates } : {}),
				checkedAt,
				...(error ? { error } : {}),
			};
			updates.push(status);
			if (error) failures.push(`${item.name}: ${error}`);
		}),
	);
	return { updates, failures };
}
