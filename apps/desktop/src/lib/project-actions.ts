import type { IconName } from "../vendor/oc-icons";

/**
 * Per-project custom actions (openchamber ProjectActionsButton parity):
 * user-defined shell commands listed in the header project-actions menu,
 * executed in the bottom terminal dock. Persisted in localStorage keyed by
 * the project cwd (terminal-tabs precedent); daemon-side persistence
 * (`.musepi/project.json`) is a future item.
 */

export interface ProjectAction {
	id: string;
	name: string;
	command: string;
	/** Icon key from the limited set below; unknown values read as "play". */
	icon: string;
	/** Reserved (openchamber autoOpenUrl parity): kept on parse so future
	 *  wiring / daemon persistence doesn't drop hand-migrated entries. */
	autoOpenUrl?: boolean;
}

/** Limited icon set (openchamber PROJECT_ACTION_ICONS, sprite-name parity). */
export const PROJECT_ACTION_ICONS = [
	"play",
	"hammer",
	"checkbox-circle",
	"terminal-box",
	"tools",
	"bug",
	"flask",
	"rocket",
	"code",
	"server",
	"git-branch",
	"search",
	"settings-3",
	"brain-ai-3",
	"stack",
	"robot-2",
	"command",
	"file-text",
] as const;

export type ProjectActionIcon = (typeof PROJECT_ACTION_ICONS)[number];

export const DEFAULT_ACTION_ICON: ProjectActionIcon = "play";

/** Resolve a stored icon key to a sprite icon name (unknown → "play"). */
export function resolveProjectActionIcon(icon: string): IconName {
	return (PROJECT_ACTION_ICONS as readonly string[]).includes(icon) ? (icon as IconName) : DEFAULT_ACTION_ICON;
}

const ACTIONS_KEY_PREFIX = "musepi-gui-project-actions-";
const MAX_ACTIONS = 12;

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/** Sanitize an unknown parse result into valid actions: drops entries
 *  missing id/name/command, resolves the icon against the limited set,
 *  keeps autoOpenUrl only as literal true, dedupes ids, caps the list. */
export function parseProjectActions(raw: unknown): ProjectAction[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const out: ProjectAction[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const rec = entry as Record<string, unknown>;
		if (!isNonEmptyString(rec.id) || !isNonEmptyString(rec.name) || !isNonEmptyString(rec.command)) continue;
		if (seen.has(rec.id)) continue;
		seen.add(rec.id);
		out.push({
			id: rec.id,
			name: rec.name.trim(),
			command: rec.command.trim(),
			icon: resolveProjectActionIcon(isNonEmptyString(rec.icon) ? rec.icon : DEFAULT_ACTION_ICON),
			...(rec.autoOpenUrl === true ? { autoOpenUrl: true } : {}),
		});
		if (out.length >= MAX_ACTIONS) break;
	}
	return out;
}

/** Minimal storage seam (localStorage in the renderer; injectable for tests). */
export interface ActionStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

function defaultStorage(): ActionStorage | null {
	return typeof localStorage === "undefined" ? null : localStorage;
}

/** Read the custom actions saved for a project cwd; empty list when
 *  nothing/unusable is stored (missing storage must not break the menu). */
export function readProjectActions(cwd: string, storage: ActionStorage | null = defaultStorage()): ProjectAction[] {
	if (!cwd || !storage) return [];
	try {
		const raw = storage.getItem(`${ACTIONS_KEY_PREFIX}${cwd}`);
		return parseProjectActions(raw ? JSON.parse(raw) : null);
	} catch {
		return [];
	}
}

/** Persist the custom actions for a project cwd (sanitized on write). */
export function writeProjectActions(
	cwd: string,
	actions: ProjectAction[],
	storage: ActionStorage | null = defaultStorage(),
): void {
	if (!cwd || !storage) return;
	try {
		storage.setItem(`${ACTIONS_KEY_PREFIX}${cwd}`, JSON.stringify(parseProjectActions(actions)));
	} catch {
		// storage unavailable / quota exceeded
	}
}

let actionIdCounter = 0;

/** Collision-safe-enough id for a locally stored action. */
export function makeProjectActionId(): string {
	actionIdCounter = (actionIdCounter + 1) % 1_000_000;
	return `action-${Date.now().toString(36)}-${actionIdCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
