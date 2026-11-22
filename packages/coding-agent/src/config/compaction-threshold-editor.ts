import { type ModelCompactionThresholdEntry, parseCompactionPointInput } from "./compaction-threshold";

/** One editable row of `compaction.modelThresholds`. */
export interface ModelThresholdRow {
	/** `provider/model-id` or a `provider/*` prefix. */
	key: string;
	/** Persisted entry as text the editor reads back (`80%`, `f90000`, `400000`). */
	value: string;
}

const KEY_PATTERN = /^[^\s/*]+\/[^\s*]+(?:\/\*)?$/;

/** Why `key` is not a usable selector, or undefined when it is. */
export function modelThresholdKeyError(key: string): string | undefined {
	const text = key.trim();
	if (text.length === 0) return "empty key";
	if (!KEY_PATTERN.test(text)) return "expected `provider/model-id` or a `provider/*` prefix";
	return undefined;
}

/** A persisted entry as the editor's text; an unparsable entry keeps its raw form. */
export function modelThresholdEntryText(entry: ModelCompactionThresholdEntry | undefined): string {
	if (entry === null || entry === undefined) return "";
	if (typeof entry === "number") return String(entry);
	return entry;
}

/**
 * Validate and normalize one edited row. Returns the persisted entry, or the
 * error that keeps the row from being saved.
 */
export function normalizeModelThresholdRow(key: string, value: string): { entry: number | string } | { error: string } {
	const keyError = modelThresholdKeyError(key);
	if (keyError) return { error: `Invalid model selector "${key.trim()}": ${keyError}` };
	const text = value.trim();
	if (text.length === 0) return { error: `Invalid trigger for "${key.trim()}": value is required` };
	try {
		const entry = parseCompactionPointInput(text);
		if (entry === null) return { error: `Invalid trigger for "${key.trim()}": value is required` };
		return { entry };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** Every selection in the map as rows, stable by key order. */
export function modelThresholdRows(
	map: Record<string, ModelCompactionThresholdEntry> | undefined,
): ModelThresholdRow[] {
	const rows: ModelThresholdRow[] = [];
	for (const [key, entry] of Object.entries(map ?? {})) {
		if (entry === null || entry === undefined) continue;
		rows.push({ key, value: modelThresholdEntryText(entry) });
	}
	return rows;
}

/** The map with one row set (or removed when its entry is null). */
export function setModelThresholdRow(
	map: Record<string, ModelCompactionThresholdEntry>,
	key: string,
	entry: number | string | null,
): Record<string, ModelCompactionThresholdEntry> {
	const next = { ...map };
	if (entry === null) delete next[key];
	else next[key] = entry;
	return next;
}
