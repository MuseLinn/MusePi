import type { LucideIcon } from "lucide-react";
import {
	Activity,
	BookOpen,
	Boxes,
	Braces,
	ChartNoAxesColumn,
	Clapperboard,
	Cloud,
	Container,
	Cpu,
	CreditCard,
	Database,
	Eraser,
	FileText,
	FlaskConical,
	Gamepad2,
	GitBranch,
	Globe,
	HardDrive,
	Layers,
	ListChecks,
	MessageSquare,
	MonitorCog,
	MonitorPlay,
	Network,
	Package,
	Palette,
	PenTool,
	Plug,
	Puzzle,
	Search,
	ShieldCheck,
	Siren,
	Wallet,
	Wrench,
} from "lucide-react";

/**
 * Plugin entry shape consumed by the GUI. Mirrors the wire-side
 * MarketplacePluginEntry from `@musepi/pi-coding-agent/extensibility/plugins/marketplace`,
 * trimmed to the fields the card renders. Keeping this local (rather than
 * importing from the coding-agent package) avoids dragging the agent
 * runtime into the browser bundle — the client-core is a guest over a
 * WebSocket and shouldn't carry the host's plugin discovery layer.
 *
 * `icon` may name a vector icon (`"lucide:wrench"` or `"wrench"`) or an
 * http(s)/file artwork URI. Other identifier-like values
 * (`"tabler:test-pipe"`) map through the same keyword table. Emoji and
 * arbitrary glyphs use the consistent lucide fallback so one catalog entry
 * cannot break the visual language.
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
	/** Optional lucide icon name (`"lucide:wrench"` or `"wrench"`). */
	icon?: string;
	/** True when the plugin is already installed locally. */
	installed?: boolean;
	/** Effective enablement of the active install. */
	enabled?: boolean;
	/** Scope of the active install; project shadows user. */
	installedScope?: "user" | "project" | null;
	/** Version of the active install (project scope shadowing user). */
	installedVersion?: string;
	/** Catalog version is newer than the active install. */
	updateAvailable?: boolean;
	/** True while an install/remove/upgrade request is in flight. */
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
	kind: "open" | "install" | "remove" | "upgrade";
	entry: MarketplaceCardEntry;
}

/** One custom marketplace source as served by `marketplace.sources.list`. */
export interface MarketplaceSource {
	name: string;
	sourceType: "github" | "git" | "url" | "local";
	sourceUri: string;
	addedAt: string;
	updatedAt: string;
}

/**
 * Vector icon resolution for the GUI. The terminal keeps its emoji table
 * (`coding-agent/extensibility/plugins/marketplace/icon-resolver`); the
 * desktop card renders lucide components so every entry shares one stroke
 * weight and palette. Category icons double as the named-icon vocabulary,
 * which keeps `icon: "lucide:security"` and `category: "security"` aligned.
 */
const CATEGORY_ICONS: Readonly<Record<string, LucideIcon>> = {
	security: ShieldCheck,
	testing: FlaskConical,
	data: ChartNoAxesColumn,
	ai: Cpu,
	web: Globe,
	devops: Container,
	database: Database,
	productivity: ListChecks,
	messaging: MessageSquare,
	finance: Wallet,
	design: Palette,
	media: Clapperboard,
	docs: BookOpen,
	game: Gamepad2,
	search: Search,
	storage: HardDrive,
	monitoring: Activity,
	network: Network,
	utility: Wrench,
	integration: Plug,
};

/** Common lucide names an author may write after `lucide:`. */
const NAMED_ICONS: Readonly<Record<string, LucideIcon>> = {
	...CATEGORY_ICONS,
	activity: Activity,
	book: BookOpen,
	bookopen: BookOpen,
	boxes: Boxes,
	braces: Braces,
	chart: ChartNoAxesColumn,
	chartnoaxescolumn: ChartNoAxesColumn,
	clapperboard: Clapperboard,
	cloud: Cloud,
	code: Braces,
	container: Container,
	cpu: Cpu,
	creditcard: CreditCard,
	database: Database,
	docs: BookOpen,
	eraser: Eraser,
	filetext: FileText,
	flask: FlaskConical,
	flaskconical: FlaskConical,
	gamepad: Gamepad2,
	git: GitBranch,
	gitbranch: GitBranch,
	globe: Globe,
	harddrive: HardDrive,
	layers: Layers,
	listchecks: ListChecks,
	message: MessageSquare,
	messagesquare: MessageSquare,
	monitorcog: MonitorCog,
	monitorplay: MonitorPlay,
	network: Network,
	package: Package,
	palette: Palette,
	pentool: PenTool,
	plug: Plug,
	puzzle: Puzzle,
	search: Search,
	shield: ShieldCheck,
	shieldcheck: ShieldCheck,
	siren: Siren,
	wallet: Wallet,
	wrench: Wrench,
};

const KEYWORD_ICONS: ReadonlyArray<readonly [RegExp, LucideIcon]> = [
	[/^github/, GitBranch],
	[/^playwright|^puppeteer|^selenium/, MonitorPlay],
	[/^chrome[-_]?devtools/, MonitorCog],
	[/^aws|^gcp|^google[-_]?cloud|^azure/, Cloud],
	[/^docker/, Container],
	[/^kubernetes|^k8s/, Boxes],
	[/^terraform/, Layers],
	[/^postgres|^psql|^mysql|^sqlite|^mongo|^redis/, Database],
	[/^stripe/, CreditCard],
	[/^slack|^discord/, MessageSquare],
	[/^notion/, FileText],
	[/^figma/, PenTool],
	[/^linear|^jira/, ListChecks],
	[/^sentry/, Siren],
	[/^grafana|^prometheus/, Activity],
	[/^openai|^anthropic|^claude|^gemini|^ollama/, Cpu],
	[/mcp/, Plug],
	[/skill/, Puzzle],
	[/lsp/, Braces],
	[/^lint|^eslint|^prettier|^format/, Eraser],
	[/test|^jest|^pytest|^vitest/, FlaskConical],
	[/doc|^mdx|^markdown/, BookOpen],
];

const NEUTRAL_ICON = Package;

/**
 * Design-system content marker (M3.7d): a marketplace package declares
 * itself a design-system pack by setting its catalog `category` or one of
 * its `tags` to one of these values (case-insensitive). Exact match after
 * lowercasing + trimming — `design` alone is deliberately NOT a marker
 * (too broad: icons/UI kits also categorize as design). Wire-compatible:
 * pure derivation over existing catalog fields, no daemon change.
 */
const DESIGN_SYSTEM_MARKERS: readonly string[] = ["design-system", "design system", "design_system", "designsystem"];

/**
 * True when a marketplace catalog entry declares design-system content —
 * the capability center renders a 「设计体系」 badge on those cards so
 * design-system packs are discoverable in the market tab.
 */
export function hasDesignSystemContent(entry: Pick<MarketplaceCardEntry, "category" | "tags">): boolean {
	const haystack = [entry.category ?? "", ...(entry.tags ?? [])].map(v => v.trim().toLowerCase());
	return haystack.some(v => (DESIGN_SYSTEM_MARKERS as readonly string[]).includes(v));
}

/**
 * Resolve the best vector icon for an entry: recognized explicit name →
 * category → keyword scan → neutral package. An explicit value that reads
 * as an icon identifier (for example `tabler:test-pipe`) also gets a
 * keyword pass before the category fallback. This is also the fallback for
 * emoji, arbitrary glyphs, and artwork that fails to load.
 */
export function resolveCardIcon(entry: Pick<MarketplaceCardEntry, "icon" | "name" | "category" | "tags">): LucideIcon {
	if (entry.icon) {
		const raw = entry.icon.trim().toLowerCase();
		const named = NAMED_ICONS[raw.replace(/^lucide:/, "").replace(/[\s_-]/g, "")];
		if (named !== undefined) return named;
		if (/^[a-z0-9][a-z0-9:-]*$/.test(raw)) {
			for (const [pattern, icon] of KEYWORD_ICONS) {
				if (pattern.test(raw)) return icon;
			}
		}
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
