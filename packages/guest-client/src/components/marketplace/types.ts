/**
 * Plugin entry shape consumed by the GUI. Mirrors the wire-side
 * MarketplacePluginEntry from `@musepi/pi-coding-agent/extensibility/plugins/marketplace`,
 * trimmed to the fields the card renders. Keeping this local (rather than
 * importing from the coding-agent package) avoids dragging the agent
 * runtime into the browser bundle — the guest-client is a guest over a
 * WebSocket and shouldn't carry the host's plugin discovery layer.
 *
 * `icon` accepts the same forms as the TUI resolver:
 *   - single emoji/glyph ("🛠")
 *   - icon set prefix ("lucide:wrench", "tabler:test-pipe")
 *   - file:// or http(s):// URI for plugin authors shipping artwork
 *
 * When `icon` is omitted or unresolvable, callers fall back to {@link resolveCardIcon}
 * which uses category/tag heuristics; the result lands in `icon` for render.
 */
export interface MarketplaceCardEntry {
	name: string;
	version?: string;
	description?: string;
	author?: string;
	category?: string;
	tags?: readonly string[];
	homepage?: string;
	repository?: string;
	license?: string;
	/** Optional explicit icon (emoji/glyph/set-prefix/URI). */
	icon?: string;
	/** True when the plugin is already installed locally. */
	installed?: boolean;
	/** True while an install/remove request is in flight. */
	busy?: boolean;
	/** Total installs across the marketplace; omit if unknown. */
	installs?: number;
	/** Marketplace display name; used by the grid for grouping. */
	marketplace?: string;
}

/**
 * Card-click handler. The host-side {@link MarketplaceGrid} surfaces
 * install/remove via {@link onInstall}/onRemove, and click for the
 * default action (open detail). Use `kind: "open" | "install" | "remove"`
 * to disambiguate which affordance fired.
 */
export interface MarketplaceCardAction {
	kind: "open" | "install" | "remove";
	entry: MarketplaceCardEntry;
}

/**
 * Icon resolution for the GUI: same lookup table as the TUI resolver
 * (`@musepi/pi-coding-agent/extensibility/plugins/marketplace/icon-resolver`)
 * but kept locally so the browser bundle has no dependency on the agent
 * package. Both tables share a stable convention — if you add a new
 * category, update BOTH.
 */
const CATEGORY_ICONS: Readonly<Record<string, string>> = {
	security: "🛡️",
	testing: "🧪",
	data: "📊",
	ai: "🧠",
	web: "🌐",
	devops: "⚙️",
	database: "🗄️",
	productivity: "✨",
	messaging: "💬",
	finance: "💰",
	design: "🎨",
	media: "🎬",
	docs: "📚",
	game: "🎮",
	search: "🔍",
	storage: "📦",
	monitoring: "📈",
	network: "🛰️",
	utility: "🔧",
	integration: "🔌",
};

const KEYWORD_ICONS: ReadonlyArray<readonly [RegExp, string]> = [
	[/^github/, "🐙"],
	[/^playwright/, "🎭"],
	[/^puppeteer/, "🎭"],
	[/^selenium/, "🎭"],
	[/^chrome[-_]?devtools/, "🛠"],
	[/^aws/, "☁️"],
	[/^gcp|^google[-_]?cloud/, "☁️"],
	[/^azure/, "☁️"],
	[/^docker/, "🐳"],
	[/^kubernetes|^k8s/, "⎈"],
	[/^terraform/, "🏗️"],
	[/^postgres|^psql/, "🐘"],
	[/^mysql/, "🐬"],
	[/^redis/, "🟥"],
	[/^mongo/, "🍃"],
	[/^sqlite/, "🗃️"],
	[/^stripe/, "💳"],
	[/^slack/, "💬"],
	[/^discord/, "💬"],
	[/^notion/, "📝"],
	[/^figma/, "🎨"],
	[/^linear/, "📋"],
	[/^jira/, "📋"],
	[/^sentry/, "🚨"],
	[/^grafana/, "📈"],
	[/^prometheus/, "📈"],
	[/^openai/, "🧠"],
	[/^anthropic/, "🧠"],
	[/^claude/, "🧠"],
	[/^gemini/, "🧠"],
	[/^ollama/, "🧠"],
	[/mcp/, "🔌"],
	[/skill/, "🧩"],
	[/lsp/, "🧠"],
	[/^lint|^eslint|^prettier/, "🧹"],
	[/^format/, "🧹"],
	[/test|^jest|^pytest|^vitest/, "🧪"],
	[/doc|^mdx|^markdown/, "📚"],
];

const NEUTRAL_ICON = "🧩";

/** Sanitize an explicit icon string: strip control chars, cap length. */
function sanitizeIcon(raw: string): string | null {
	const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
	if (cleaned.length === 0) return null;
	return cleaned.length > 8 ? cleaned.slice(0, 8) : cleaned;
}

/**
 * Resolve the best icon for an entry. Order of precedence mirrors the
 * TUI resolver: explicit icon → category table → keyword scan → neutral.
 */
export function resolveCardIcon(entry: Pick<MarketplaceCardEntry, "icon" | "name" | "category" | "tags">): string {
	if (entry.icon) {
		const sanitized = sanitizeIcon(entry.icon);
		if (sanitized !== null) return sanitized;
	}
	if (entry.category) {
		const cat = CATEGORY_ICONS[entry.category.toLowerCase()];
		if (cat !== undefined) return cat;
	}
	const needle = `${entry.name} ${(entry.tags ?? []).join(" ")}`.toLowerCase();
	for (const [pattern, icon] of KEYWORD_ICONS) {
		if (pattern.test(needle)) return icon;
	}
	return NEUTRAL_ICON;
}
