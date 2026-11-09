import { tLoose } from "@musepi/client-core";

/**
 * Cross-page index of the schema-driven settings rows, so the settings search
 * can find "temperature" while the user is on 常规 and jump to it. The daemon
 * schema is the single source of these rows; only the tab → page mapping lives
 * here, because one schema tab can be re-sliced across pages (the interaction
 * tab renders its Approvals/Speech/Language groups on other pages).
 */

export interface SettingSearchRow {
	key: string;
	/** Nav section id that renders the row. */
	section: string;
	tab: string;
	group?: string;
	/** English schema label; translated at render time (tLoose). */
	label: string;
	description?: string;
}

/** Schema tab + group → the settings page that renders it. Null when no page
 *  owns the tab (an extension-contributed tab we cannot route to). */
export function settingSectionFor(tab: string, group?: string): string | null {
	switch (tab) {
		case "appearance":
			return "appearance";
		case "model":
			return "model";
		case "providers":
			// Provider rows (timeouts, services) render inside the model page.
			return "model";
		case "voice":
			return "voice";
		case "context":
			return "context";
		case "memory":
			return "memory";
		case "files":
			return "files";
		case "shell":
			return "shell";
		case "tools":
			return "tools";
		case "tasks":
			return "subagents";
		case "general":
			return "general";
		case "interaction":
			// Re-sliced groups (see the page READMEs): Approvals sits with the
			// tool toggles, Speech with the voice page, Language with appearance.
			if (group === "Approvals") return "tools";
			if (group === "Speech") return "voice";
			if (group === "Language") return "appearance";
			return "interaction";
		default:
			return null;
	}
}

/** Rows matching the query, capped for the nav list. Matches the translated
 *  label, the English source label, the key and the description; a blank query
 *  matches nothing (the nav shows its normal tree instead). */
export function matchSettingRows(rows: readonly SettingSearchRow[], query: string, limit = 12): SettingSearchRow[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [];
	const matches: SettingSearchRow[] = [];
	for (const row of rows) {
		const label = tLoose(row.label).toLowerCase();
		const description = row.description ? tLoose(row.description).toLowerCase() : "";
		if (
			label.includes(needle) ||
			row.label.toLowerCase().includes(needle) ||
			row.key.toLowerCase().includes(needle) ||
			description.includes(needle)
		) {
			matches.push(row);
			if (matches.length >= limit) break;
		}
	}
	return matches;
}
