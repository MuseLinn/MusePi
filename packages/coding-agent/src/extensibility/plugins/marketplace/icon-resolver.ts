/**
 * Plugin icon resolution.
 *
 * The marketplace catalog may declare `icon` explicitly (emoji, lucide name,
 * or absolute URI). When absent, the resolver scans `category`, `tags`, and
 * `keywords` against an ordered keyword table and returns the first match.
 * If nothing matches, a neutral default glyph is returned.
 *
 * The keyword table covers the common plugin archetypes that show up in
 * claude-plugins-official, oh-my-pi plugin registries, and similar upstream
 * catalogs. New archetypes should be appended with the most specific keyword
 * on top — `resolvePluginIcon()` short-circuits on the first match.
 */

import type { MarketplacePluginEntry } from "./types.ts";

const DEFAULT_ICON = "🧩";

const ICON_BY_CATEGORY: Record<string, string> = {
	productivity: "⚡",
	automation: "⚡",
	devops: "🛠",
	deployment: "🛠",
	infra: "🛠",
	infrastructure: "🛠",
	security: "🛡",
	auth: "🔐",
	testing: "🧪",
	test: "🧪",
	data: "📊",
	analytics: "📈",
	database: "🗄",
	sql: "🗄",
	web: "🌐",
	browser: "🌐",
	frontend: "🎨",
	ui: "🎨",
	design: "🎨",
	ai: "🤖",
	llm: "🧠",
	ml: "🧠",
	model: "🧠",
	doc: "📚",
	docs: "📚",
	documentation: "📚",
	git: "🔀",
	scm: "🔀",
	version: "🔀",
	chat: "💬",
	messaging: "💬",
	email: "✉️",
	search: "🔎",
	code: "💻",
	programming: "💻",
	language: "💻",
	shell: "🐚",
	terminal: "🐚",
	cli: "⌨️",
	performance: "🚀",
	network: "🌐",
	api: "🔌",
	monitoring: "📡",
	log: "📜",
	logging: "📜",
};

/**
 * Ordered keyword→icon table. Higher-priority keywords come first so we
 * short-circuit on the most specific match (e.g. "github-mcp" before "mcp").
 */
const ICON_BY_KEYWORD: Array<[string, string]> = [
	// MCP / connector archetypes — narrowest first.
	["github-mcp", "🐙"],
	["notion-mcp", "📝"],
	["slack-mcp", "💬"],
	["linear-mcp", "📐"],
	["jira-mcp", "🎫"],
	["figma-mcp", "🎨"],
	["playwright-mcp", "🎭"],
	["puppeteer-mcp", "🎭"],
	["postgres-mcp", "🐘"],
	["sqlite-mcp", "🗄"],
	["redis-mcp", "🟥"],
	["kubernetes-mcp", "☸️"],
	["docker-mcp", "🐳"],
	// Connector / app integration patterns.
	["github", "🐙"],
	["notion", "📝"],
	["slack", "💬"],
	["linear", "📐"],
	["jira", "🎫"],
	["figma", "🎨"],
	["playwright", "🎭"],
	["puppeteer", "🎭"],
	["postgres", "🐘"],
	["postgresql", "🐘"],
	["sqlite", "🗄"],
	["redis", "🟥"],
	["kubernetes", "☸️"],
	["k8s", "☸️"],
	["docker", "🐳"],
	["aws", "☁️"],
	["azure", "☁️"],
	["gcp", "☁️"],
	// Generic archetypes.
	["mcp", "🔌"],
	["lsp", "📝"],
	["dap", "🐞"],
	["hook", "🪝"],
	["hooks", "🪝"],
	["command", "⌨️"],
	["commands", "⌨️"],
	["skill", "🎯"],
	["skills", "🎯"],
	["agent", "🤖"],
	["agents", "🤖"],
	["test", "🧪"],
	["testing", "🧪"],
	["lint", "🧹"],
	["format", "✨"],
	["doc", "📚"],
	["docs", "📚"],
	["deploy", "🚀"],
	["release", "🚀"],
	["security", "🛡"],
	["auth", "🔐"],
	["oauth", "🔐"],
	["token", "🔑"],
	["git", "🔀"],
	["shell", "🐚"],
	["cli", "⌨️"],
	["sql", "🗄"],
	["http", "🌐"],
	["api", "🔌"],
	["ui", "🎨"],
	["web", "🌐"],
	["frontend", "🎨"],
	["backend", "🧱"],
	["data", "📊"],
	["analytics", "📈"],
	["log", "📜"],
];

/**
 * Resolve the icon for a marketplace plugin entry.
 *
 * Returns the entry's explicit `icon` if set (after light validation that
 * strips control characters and whitespace). Otherwise scans category, tags,
 * and keywords for the first matching archetype. Falls back to `🧩` when
 * nothing matches — never throws.
 */
export function resolvePluginIcon(
	entry: Pick<MarketplacePluginEntry, "icon" | "category" | "tags" | "keywords">,
): string {
	const explicit = entry.icon?.trim();
	if (explicit) return sanitizeIcon(explicit);

	if (entry.category) {
		const fromCategory = ICON_BY_CATEGORY[entry.category.toLowerCase()];
		if (fromCategory) return fromCategory;
	}

	const haystacks: string[] = [];
	if (entry.tags) haystacks.push(...entry.tags);
	if (entry.keywords) haystacks.push(...entry.keywords);
	for (const hay of haystacks) {
		const normalized = hay.toLowerCase().trim();
		if (!normalized) continue;
		for (const [needle, glyph] of ICON_BY_KEYWORD) {
			if (normalized === needle || normalized.includes(needle)) return glyph;
		}
	}

	return DEFAULT_ICON;
}

/**
 * Sanitize an explicit icon: strip control chars, collapse whitespace, and
 * cap length so a stray 64KB string from a hostile catalog can't bloat the
 * TUI output. URI-style icons pass through unchanged.
 */
function sanitizeIcon(raw: string): string {
	if (raw.startsWith("file://") || raw.startsWith("http://") || raw.startsWith("https://")) {
		return raw.length > 512 ? `${raw.slice(0, 512)}…` : raw;
	}
	const stripped = raw
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return stripped.length > 8 ? `${stripped.slice(0, 8)}…` : stripped;
}
