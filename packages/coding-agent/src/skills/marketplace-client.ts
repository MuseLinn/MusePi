/**
 * Skill marketplace clients (SkillHub + skills.sh).
 *
 * These are READ-ONLY remote catalogs — the discovery half of the capability
 * center. They are deliberately separate from
 * `extensibility/plugins/marketplace/` (which serves *plugin packages* behind
 * a user-maintained `marketplaces.json` registry). A skill catalog is public
 * and needs no registry entry, so conflating the two would force every user
 * to "add a marketplace" before they could browse anything — that is exactly
 * why the store tab rendered empty.
 *
 * Auth reality (verified against the live endpoints, 2026-09-19):
 *
 *   - **SkillHub** (`https://api.skillhub.cn`) — fully public. List / top /
 *     search / categories / detail / files all answer 200 without credentials.
 *     This is the primary source: it alone carries every field the card grid
 *     needs (icon, stars, downloads, category, description_zh).
 *   - **skills.sh** — its documented `/api/v1/*` surface requires a **Vercel
 *     OIDC token**, which only exists inside a Vercel deployment and is
 *     therefore unusable from a desktop app. Only the legacy
 *     `/api/search?q=…&limit=…` endpoint answers without auth (401 on v1).
 *     So skills.sh is wired as a *search-only* secondary source; it cannot
 *     supply a browse/trending view. Its `q` must be >= 2 chars.
 *
 * Every call is timeout-bounded and never throws across the RPC boundary:
 * a failing remote source degrades to an empty result so one dead host can
 * never blank the whole store.
 */

/** One catalog entry, normalized across both sources. */
export interface SkillMarketEntry {
	/** Stable id, unique across sources (`source:slug`). */
	id: string;
	source: "skillhub" | "skills.sh";
	/** Catalog slug; the install key. */
	slug: string;
	name: string;
	description: string;
	/** SkillHub ships a Chinese description; preferred when the UI is zh-CN. */
	descriptionZh?: string;
	/** Publisher / namespace display name. */
	author?: string;
	category?: string;
	iconUrl?: string;
	stars?: number;
	downloads?: number;
	installs?: number;
	version?: string;
	homepage?: string;
	verified?: boolean;
	/** Repo/URL usable for install; skills.sh exposes this, SkillHub does not. */
	installUrl?: string;
	/** skills.sh: the publisher repo (`owner/repo`); the slug is the
	 *  repo-relative skill folder. Drives subdir-aware install + preview. */
	repo?: string;
}

export interface SkillMarketCategory {
	key: string;
	name: string;
	nameEn?: string;
}

export interface SkillMarketPage {
	entries: SkillMarketEntry[];
	total: number;
	/** Sources that answered; the UI shows which catalogs are live. */
	liveSources: string[];
	/** Per-source failure messages, for a non-blocking error banner. */
	failures: string[];
}

const SKILLHUB_BASE = "https://api.skillhub.cn";
const SKILLS_SH_BASE = "https://skills.sh";
const TIMEOUT_MS = 12_000;

/** fetch with a hard timeout — a hung catalog must not hang the RPC. */
async function getJson(url: string, timeoutMs = TIMEOUT_MS): Promise<unknown> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return await res.json();
	} finally {
		clearTimeout(timer);
	}
}

function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function str(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** SkillHub wraps early endpoints in `{code,message,data}`; v1 paths are bare. */
function unwrap(raw: unknown): Record<string, unknown> {
	if (raw && typeof raw === "object" && "data" in raw) {
		const d = (raw as { data?: unknown }).data;
		return d && typeof d === "object" ? (d as Record<string, unknown>) : {};
	}
	return (raw ?? {}) as Record<string, unknown>;
}

/* ── SkillHub ──────────────────────────────────────────────────────────── */

/** Raw `/api/skills` row, trimmed to the fields we consume. */
interface SkillHubRow {
	slug?: string;
	name?: string;
	description?: string;
	description_zh?: string;
	category?: string;
	iconUrl?: string;
	downloads?: number;
	installs?: number;
	stars?: number;
	score?: number;
	version?: string;
	homepage?: string;
	verified?: boolean;
	ownerName?: string;
	namespace?: { displayName?: string; canonicalName?: string };
}

function fromSkillHub(r: SkillHubRow): SkillMarketEntry {
	const slug = r.slug ?? "";
	return {
		id: `skillhub:${slug}`,
		source: "skillhub",
		slug,
		name: r.name ?? slug,
		description: r.description ?? "",
		descriptionZh: r.description_zh,
		author: r.namespace?.displayName ?? r.ownerName,
		category: r.category,
		iconUrl: r.iconUrl,
		stars: num(r.stars),
		downloads: num(r.downloads),
		installs: num(r.installs),
		version: r.version,
		homepage: r.homepage,
		verified: r.verified === true,
	};
}

export interface SkillHubQuery {
	keyword?: string;
	category?: string;
	/** "downloads" (default) | "stars" | "installs". */
	sortBy?: "downloads" | "stars" | "installs";
	order?: "asc" | "desc";
	/** 1-indexed — the API rejects `page=0` with "page 必须 >= 1". */
	page?: number;
	pageSize?: number;
}

export async function searchSkillHub(q: SkillHubQuery = {}): Promise<{ entries: SkillMarketEntry[]; total: number }> {
	const url = new URL(`${SKILLHUB_BASE}/api/skills`);
	url.searchParams.set("pageSize", String(Math.min(Math.max(q.pageSize ?? 24, 1), 100)));
	url.searchParams.set("page", String(Math.max(q.page ?? 1, 1)));
	url.searchParams.set("sortBy", q.sortBy ?? "downloads");
	url.searchParams.set("order", q.order ?? "desc");
	if (q.keyword?.trim()) url.searchParams.set("keyword", q.keyword.trim());
	if (q.category?.trim()) url.searchParams.set("category", q.category.trim());
	// Empty keyword is the browse case: /api/skills/top is the ranked list.
	const raw = await getJson(url.toString());
	const data = unwrap(raw);
	const rows = Array.isArray(data.skills) ? (data.skills as SkillHubRow[]) : [];
	return { entries: rows.map(fromSkillHub), total: num(data.total) ?? rows.length };
}

export async function topSkillHub(pageSize = 12): Promise<SkillMarketEntry[]> {
	const raw = await getJson(`${SKILLHUB_BASE}/api/skills/top`);
	const data = unwrap(raw);
	const rows = Array.isArray(data.skills) ? (data.skills as SkillHubRow[]) : [];
	return rows.slice(0, pageSize).map(fromSkillHub);
}

/** First-level categories (13 at time of writing) — drives the chip row. */
export async function listSkillHubCategories(): Promise<SkillMarketCategory[]> {
	const raw = await getJson(`${SKILLHUB_BASE}/api/v1/categories`);
	const obj = (raw ?? {}) as { items?: unknown[] };
	if (!Array.isArray(obj.items)) return [];
	return obj.items.map(i => {
		const r = (i ?? {}) as Record<string, unknown>;
		return {
			key: String(r.key ?? ""),
			name: str(r.name) ?? String(r.key ?? ""),
			nameEn: str(r.nameEn),
		};
	});
}

export interface SkillHubDetail {
	slug: string;
	latestVersion?: string;
	files: { path: string; size: number }[];
	security?: { status?: string; statusText?: string; reportUrl?: string }[];
}

export async function skillHubDetail(slug: string): Promise<SkillHubDetail | null> {
	try {
		const [meta, files] = await Promise.all([
			getJson(`${SKILLHUB_BASE}/api/v1/skills/${encodeURIComponent(slug)}`),
			getJson(`${SKILLHUB_BASE}/api/v1/skills/${encodeURIComponent(slug)}/files`),
		]);
		const m = (meta ?? {}) as Record<string, unknown>;
		const lv = m.latestVersion as { version?: unknown } | undefined;
		const sec = m.securityReports as
			| Record<string, { status?: unknown; statusText?: unknown; reportUrl?: unknown }>
			| undefined;
		const f = (files ?? {}) as { files?: unknown[] };
		return {
			slug,
			latestVersion: str(lv?.version),
			files: Array.isArray(f.files)
				? f.files.map(x => {
						const r = (x ?? {}) as Record<string, unknown>;
						return { path: String(r.path ?? ""), size: num(r.size) ?? 0 };
					})
				: [],
			security: sec
				? Object.values(sec).map(s => ({
						status: str(s.status),
						statusText: str(s.statusText),
						reportUrl: str(s.reportUrl),
					}))
				: undefined,
		};
	} catch {
		return null;
	}
}

/** Download URL for a skill zip. The API answers 302 → object storage, so
 *  the caller must follow redirects (`curl -L` / fetch default). */
export function skillHubDownloadUrl(slug: string): string {
	return `${SKILLHUB_BASE}/api/v1/download?slug=${encodeURIComponent(slug)}`;
}

/* ── skills.sh (search-only; v1 needs a Vercel OIDC token we cannot mint) ─ */

interface SkillsShRow {
	id?: string;
	skillId?: string;
	name?: string;
	installs?: number;
	source?: string;
}

export async function searchSkillsSh(query: string, limit = 24): Promise<SkillMarketEntry[]> {
	// The endpoint rejects short queries outright (400), so don't burn a call.
	const q = query.trim();
	if (q.length < 2) return [];
	const url = `${SKILLS_SH_BASE}/api/search?q=${encodeURIComponent(q)}&limit=${Math.min(Math.max(limit, 1), 200)}`;
	const raw = await getJson(url);
	const obj = (raw ?? {}) as { skills?: unknown[] };
	if (!Array.isArray(obj.skills)) return [];
	return (obj.skills as SkillsShRow[]).map(r => {
		const slug = r.skillId ?? r.name ?? r.id ?? "";
		return {
			id: `skills.sh:${slug}`,
			source: "skills.sh" as const,
			slug,
			name: r.name ?? slug,
			description: "",
			author: r.source,
			installs: num(r.installs),
			// skills.sh exposes the GitHub repo as the install target and a
			// canonical page per skill. The skill id is the repo-relative
			// folder — installs must pass it as `subdir` (multi-skill repos
			// otherwise hit the ambiguous-SKILL.md error) and previews read
			// SKILL.md straight from the repo.
			repo: r.source,
			installUrl: r.source ? `https://github.com/${r.source}` : undefined,
			homepage: r.id ? `${SKILLS_SH_BASE}/${r.id}` : undefined,
		};
	});
}

/* ── Aggregated query used by the RPC layer ────────────────────────────── */

export interface MarketQuery {
	keyword?: string;
	category?: string;
	/** Which catalogs to hit. Defaults to both. */
	sources?: ("skillhub" | "skills.sh")[];
	sortBy?: "downloads" | "stars" | "installs";
	pageSize?: number;
	/** 1-indexed (SkillHub rejects 0); the grid pages with it. */
	page?: number;
}

/**
 * Query the catalogs and merge. Failures are collected, not thrown: a dead
 * source leaves the other one's results intact and surfaces one line in
 * `failures`, so the store never goes blank because of a single host.
 */
export async function querySkillMarket(q: MarketQuery = {}): Promise<SkillMarketPage> {
	const want = q.sources ?? ["skillhub", "skills.sh"];
	const entries: SkillMarketEntry[] = [];
	const liveSources: string[] = [];
	const failures: string[] = [];
	let total = 0;

	const jobs: Promise<void>[] = [];

	if (want.includes("skillhub")) {
		jobs.push(
			searchSkillHub({
				keyword: q.keyword,
				category: q.category,
				sortBy: q.sortBy,
				pageSize: q.pageSize,
				page: q.page,
			})
				.then(r => {
					entries.push(...r.entries);
					total += r.total;
					liveSources.push("skillhub");
				})
				.catch((e: unknown) => {
					failures.push(`skillhub: ${e instanceof Error ? e.message : String(e)}`);
				}),
		);
	}

	// skills.sh has no browse endpoint — contributing only when the user
	// actually typed something is what keeps it from being dead weight.
	if (want.includes("skills.sh") && q.keyword && q.keyword.trim().length >= 2) {
		jobs.push(
			searchSkillsSh(q.keyword, q.pageSize ?? 24)
				.then(r => {
					entries.push(...r);
					liveSources.push("skills.sh");
				})
				.catch((e: unknown) => {
					failures.push(`skills.sh: ${e instanceof Error ? e.message : String(e)}`);
				}),
		);
	}

	await Promise.all(jobs);

	if (q.sortBy && q.sortBy !== "downloads") {
		entries.sort(
			(a, b) =>
				(b[q.sortBy === "stars" ? "stars" : "installs"] ?? 0) -
				(a[q.sortBy === "stars" ? "stars" : "installs"] ?? 0),
		);
	} else {
		entries.sort((a, b) => (b.downloads ?? b.installs ?? 0) - (a.downloads ?? a.installs ?? 0));
	}

	return { entries, total, liveSources, failures };
}
