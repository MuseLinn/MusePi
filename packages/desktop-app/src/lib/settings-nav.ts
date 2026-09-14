/**
 * Settings navigation contract — which section ids exist, and how a REQUESTED
 * id maps onto the one that actually renders.
 *
 * Why this lives outside `SettingsView.tsx`: the pane pulls in the whole
 * settings-sections tree, so a mapping bug could only be caught by mounting
 * Electron. Here the rule is a pure function with a unit test.
 *
 * Background (regression 2026-09-14): the pane opened BLANK and only filled
 * in after the user clicked a nav row. Two causes, both fixed by making the
 * contract explicit:
 *   1. `openSettings` was handed to event props (`onSettings={openSettings}`,
 *      `onClick={onOpenSettings}`), so React passed a MouseEvent; it was
 *      stored as the active section and matched no content branch.
 *   2. Entry points name a section by CAPABILITY (`providers` from the
 *      composer's 添加供应商, `plugins` from the sidebar 扩展 row) while the nav
 *      names it by PAGE (`model`, `skills`). The alias was a member of the
 *      section union with no render branch — a state the type system allowed
 *      and the UI could not display.
 */

/** Nav ids that have BOTH a nav row and a content branch. These are the only
 *  ids the pane renders; anything else must resolve to one of them. */
export type SectionId =
	| "general"
	| "appearance"
	| "model"
	| "files"
	| "memory"
	| "notifications"
	| "pet"
	| "sessions"
	| "git"
	| "shortcuts"
	| "interaction"
	| "voice"
	| "context"
	| "shell"
	| "tools"
	| "media"
	| "skills"
	| "subagents"
	| "commands"
	| "mcp"
	| "hooks"
	| "indexes"
	| "usage"
	| "migration"
	| "history"
	| "browser"
	| "suggestions"
	| "modes";

/** Capability names entry points use, which are NOT section ids: they must go
 *  through SECTION_ALIAS to reach a page. Kept in the type so `openSettings`
 *  call sites stay exhaustive, and OUT of SectionId so no call site can treat
 *  one as directly renderable. */
export type SectionAlias = "providers" | "plugins";

/** What a caller may ask the settings pane to open. */
export type SectionRequest = SectionId | SectionAlias;

/** Capability name → page id. The pane lands on the page and highlights its
 *  nav row; the caller never needs to know the page's id. */
export const SECTION_ALIAS: Record<SectionAlias, SectionId> = {
	providers: "model",
	plugins: "skills",
};

/** Section the pane lands on when nothing valid was requested. */
export const DEFAULT_SECTION: SectionId = "appearance";

/** Extension-contributed tabs mount under this prefix; their ids are dynamic,
 *  so they are accepted on the prefix rather than looked up in the id set. */
export const EXT_SECTION_PREFIX = "ext:";

/**
 * Resolve a REQUESTED section into the id the pane should render.
 *
 * `navIds` is the set of ids the nav actually exposes this render (built-ins
 * from `navGroups` plus resolved extension tabs) — the single source of truth
 * for "has a nav row", which is also "has a content branch".
 *
 * Anything unrecognised falls back to DEFAULT_SECTION rather than being used
 * verbatim: a non-string (a DOM event that reached `initialSection` through
 * `onX={openSettings}`), a retired id, or a stale extension tab would all
 * otherwise render an empty pane.
 */
export function resolveActiveSection(raw: unknown, navIds: ReadonlySet<string>): SectionId | string {
	if (typeof raw !== "string" || raw.length === 0) return DEFAULT_SECTION;
	const resolved = (SECTION_ALIAS as Record<string, SectionId | undefined>)[raw] ?? raw;
	if (resolved.startsWith(EXT_SECTION_PREFIX)) return resolved;
	return navIds.has(resolved) ? resolved : DEFAULT_SECTION;
}
