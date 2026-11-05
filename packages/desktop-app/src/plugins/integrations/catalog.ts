import type { TranslationKey } from "@musepi/client-core";
import type { IconName } from "../../vendor/oc-icons";

/**
 * The curated integrations catalog: external services a person can connect to
 * this machine with one click. Every entry here is an MCP server installed into
 * the user-scope `<agentDir>/mcp.json` — the same file discovery and `/mcp add`
 * read — so the catalog adds no second registry and no credential store of its
 * own.
 *
 * Vendor endpoints and auth kinds mirror openchamber's
 * `packages/ui/src/lib/integrations-catalog/registry.ts` (checked against
 * vendor docs on 2026-10-01); recheck an entry when you touch it. A token-typed
 * entry stores its token in that server's `headers`, which makes the token a
 * plain local configuration value: it never enters the repository, the wire, or
 * a log.
 */

/** Card groups behind the category chips. */
export type IntegrationCategory = "product" | "code" | "design" | "data" | "cloud" | "quality";

/** How a service authenticates. Token entries ask for a secret on the card. */
type IntegrationAuthKind = "oauth" | "token";

export interface IntegrationEntry {
	/** Stable id, and the MCP server name written to mcp.json. */
	id: string;
	name: string;
	publisher: string;
	descriptionKey: TranslationKey;
	categories: readonly IntegrationCategory[];
	/** Today every catalog entry ships exactly one component: its MCP server. */
	auth: IntegrationAuthKind;
	/** Remote MCP endpoint; the entry is written as an http server. */
	url: string;
	/** For `auth: "token"`: the header that carries the secret. */
	tokenHeader?: { name: string; valuePrefix?: string };
	/** Where the user creates a token (`auth: "token"`). */
	tokenHelpUrl?: string;
	homepage: string;
	status: "stable" | "beta";
	icon: IconName;
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

export const INTEGRATION_CATALOG: readonly IntegrationEntry[] = [
	{
		id: "linear",
		name: "Linear",
		publisher: "Linear",
		descriptionKey: "settings.integrations.catalog.linear",
		categories: ["product"],
		auth: "oauth",
		url: "https://mcp.linear.app/mcp",
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
		auth: "oauth",
		url: "https://mcp.atlassian.com/v2/mcp",
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
		auth: "oauth",
		url: "https://mcp.notion.com/mcp",
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
		auth: "oauth",
		url: "https://mcp.asana.com/v2/mcp",
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
		auth: "token",
		url: "https://api.githubcopilot.com/mcp/",
		tokenHeader: { name: "Authorization", valuePrefix: "Bearer " },
		tokenHelpUrl: "https://github.com/settings/tokens",
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
		auth: "oauth",
		url: "https://mcp.figma.com/mcp",
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
		auth: "oauth",
		url: "https://mcp.supabase.com/mcp",
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
		auth: "oauth",
		url: "https://mcp.neon.tech/mcp",
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
		auth: "oauth",
		url: "https://mcp.sentry.dev/mcp",
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
		auth: "oauth",
		url: "https://mcp.cloudflare.com/mcp",
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
		auth: "oauth",
		url: "https://mcp.vercel.com",
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
		auth: "oauth",
		url: "https://mcp.dropbox.com/mcp",
		homepage: "https://www.dropbox.com",
		status: "stable",
		icon: "archive",
	},
];
