import { getLocaleSnapshot, type TranslationKey, tFor, tLoose } from "@musepi/client-core/src/i18n/index";
import { TextSearchIndex } from "@musepi/client-core/src/lib/text-search";
import { useEffect, useState } from "react";
import type { RpcClient } from "./rpc";

interface SchemaUi {
	hidden?: boolean;
	tuiOnly?: boolean;
	label?: string;
	description?: string;
	group?: string;
}

/**
 * Cross-page index of the schema-driven settings rows, shared by the settings
 * nav search and the ⌘K palette: one `settings.schema {all:true}` round trip
 * names every row any page can render, even the pages not currently open.
 * Translation happens at render time.
 */
export function useSettingSearchRows(rpc: RpcClient | null): SettingSearchRow[] {
	const [rows, setRows] = useState<SettingSearchRow[]>([]);
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		void rpc
			.request<Record<string, { key: string; ui?: SchemaUi }[]>>("settings.schema", { all: true })
			.then(res => {
				if (!alive) return;
				const next: SettingSearchRow[] = [];
				for (const [tab, items] of Object.entries(res ?? {})) {
					for (const item of items ?? []) {
						const ui = item.ui;
						if (!ui || ui.hidden || ui.tuiOnly || !ui.label) continue;
						const section = settingSectionFor(tab, ui.group);
						if (!section) continue;
						next.push({
							key: item.key,
							section,
							tab,
							group: ui.group,
							label: ui.label,
							description: ui.description,
						});
					}
				}
				setRows(next);
			})
			.catch(() => {
				// Keep the nav-only behaviour when the daemon is old or away.
			});
		return () => {
			alive = false;
		};
	}, [rpc]);
	return rows;
}

/** One schema row the settings search can name. Labels are the English schema
 *  text, translated at render and match time; the search matches both
 *  languages. */
export interface SettingSearchRow {
	key: string;
	/** Nav section id that renders the row. */
	section: string;
	tab: string;
	group?: string;
	/** English schema label; translated for display and for matching. */
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

/** Cross-page schema index, prepared once per rows array and locale: a search
 *  keystroke reuses the folded keys, and a locale switch rebuilds the labels. */
let settingIndex: {
	rows: readonly SettingSearchRow[];
	locale: string;
	index: TextSearchIndex<SettingSearchRow>;
} | null = null;

/** Both shipped languages of one schema string: the active locale's text plus
 *  en-US and zh-CN, so a query in either language hits even while the UI is in
 *  the other. Loose schema keys fall back to their English source. */
function languagesOf(text: string | undefined): (string | undefined)[] {
	if (!text) return [undefined];
	return [tLoose(text), tFor("en-US", text as TranslationKey), tFor("zh-CN", text as TranslationKey)];
}

function indexFor(rows: readonly SettingSearchRow[]): TextSearchIndex<SettingSearchRow> {
	const locale = getLocaleSnapshot();
	if (settingIndex?.rows === rows && settingIndex.locale === locale) return settingIndex.index;
	const index = new TextSearchIndex(rows, row => ({
		fuzzy: languagesOf(row.label),
		substring: [row.key, ...languagesOf(row.description)],
	}));
	settingIndex = { rows, locale, index };
	return index;
}

/** Rows matching the query, capped for the nav list. Both languages of the
 *  label and description match; a blank query matches nothing (the nav shows
 *  its normal tree instead). */
export function matchSettingRows(rows: readonly SettingSearchRow[], query: string, limit = 12): SettingSearchRow[] {
	return indexFor(rows)
		.rank(query)
		.slice(0, limit)
		.map(hit => hit.item);
}
