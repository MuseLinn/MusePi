/**
 * GitHub topic discovery for plugins.
 *
 * A repository its author tagged `musepi-plugin` is offered in the plugin
 * market without anyone reviewing it first. Only the tag and a
 * `package.json` are read: nothing is fetched for install, and nothing is
 * executed. The tag is a claim by the author, so every entry carries
 * `reviewed: false` and the market shows it apart from the curated list.
 *
 * Mirrors magpie's `internal/plugin/github.go`: one search over the topic,
 * then each repository's `package.json` from its default branch, with one
 * repository's failure never emptying the list.
 */
import { logger } from "@musepi/pi-utils";

/** The GitHub topic that puts a repository in the plugin market. */
export const PLUGIN_TOPIC = "musepi-plugin";

const GITHUB_API = "https://api.github.com";
const SEARCH_TIMEOUT_MS = 20_000;
const REPO_TIMEOUT_MS = 10_000;
/** GitHub's search answers at most 1000 results; one page is plenty here. */
const PAGE_SIZE = 100;
const MAX_REPOS = 200;
/** Concurrent `package.json` reads. */
const AT_ONCE = 6;

export interface DiscoveredPlugin {
	/** `owner/repo`, the identity the market installs by. */
	repo: string;
	/** The package's own name from its package.json, when it has one. */
	name: string;
	description?: string;
	version?: string;
	icon?: string;
	homepage?: string;
	license?: string;
	stars: number;
	/** Always false: nobody reviewed a tagged repository. */
	reviewed: false;
	/** The package's own words, shown as such and never as review. */
	summary?: Record<string, string>;
	/** What the repository adds, per its package.json: "agent", "middleware"… */
	kind?: string;
}

export interface TopicDiscoveryResult {
	plugins: DiscoveredPlugin[];
	/** Repositories whose package.json could not be read, and why. */
	failures: string[];
}

interface SearchItem {
	full_name: string;
	html_url: string;
	description?: string | null;
	stargazers_count?: number;
	pushed_at?: string;
	license?: { spdx_id?: string | null } | null;
	owner?: { login?: string };
	archived?: boolean;
	fork?: boolean;
	default_branch?: string;
}

interface RepoPackage {
	name?: unknown;
	version?: unknown;
	description?: unknown;
	homepage?: unknown;
	license?: unknown;
	keywords?: unknown;
	magpie?: { icon?: unknown; summary?: unknown; agent?: unknown; middleware?: unknown };
	musepi?: { icon?: unknown; summary?: unknown; label?: unknown; description?: unknown };
}

function authHeaders(): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"User-Agent": "musepi-plugin-discovery",
	};
	const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	if (token) headers.Authorization = `Bearer ${token}`;
	return headers;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A repository's `package.json`, or undefined when it has none to offer. */
async function readPackageJson(
	repo: string,
	branch: string,
	signal: AbortSignal,
	doFetch: typeof fetch,
): Promise<RepoPackage | undefined> {
	const url = `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(branch)}/package.json`;
	const response = await doFetch(url, { headers: authHeaders(), signal });
	if (!response.ok) return undefined;
	try {
		const parsed = (await response.json()) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as RepoPackage) : undefined;
	} catch {
		return undefined;
	}
}

/** What a package adds, in the market's own words. */
function kindOf(pkg: RepoPackage): string | undefined {
	const magpie = pkg.magpie;
	if (magpie && typeof magpie === "object") {
		if (asString(magpie.agent)) return "agent";
		if (asString(magpie.middleware)) return "middleware";
	}
	return undefined;
}

/** The package's own icon: a picture the market can show, else undefined. */
function iconOf(pkg: RepoPackage): string | undefined {
	const own = asString(pkg.musepi?.icon) ?? asString(pkg.magpie?.icon);
	if (!own) return undefined;
	// Only what the market renders: an https URL or an inline picture.
	return own.startsWith("https://") || own.startsWith("data:image/") ? own : undefined;
}

/** The package's own one-line claims, by language. */
function summaryOf(pkg: RepoPackage): Record<string, string> | undefined {
	const said = pkg.musepi?.summary ?? pkg.magpie?.summary;
	if (!said || typeof said !== "object") return undefined;
	const out: Record<string, string> = {};
	for (const [lang, value] of Object.entries(said as Record<string, unknown>)) {
		const text = asString(value);
		if (lang.trim() && text && text.length <= 300) out[lang.trim()] = text;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Every repository tagged {@link PLUGIN_TOPIC}, each with what its
 * package.json says. Never throws for one repository's sake: a failed read is
 * reported in `failures` and the rest of the list stands.
 */
export async function discoverPluginsByTopic(
	options: { topic?: string; signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<TopicDiscoveryResult> {
	const topic = options.topic ?? PLUGIN_TOPIC;
	const doFetch = options.fetchImpl ?? fetch;
	const signal = options.signal ?? AbortSignal.timeout(SEARCH_TIMEOUT_MS);

	const params = new URLSearchParams({
		q: `topic:${topic} archived:false fork:false`,
		sort: "stars",
		order: "desc",
		per_page: String(PAGE_SIZE),
	});

	let items: SearchItem[];
	try {
		const response = await doFetch(`${GITHUB_API}/search/repositories?${params}`, {
			headers: authHeaders(),
			signal,
		});
		if (response.status === 403 || response.status === 429) {
			throw new Error(
				"GitHub API rate limit exceeded while searching for plugins; retry later or set GITHUB_TOKEN or GH_TOKEN",
			);
		}
		if (!response.ok) {
			throw new Error(`GitHub plugin search failed: ${response.status} ${response.statusText}`);
		}
		const payload = (await response.json()) as { items?: SearchItem[] };
		items = Array.isArray(payload.items) ? payload.items : [];
	} catch (error) {
		// The market still shows its curated list; discovery is an addition.
		logger.debug("Plugin topic discovery failed", { error: String(error), topic });
		return { plugins: [], failures: [error instanceof Error ? error.message : String(error)] };
	}

	const wanted = items.slice(0, MAX_REPOS);
	const plugins: DiscoveredPlugin[] = [];
	const failures: string[] = [];

	let cursor = 0;
	const worker = async (): Promise<void> => {
		while (cursor < wanted.length) {
			const index = cursor++;
			const item = wanted[index];
			if (!item?.full_name || item.archived || item.fork) continue;
			const repo = item.full_name;
			try {
				const pkg = await readPackageJson(
					repo,
					item.default_branch ?? "main",
					AbortSignal.timeout(REPO_TIMEOUT_MS),
					doFetch,
				);
				if (!pkg) {
					failures.push(`${repo}: no package.json on its default branch`);
					continue;
				}
				const name = asString(pkg.name);
				if (!name) {
					failures.push(`${repo}: package.json names no package`);
					continue;
				}
				plugins.push({
					repo,
					name,
					description: asString(pkg.description),
					version: asString(pkg.version),
					icon: iconOf(pkg),
					homepage: asString(pkg.homepage) ?? item.html_url,
					license: typeof pkg.license === "string" ? pkg.license : (item.license?.spdx_id ?? undefined),
					stars: item.stargazers_count ?? 0,
					reviewed: false,
					summary: summaryOf(pkg),
					kind: kindOf(pkg),
				});
			} catch (error) {
				failures.push(`${repo}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	};

	await Promise.all(Array.from({ length: Math.min(AT_ONCE, wanted.length) }, worker));
	plugins.sort((a, b) => b.stars - a.stars || a.repo.localeCompare(b.repo));
	return { plugins, failures };
}
