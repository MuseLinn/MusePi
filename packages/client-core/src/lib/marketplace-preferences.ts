export interface MarketplaceViewPreferences {
	segment: "installed" | "catalog" | "sources";
	filter: string;
	category: string | null;
}

const VIEW_KEY = "musepi-gui-marketplace-view-v1";
const DETAIL_KEY = "musepi-gui-marketplace-detail-v1";
const DEFAULT_VIEW: MarketplaceViewPreferences = { segment: "catalog", filter: "", category: null };

export function loadMarketplaceViewPreferences(): MarketplaceViewPreferences {
	try {
		const raw = localStorage.getItem(VIEW_KEY);
		if (!raw) return DEFAULT_VIEW;
		const value = JSON.parse(raw) as Partial<MarketplaceViewPreferences>;
		return {
			segment: value.segment === "installed" || value.segment === "sources" ? value.segment : "catalog",
			filter: typeof value.filter === "string" ? value.filter : "",
			category: typeof value.category === "string" && value.category ? value.category : null,
		};
	} catch {
		return DEFAULT_VIEW;
	}
}

export function saveMarketplaceViewPreferences(value: MarketplaceViewPreferences): void {
	try {
		localStorage.setItem(VIEW_KEY, JSON.stringify(value));
	} catch {
		// Persistence is optional when storage is unavailable.
	}
}

export function loadMarketplaceDetailPreference(): { name: string; marketplace: string } | null {
	try {
		const raw = localStorage.getItem(DETAIL_KEY);
		if (!raw) return null;
		const value = JSON.parse(raw) as { name?: unknown; marketplace?: unknown };
		return typeof value.name === "string" && typeof value.marketplace === "string"
			? { name: value.name, marketplace: value.marketplace }
			: null;
	} catch {
		return null;
	}
}

export function saveMarketplaceDetailPreference(value: { name: string; marketplace: string } | null): void {
	try {
		if (value) localStorage.setItem(DETAIL_KEY, JSON.stringify(value));
		else localStorage.removeItem(DETAIL_KEY);
	} catch {
		// Persistence is optional when storage is unavailable.
	}
}
