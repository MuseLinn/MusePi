import type { MarketplaceCatalog, MarketplaceRegistryEntry, MarketplacesRegistry } from "./types";

const DEFAULT_UPDATED_AT = "1970-01-01T00:00:00.000Z";

const CATALOGS: Record<string, MarketplaceCatalog> = {
	"superpowers-dev": {
		name: "superpowers-dev",
		owner: { name: "Jesse Vincent", email: "jesse@fsck.com" },
		metadata: { description: "Development marketplace for Superpowers core skills library" },
		plugins: [
			{
				name: "superpowers",
				description: "Planning, TDD, debugging, and delivery workflows for coding agents",
				version: "7.0.2",
				source: "./",
				icon: "https://raw.githubusercontent.com/obra/superpowers/v7.0.2/assets/app-icon.png",
				author: { name: "Jesse Vincent", email: "jesse@fsck.com" },
			},
		],
	},
	googlechrome: {
		name: "googlechrome",
		owner: { name: "Google Chrome" },
		metadata: { description: "Modern web development guidance for AI coding agents" },
		plugins: [
			{
				name: "modern-web-guidance",
				description: "Modern Web development best practices",
				version: "0.0.197",
				source: "./",
				icon: "https://raw.githubusercontent.com/GoogleChrome/modern-web-guidance/v0.0.197/assets/logo.png",
			},
		],
	},
};

export function defaultMarketplaceCatalog(name: string): MarketplaceCatalog | undefined {
	return CATALOGS[name];
}

export function withDefaultMarketplaces(
	registry: MarketplacesRegistry,
	options: { marketplacesCacheDir: string; includeDefaultMarketplaces?: boolean },
): MarketplacesRegistry {
	if (!options.includeDefaultMarketplaces) return registry;
	const custom = new Map(registry.marketplaces.map(entry => [entry.name, entry] as const));
	const defaultNames = ["superpowers-dev", "googlechrome"];
	const entries = defaultNames.map(name => {
		const existing = custom.get(name);
		if (existing) return existing;
		return {
			name,
			sourceType: "github" as const,
			sourceUri: name === "superpowers-dev" ? "obra/superpowers" : "GoogleChrome/modern-web-guidance",
			catalogPath: `${options.marketplacesCacheDir}/${name}/marketplace.json`,
			addedAt: DEFAULT_UPDATED_AT,
			updatedAt: DEFAULT_UPDATED_AT,
		} satisfies MarketplaceRegistryEntry;
	});
	entries.push(...registry.marketplaces.filter(entry => !defaultNames.includes(entry.name)));
	return { ...registry, marketplaces: entries };
}
