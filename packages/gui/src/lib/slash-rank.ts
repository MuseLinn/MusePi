import type { SlashEntry } from "../components/SlashRow";

/**
 * Rank slash-command completion matches for the "/" menu (shared by the
 * session Composer and the WelcomeComposer so both menus stay in sync):
 * exact name > name prefix > name substring > description substring.
 * Within a tier, GUI-native commands (composer-intercepted — /usage and
 * /context open panels instead of hitting the agent) win, so typing "/c"
 * puts /context ahead of /clear and /compaction.
 *
 * Stable: equal ranks keep the input order; entries that match nothing
 * (e.g. the skill-query survivors that bypass name/description matching)
 * sink to the bottom unchanged. An empty query returns the input as-is
 * so the bare "/" list keeps the catalog order.
 */
export function rankSlashEntries(entries: SlashEntry[], query: string, guiNative: ReadonlySet<string>): SlashEntry[] {
	const q = query.toLowerCase().trim();
	if (!q) return entries;
	const scored: Array<{ entry: SlashEntry; score: number }> = [];
	for (const entry of entries) {
		const name = entry.name.toLowerCase();
		const desc = (entry.description ?? "").toLowerCase();
		let tier: number;
		if (name === q) tier = 0;
		else if (name.startsWith(q)) tier = 1;
		else if (name.includes(q)) tier = 2;
		else if (desc.includes(q)) tier = 3;
		else tier = 4;
		const gui = guiNative.has(entry.name) ? 1 : 0;
		scored.push({ entry, score: tier * 2 - gui });
	}
	scored.sort((a, b) => a.score - b.score);
	return scored.map(s => s.entry);
}
