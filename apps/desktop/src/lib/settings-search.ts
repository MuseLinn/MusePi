import { tLoose } from "@musepi/client-core";
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

/** Relevance of one row for a query: label hits outrank description hits, and
 *  an exact/prefix label outranks a later substring. 0 = no hit. */
function settingScore(row: SettingSearchRow, needle: string): number {
	const label = tLoose(row.label).toLowerCase();
	const source = row.label.toLowerCase();
	const at = label.indexOf(needle);
	const sourceAt = source.indexOf(needle);
	const best = at >= 0 ? at : sourceAt;
	let score =
		best === 0 ? (label === needle || source === needle ? 120 : 100) : best > 0 ? 60 - Math.min(best, 50) / 5 : 0;
	if (row.key.toLowerCase().includes(needle)) score = Math.max(score, 40);
	if (row.description && tLoose(row.description).toLowerCase().includes(needle)) score = Math.max(score, 30);
	return score;
}

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
	const matches: { row: SettingSearchRow; score: number }[] = [];
	for (const row of rows) {
		const label = tLoose(row.label).toLowerCase();
		const description = row.description ? tLoose(row.description).toLowerCase() : "";
		if (
			label.includes(needle) ||
			row.label.toLowerCase().includes(needle) ||
			row.key.toLowerCase().includes(needle) ||
			description.includes(needle)
		) {
			matches.push({ row, score: settingScore(row, needle) });
		}
	}
	return matches
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map(match => match.row);
}
