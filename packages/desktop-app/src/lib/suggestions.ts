import { type TranslationKey, t } from "@musepi/client-core";

/**
 * Empty-state composer draft suggestions (openchamber DraftPresetChips
 * parity). Built-in entries are i18n-keyed so labels/prompts localize at
 * render; custom entries carry literal text. The persisted list lives in
 * localStorage (musepi-gui-suggestions) and changes broadcast via
 * SUGGESTIONS_CHANGED_EVENT so the welcome composer updates live.
 */

/** Built-in draft suggestion: i18n keys, localized at render time. */
export interface SuggestionDef {
	labelKey: TranslationKey;
	promptKey: TranslationKey;
}

/** Default collapsed set — the first 8 chips under the empty composer. */
export const DEFAULT_SUGGESTIONS: SuggestionDef[] = [
	{ labelKey: "general.chipExploreCodebase", promptKey: "general.suggestExploreCodebase" },
	{ labelKey: "general.chipCatchMeUp", promptKey: "general.suggestCatchMeUp" },
	{ labelKey: "general.chipWeighOptions", promptKey: "general.suggestWeighOptions" },
	{ labelKey: "general.chipStartFeaturePlanning", promptKey: "general.suggestStartFeaturePlanning" },
	{ labelKey: "general.chipCreateGoal", promptKey: "general.suggestCreateGoal" },
	{ labelKey: "general.chipScheduleTask", promptKey: "general.suggestScheduleTask" },
	{ labelKey: "general.chipDebugIssue", promptKey: "general.suggestDebugIssue" },
	{ labelKey: "general.chipReviewChanges", promptKey: "general.suggestReviewChanges" },
];

/** Extra suggestions revealed by the + expansion. */
export const EXTRA_SUGGESTIONS: SuggestionDef[] = [
	{ labelKey: "general.chipWriteTests", promptKey: "general.suggestWriteTests" },
	{ labelKey: "general.chipRefactor", promptKey: "general.suggestRefactor" },
	{ labelKey: "general.chipPerformance", promptKey: "general.suggestPerformance" },
	{ labelKey: "general.chipWebSearch", promptKey: "general.suggestWebSearch" },
	{ labelKey: "general.chipGenerateImage", promptKey: "general.suggestGenerateImage" },
	{ labelKey: "general.chipCreateBoard", promptKey: "general.suggestCreateBoard" },
	{ labelKey: "general.chipDrawDiagram", promptKey: "general.suggestDrawDiagram" },
];

/** A stored suggestion: builtin (i18n-keyed) or custom (literal text). */
export type StoredSuggestion =
	| { labelKey: TranslationKey; promptKey: TranslationKey }
	| { label: string; prompt: string };

export const SUGGESTIONS_STORAGE_KEY = "musepi-gui-suggestions";
export const SUGGESTIONS_CHANGED_EVENT = "musepi-gui-suggestions-changed";

/** How many chips show before the + expansion. */
export const SUGGESTIONS_COLLAPSED_COUNT = DEFAULT_SUGGESTIONS.length;

export function isBuiltinSuggestion(s: StoredSuggestion): s is { labelKey: TranslationKey; promptKey: TranslationKey } {
	return "labelKey" in s;
}

/** Resolve a stored suggestion to renderable label + inserted prompt. */
export function resolveSuggestion(s: StoredSuggestion): {
	label: string;
	prompt: string;
	builtin: boolean;
} {
	if (isBuiltinSuggestion(s)) {
		return { label: t(s.labelKey), prompt: t(s.promptKey), builtin: true };
	}
	return { label: s.label, prompt: s.prompt, builtin: false };
}

/** Default persisted list (builtins only, in display order). */
export function defaultSuggestions(): StoredSuggestion[] {
	return [...DEFAULT_SUGGESTIONS, ...EXTRA_SUGGESTIONS].map(s => ({
		labelKey: s.labelKey,
		promptKey: s.promptKey,
	}));
}

function sanitize(raw: unknown): StoredSuggestion[] | null {
	if (!Array.isArray(raw) || raw.length === 0) return null;
	const out: StoredSuggestion[] = [];
	for (const item of raw) {
		if (item && typeof item === "object") {
			const o = item as Record<string, unknown>;
			if (typeof o.labelKey === "string" && typeof o.promptKey === "string") {
				out.push({ labelKey: o.labelKey as TranslationKey, promptKey: o.promptKey as TranslationKey });
			} else if (typeof o.label === "string" && typeof o.prompt === "string") {
				out.push({ label: o.label, prompt: o.prompt });
			}
		}
	}
	return out.length > 0 ? out : null;
}

/** Plugin seam (renderer-side): modules can contribute extra suggestion
 *  chips, merged AFTER the user list so user ordering always wins. The
 *  contributions are ephemeral (never persisted) and live-refresh the
 *  composer via SUGGESTIONS_CHANGED_EVENT. A daemon-side extensions kind
 *  ("suggestion", surfaced through extensions.list) can later feed the
 *  same registry — GUI keeps this one merge point. */
const contributors = new Set<() => StoredSuggestion[]>();

export function addSuggestionContributor(fn: () => StoredSuggestion[]): () => void {
	contributors.add(fn);
	window.dispatchEvent(new CustomEvent(SUGGESTIONS_CHANGED_EVENT));
	return () => {
		contributors.delete(fn);
		window.dispatchEvent(new CustomEvent(SUGGESTIONS_CHANGED_EVENT));
	};
}

/** The user's own list (settings 预设提示词 edits / reorder only). */
export function loadUserSuggestions(): StoredSuggestion[] {
	try {
		const raw = localStorage.getItem(SUGGESTIONS_STORAGE_KEY);
		if (!raw) return defaultSuggestions();
		return sanitize(JSON.parse(raw) as unknown) ?? defaultSuggestions();
	} catch {
		return defaultSuggestions();
	}
}

/** Composer list: user list + plugin contributions (read-only, appended). */
export function loadSuggestions(): StoredSuggestion[] {
	const base = loadUserSuggestions();
	if (contributors.size === 0) return base;
	return [...base, ...[...contributors].flatMap(fn => fn())];
}

export function saveSuggestions(list: StoredSuggestion[]): void {
	try {
		localStorage.setItem(SUGGESTIONS_STORAGE_KEY, JSON.stringify(list));
	} catch {
		// storage unavailable — in-memory only
	}
	window.dispatchEvent(new CustomEvent(SUGGESTIONS_CHANGED_EVENT));
}

export function resetSuggestions(): void {
	try {
		localStorage.removeItem(SUGGESTIONS_STORAGE_KEY);
	} catch {
		// storage unavailable
	}
	window.dispatchEvent(new CustomEvent(SUGGESTIONS_CHANGED_EVENT));
}
