/**
 * Shortcut registry (kimicode 快捷键面板 parity) — one editable source of
 * truth for the window-level keybindings instead of the old hardcoded
 * `mod && k === "n"` chain in app.tsx plus a static read-only table in
 * settings. Each entry carries a stable id, i18n label/description keys and
 * a mac-form default ("⌘N", "⌘⇧E"); users may rebind editable entries from
 * 设置 → 快捷键 (capture-the-next-press), overrides persist in localStorage,
 * and `eventMatches` lets the keydown handlers stay declarative.
 *
 * Fixed entries (Esc 停止, ⌘1–8 面板切换) are displayed for reference but
 * not editable — their semantics are wired into gesture/state machines that
 * a plain rebinding cannot express safely.
 */

import { shortcutLabel } from "./shortcuts";

export interface ShortcutEntry {
	id: string;
	/** i18n key for the row title. */
	labelKey: string;
	/** i18n key for the kimicode-style one-line description. */
	descKey: string;
	/** mac-form default ("⌘N" | "⌘⇧E" | "⌘," | "⎋"). */
	def: string;
	/** Rebindable from 设置 → 快捷键. */
	editable: boolean;
	/**
	 * Optional group heading in the settings list (i18n key). Keeps the long
	 * flat kimicode list scannable.
	 */
	groupKey?: string;
}

export const SHORTCUTS: readonly ShortcutEntry[] = [
	{
		id: "new-task",
		labelKey: "new task shortcut",
		descKey: "new task shortcut desc",
		def: "⌘N",
		editable: true,
		groupKey: "shortcut group session",
	},
	{
		id: "search",
		labelKey: "search shortcut",
		descKey: "search shortcut desc",
		def: "⌘K",
		editable: true,
		groupKey: "shortcut group session",
	},
	{
		id: "settings",
		labelKey: "settings shortcut",
		descKey: "settings shortcut desc",
		def: "⌘,",
		editable: true,
		groupKey: "shortcut group session",
	},
	{
		id: "open-folder",
		labelKey: "open folder shortcut",
		descKey: "open folder shortcut desc",
		def: "⌘O",
		editable: true,
		groupKey: "shortcut group session",
	},
	{
		id: "capture-screen",
		labelKey: "capture screen shortcut",
		descKey: "capture screen shortcut desc",
		def: "⌘⇧S",
		editable: true,
		groupKey: "shortcut group composer",
	},
	{
		id: "send",
		labelKey: "send message shortcut",
		descKey: "send message shortcut desc",
		def: "⌘↩",
		editable: true,
		groupKey: "shortcut group composer",
	},
	{
		id: "quote",
		labelKey: "quote selection shortcut",
		descKey: "quote selection shortcut desc",
		def: "⌘L",
		editable: true,
		groupKey: "shortcut group selection",
	},
	{
		id: "ask",
		labelKey: "ask selection shortcut",
		descKey: "ask selection shortcut desc",
		def: "⌘⇧L",
		editable: true,
		groupKey: "shortcut group selection",
	},
	{
		id: "toggle-sidebar",
		labelKey: "toggle sidebar shortcut",
		descKey: "toggle sidebar shortcut desc",
		def: "⌘B",
		editable: true,
		groupKey: "shortcut group layout",
	},
	{
		id: "toggle-panel",
		labelKey: "toggle panel shortcut",
		descKey: "toggle panel shortcut desc",
		def: "⌘E",
		editable: true,
		groupKey: "shortcut group layout",
	},
	{
		id: "toggle-terminal",
		labelKey: "toggle terminal shortcut",
		descKey: "toggle terminal shortcut desc",
		def: "⌘J",
		editable: true,
		groupKey: "shortcut group layout",
	},
	{
		id: "focus-mode",
		labelKey: "focus mode shortcut",
		descKey: "focus mode shortcut desc",
		def: "⌘⇧E",
		editable: true,
		groupKey: "shortcut group layout",
	},
	{
		id: "panel-surfaces",
		labelKey: "panel surfaces shortcut",
		descKey: "panel surfaces shortcut desc",
		def: "⌘1–8",
		editable: false,
		groupKey: "shortcut group layout",
	},
	{
		id: "scroll-transcript",
		labelKey: "scroll transcript shortcut",
		descKey: "scroll transcript shortcut desc",
		def: "⌘↓",
		editable: true,
		groupKey: "shortcut group transcript",
	},
	{
		id: "stop",
		labelKey: "stop agent shortcut",
		descKey: "stop agent shortcut desc",
		def: "⎋",
		editable: false,
		groupKey: "shortcut group transcript",
	},
];

const STORAGE_KEY = "musepi.shortcut-bindings.v1";

export const SHORTCUTS_CHANGED_EVENT = "musepi-shortcuts-changed";

function loadOverrides(): Record<string, string> {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw) as unknown;
		if (parsed === null || typeof parsed !== "object") return {};
		return parsed as Record<string, string>;
	} catch {
		return {};
	}
}

function saveOverrides(overrides: Record<string, string>): void {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
}

export function getEntry(id: string): ShortcutEntry | undefined {
	return SHORTCUTS.find(s => s.id === id);
}

/** Effective binding for an id (override ?? default), mac form. */
export function getBinding(id: string): string {
	const entry = getEntry(id);
	if (!entry) return "";
	return loadOverrides()[id] ?? entry.def;
}

/** Platform-aware label for chips and the attach menu. */
export function bindingLabel(id: string): string {
	const binding = getBinding(id);
	if (binding === "⎋") return "Esc";
	// shortcutLabel maps ⌘/⇧/⌥ to Ctrl/Shift/Alt off-macOS; swap the glyphs
	// that need word forms (↩ → Enter) and keep ranges (⌘1–8) as-is.
	return shortcutLabel(binding).replace("↩", "Enter");
}

/** Minimal keydown shape — satisfied by both DOM and React synthetic events. */
export interface ShortcutKeyEvent {
	key: string;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
}

/**
 * Normalize a keydown event into the canonical mac-form binding string, or
 * null when the press carries no primary modifier (plain keys are not
 * bindable — every shortcut here is a mod combo; Esc is fixed).
 */
export function normalizeEvent(e: ShortcutKeyEvent): string | null {
	const mod = e.metaKey || e.ctrlKey;
	if (!mod) return null;
	let out = "⌘";
	if (e.altKey) out += "⌥";
	if (e.shiftKey) out += "⇧";
	const key = e.key;
	if (key === " ") return `${out}Space`;
	if (["Meta", "Control", "Shift", "Alt"].includes(key)) return null;
	if (key === "Enter") return `${out}↩`;
	if (key === "Escape") return `${out}⎋`;
	if (key === ",") return `${out},`;
	if (key.length === 1) return `${out}${key.toUpperCase()}`;
	return `${out}${key.toLowerCase()}`;
}

/** Does this keydown event fire the given shortcut? */
export function eventMatches(e: ShortcutKeyEvent, id: string): boolean {
	const binding = getBinding(id);
	const pressed = normalizeEvent(e);
	if (pressed === null || binding === "") return false;
	if (binding.includes("–")) {
		// Range binding (⌘1–8): match the base digit row.
		const m = /^⌘(\d)–(\d)$/.exec(binding);
		if (!m) return false;
		const lo = Number(m[1]);
		const hi = Number(m[2]);
		if (!/^\d$/.test(e.key)) return false;
		const d = Number(e.key);
		return d >= lo && d <= hi && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
	}
	return pressed === binding;
}

/**
 * Rebind an entry. `binding` is the canonical mac form from normalizeEvent,
 * or null to reset to default. Refuses conflicts (another entry already
 * holds the binding) with the conflicting entry id. Returns
 * { ok:true } | { ok:false, conflict:id }.
 */
export function setBinding(id: string, binding: string | null): { ok: boolean; conflict?: string } {
	const entry = getEntry(id);
	if (!entry || !entry.editable) return { ok: false };
	if (binding !== null) {
		for (const other of SHORTCUTS) {
			if (other.id === id) continue;
			if (getBinding(other.id) === binding) return { ok: false, conflict: other.id };
		}
	}
	const overrides = loadOverrides();
	if (binding === null || binding === entry.def) delete overrides[id];
	else overrides[id] = binding;
	saveOverrides(overrides);
	if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(SHORTCUTS_CHANGED_EVENT));
	return { ok: true };
}

/** True when the entry currently deviates from its default. */
export function isOverridden(id: string): boolean {
	return loadOverrides()[id] !== undefined;
}
