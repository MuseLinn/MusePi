import type { TranslationKey } from "@musepi/client-core";
import type { IconName } from "../../vendor/oc-icons";

/**
 * The curated integrations catalog: external services and first-party
 * capabilities a person can turn on with one click.
 *
 * Every entry is a bundle of one or more components. The first component is
 * the entry's primary component: it decides the card's installed state and the
 * RPC the install/remove button sends. The other kinds exist so a catalog row
 * can describe a platform capability rather than only a remote MCP server —
 * a bundled Cordis plugin, a marketplace plugin, or a skill — without a second
 * registry or a second credential store.
 *
 * MCP components are written to the user-scope `<agentDir>/mcp.json` — the same
 * file discovery and `/mcp add` read. Vendor endpoints and auth kinds were
 * checked against vendor documentation when the entry was added; recheck an
 * entry when you touch it. A token-typed entry stores its token in that
 * server's `headers`, which makes the token a plain local configuration value:
 * it never enters the repository, the wire, or a log.
 */

/** Card groups behind the category chips. */
export type IntegrationCategory = "product" | "code" | "design" | "data" | "cloud" | "quality";

/** How a service authenticates. Token entries ask for a secret on the card. */
type IntegrationAuthKind = "oauth" | "token";

/**
 * One component of a catalog entry. The kind decides which RPC installs it:
 *
 * - `mcp` — a remote server written to the user-scope `mcp.json`.
 * - `builtin` — a Cordis plugin the distribution already ships; installing
 *   means enabling it through `extensions.setEnabled`, and `pluginId` is the
 *   bare package identity `extensions.list` reports, never a fabricated one.
 * - `plugin` — a marketplace plugin installed through `marketplace.install`.
 * - `skill` — a skill installed from Git through `skills.install`.
 */
export type IntegrationComponent =
	| {
			kind: "mcp";
			/** Remote MCP endpoint; the component is written as an http server. */
			url: string;
			/** How the server authenticates. */
			auth: IntegrationAuthKind;
			/** For `auth: "token"`: the header that carries the secret. */
			tokenHeader?: { name: string; valuePrefix?: string };
			/** Where the user creates a token (`auth: "token"`). */
			tokenHelpUrl?: string;
	  }
	| { kind: "builtin"; pluginId: string }
	| { kind: "plugin"; name: string; marketplace: string }
	| { kind: "skill"; url: string; subdir?: string; name?: string };

/** The MCP component shape, for callers that read its transport facts. */
export type McpComponent = Extract<IntegrationComponent, { kind: "mcp" }>;

export type IntegrationComponentKind = IntegrationComponent["kind"];

export interface IntegrationEntry {
	/** Stable id, and the MCP server name for MCP-primary entries. */
	id: string;
	name: string;
	publisher: string;
	descriptionKey: TranslationKey;
	categories: readonly IntegrationCategory[];
	/** Components installed together; the first one is the primary component. */
	components: readonly [IntegrationComponent, ...IntegrationComponent[]];
	homepage: string;
	status: "stable" | "beta";
	icon: IconName;
}

/** One RPC call that installs or removes an entry. */
export interface IntegrationCall {
	method: string;
	params: Record<string, unknown>;
}

export const INTEGRATION_CATEGORY_ORDER: readonly IntegrationCategory[] = [
	"product",
	"code",
	"design",
	"data",
	"cloud",
	"quality",
];

export const INTEGRATION_CATEGORY_LABEL_KEY: Record<IntegrationCategory, TranslationKey> = {
	product: "settings.integrations.category.product",
	code: "settings.integrations.category.code",
	design: "settings.integrations.category.design",
	data: "settings.integrations.category.data",
	cloud: "settings.integrations.category.cloud",
	quality: "settings.integrations.category.quality",
};

export const INTEGRATION_COMPONENT_LABEL_KEY: Record<IntegrationComponentKind, TranslationKey> = {
	mcp: "settings.integrations.component.mcp",
	builtin: "settings.integrations.component.builtin",
	plugin: "settings.integrations.component.plugin",
	skill: "settings.integrations.component.skill",
};

/** The component that decides the card's installed state and actions. */
export function primaryComponent(entry: IntegrationEntry): IntegrationComponent {
	return entry.components[0];
}

/** The MCP component of an entry, when its primary component is one. */
export function mcpComponent(entry: IntegrationEntry): McpComponent | null {
	const component = primaryComponent(entry);
	return component.kind === "mcp" ? component : null;
}

/** Every builtin plugin id the catalog promotes as a card. */
export function catalogBuiltinPluginIds(): string[] {
	const ids: string[] = [];
	for (const entry of INTEGRATION_CATALOG) {
		const component = primaryComponent(entry);
		if (component.kind === "builtin") ids.push(component.pluginId);
	}
	return ids;
}

/**
 * The RPC that installs an entry's primary component.
 *
 * `token` is the secret typed on the card; it only travels for a token-typed
 * MCP component, as that server's header.
 */
export function installCall(entry: IntegrationEntry, token = ""): IntegrationCall {
	const component = primaryComponent(entry);
	switch (component.kind) {
		case "mcp": {
			return {
				method: "mcp.servers.add",
				params: {
					name: entry.id,
					url: component.url,
					headers:
						component.auth === "token" && component.tokenHeader
							? { [component.tokenHeader.name]: `${component.tokenHeader.valuePrefix ?? ""}${token}` }
							: undefined,
					auth: component.auth === "oauth" ? { type: "oauth" } : undefined,
				},
			};
		}
		case "builtin":
			return { method: "extensions.setEnabled", params: { id: component.pluginId, enabled: true } };
		case "plugin":
			return {
				method: "marketplace.install",
				params: { name: component.name, marketplace: component.marketplace },
			};
		case "skill":
			return {
				method: "skills.install",
				params: {
					url: component.url,
					...(component.subdir ? { subdir: component.subdir } : {}),
					...(component.name ? { name: component.name } : {}),
				},
			};
	}
}

/**
 * The RPC that removes an entry's primary component, or null when the
 * component cannot be addressed by name (a skill installed under a name the
 * catalog does not know).
 */
export function removeCall(entry: IntegrationEntry): IntegrationCall | null {
	const component = primaryComponent(entry);
	switch (component.kind) {
		case "mcp":
			return { method: "mcp.servers.remove", params: { name: entry.id } };
		case "builtin":
			return { method: "extensions.setEnabled", params: { id: component.pluginId, enabled: false } };
		case "plugin":
			return {
				method: "marketplace.remove",
				params: { name: component.name, marketplace: component.marketplace },
			};
		case "skill":
			return component.name ? { method: "skills.delete", params: { name: component.name } } : null;
	}
}

export const INTEGRATION_CATALOG: readonly IntegrationEntry[] = [
	{
		id: "linear",
		name: "Linear",
		publisher: "Linear",
		descriptionKey: "settings.integrations.catalog.linear",
		categories: ["product"],
		components: [{ kind: "mcp", auth: "oauth", url: "https://mcp.linear.app/mcp" }],
		homepage: "https://linear.app",
		status: "stable",
		icon: "list-check-3",
	},
	{
		id: "atlassian",
		name: "Atlassian",
		publisher: "Atlassian",
		descriptionKey: "settings.integrations.catalog.atlassian",
		categories: ["product"],
		components: [{ kind: "mcp", auth: "oauth", url: "https://mcp.atlassian.com/v2/mcp" }],
		homepage: "https://www.atlassian.com",
		status: "stable",
		icon: "briefcase",
	},
	{
		id: "notion",
		name: "Notion",
		publisher: "Notion",
		descriptionKey: "settings.integrations.catalog.notion",
		categories: ["product"],
		components: [{ kind: "mcp", auth: "oauth", url: "https://mcp.notion.com/mcp" }],
		homepage: "https://www.notion.com",
		status: "stable",
		icon: "booklet",
	},
	{
		id: "asana",
		name: "Asana",
		publisher: "Asana",
		descriptionKey: "settings.integrations.catalog.asana",
		categories: ["product"],
		components: [{ kind: "mcp", auth: "oauth", url: "https://mcp.asana.com/v2/mcp" }],
		homepage: "https://asana.com",
		status: "stable",
		icon: "task",
	},
	{
		id: "github",
		name: "GitHub",
		publisher: "GitHub",
		descriptionKey: "settings.integrations.catalog.github",
		categories: ["code"],
		components: [
			{
				kind: "mcp",
				auth: "token",
				url: "https://api.githubcopilot.com/mcp/",
				tokenHeader: { name: "Authorization", valuePrefix: "Bearer " },
				tokenHelpUrl: "https://github.com/settings/tokens",
			},
		],
		homepage: "https://github.com",
		status: "stable",
		icon: "github",
	},
	{
		id: "figma",
		name: "Figma",
		publisher: "Figma",
		descriptionKey: "settings.integrations.catalog.figma",
		categories: ["design"],
		components: [{ kind: "mcp", auth: "oauth", url: "https://mcp.figma.com/mcp" }],
		homepage: "https://www.figma.com",
		status: "stable",
		icon: "pencil",
	},
	{
		id: "supabase",
		name: "Supabase",
		publisher: "Supabase",
		descriptionKey: "settings.integrations.catalog.supabase",
		categories: ["data"],
		components: [{ kind: "mcp", auth: "oauth", url: "https://mcp.supabase.com/mcp" }],
		homepage: "https://supabase.com",
		status: "stable",
		icon: "database-2",
	},
	{
		id: "neon",
		name: "Neon",
		publisher: "Neon",
		descriptionKey: "settings.integrations.catalog.neon",
		categories: ["data"],
		components: [{ kind: "mcp", auth: "oauth", url: "https://mcp.neon.tech/mcp" }],
		homepage: "https://neon.tech",
		status: "stable",
		icon: "database-2",
	},
	{
		id: "sentry",
		name: "Sentry",
		publisher: "Sentry",
		descriptionKey: "settings.integrations.catalog.sentry",
		categories: ["quality"],
		components: [{ kind: "mcp", auth: "oauth", url: "https://mcp.sentry.dev/mcp" }],
		homepage: "https://sentry.io",
		status: "stable",
		icon: "bug",
	},
	{
		id: "cloudflare",
		name: "Cloudflare",
		publisher: "Cloudflare",
		descriptionKey: "settings.integrations.catalog.cloudflare",
		categories: ["cloud"],
		components: [{ kind: "mcp", auth: "oauth", url: "https://mcp.cloudflare.com/mcp" }],
		homepage: "https://www.cloudflare.com",
		status: "stable",
		icon: "cloud",
	},
	{
		id: "vercel",
		name: "Vercel",
		publisher: "Vercel",
		descriptionKey: "settings.integrations.catalog.vercel",
		categories: ["cloud"],
		components: [{ kind: "mcp", auth: "oauth", url: "https://mcp.vercel.com" }],
		homepage: "https://vercel.com",
		status: "beta",
		icon: "rocket",
	},
	{
		id: "dropbox",
		name: "Dropbox",
		publisher: "Dropbox",
		descriptionKey: "settings.integrations.catalog.dropbox",
		categories: ["product"],
		components: [{ kind: "mcp", auth: "oauth", url: "https://mcp.dropbox.com/mcp" }],
		homepage: "https://www.dropbox.com",
		status: "stable",
		icon: "archive",
	},
	{
		id: "android-emulator",
		name: "Android Emulator",
		publisher: "MusePi",
		descriptionKey: "settings.integrations.catalog.androidEmulator",
		categories: ["code"],
		components: [{ kind: "builtin", pluginId: "android-emulator" }],
		homepage: "https://omp.sh",
		status: "beta",
		icon: "smartphone",
	},
	{
		id: "stats-pills",
		name: "Usage and Performance Stats",
		publisher: "MusePi",
		descriptionKey: "settings.integrations.catalog.statsPills",
		categories: ["product"],
		components: [{ kind: "builtin", pluginId: "stats-pills" }],
		homepage: "https://omp.sh",
		status: "beta",
		icon: "bar-chart-2",
	},
	{
		id: "visuals",
		name: "Visual Cards and Pages",
		publisher: "MusePi",
		descriptionKey: "settings.integrations.catalog.visuals",
		categories: ["design"],
		components: [{ kind: "builtin", pluginId: "visuals" }],
		homepage: "https://omp.sh",
		status: "beta",
		icon: "layout-column",
	},
];
