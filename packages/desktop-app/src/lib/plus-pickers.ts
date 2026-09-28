/**
 * Pure logic behind the attach「＋」menu pickers (M2-2.6: enabled plugins /
 * workspace files). The React wiring lives in AttachMenu.tsx; everything
 * here is DOM-free so the picker contracts stay unit-testable.
 */

/** Minimal workspace.tree entry shape the picker consumes (daemon returns
 *  a flat list with relative paths — see FilePane WorkspaceEntry). */
export interface PickerTreeEntry {
	name: string;
	path: string;
	isDir: boolean;
}

/** Minimal extensions.list row the plugin picker consumes (ExtensionItem
 *  subset — enabled filtering happens at fetch time on `state`). `path`
 *  is carried for stable row keys, never matched against the query. */
export interface PickerPluginRow {
	name: string;
	displayName?: string;
	description?: string;
	path?: string;
}

/** workspace.tree → flat FILE list (directories never make the picker —
 *  the user picks a file to mention, not a folder). The daemon already
 *  returns relative paths, so flattening is a filter; output is sorted by
 *  path so the order is stable regardless of the scan's directory order. */
export function flattenWorkspaceFiles(entries: readonly PickerTreeEntry[]): string[] {
	return entries
		.filter(e => !e.isDir)
		.map(e => e.path)
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Result of a filtered file list: the visible rows plus whether the
 *  source list was cut off (the picker shows a "narrow it down" hint). */
export interface FilteredFileRows {
	rows: string[];
	truncated: boolean;
}

/** Row cap for the file picker — beyond this the list ends with a
 *  "type more characters" hint instead of rendering the whole tree. */
export const FILE_ROW_LIMIT = 200;

/** Case-insensitive substring filter over file paths with a hard row cap.
 *  An empty query passes everything through (still capped). */
export function filterFileRows(
	paths: readonly string[],
	query: string,
	limit: number = FILE_ROW_LIMIT,
): FilteredFileRows {
	const q = query.toLowerCase();
	const matched = q ? paths.filter(p => p.toLowerCase().includes(q)) : paths;
	return {
		rows: matched.slice(0, limit),
		truncated: matched.length > limit,
	};
}

/** Case-insensitive substring filter over plugin rows: the query matches
 *  the display name OR the one-line description (extensions-center row
 *  parity). An empty query returns every row in source order. */
export function filterPluginRows(list: readonly PickerPluginRow[], query: string): PickerPluginRow[] {
	const q = query.toLowerCase();
	if (!q) return [...list];
	return list.filter(p => `${p.displayName ?? p.name}\n${p.description ?? ""}`.toLowerCase().includes(q));
}
