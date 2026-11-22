import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";

type ThresholdEntry = number | string | null;

/** One editable row: `provider/model-id` (or `provider/*`) and its trigger. */
interface ThresholdRow {
	key: string;
	value: string;
}

// `provider/model-id`, an optional model path segment, or a trailing `/*` prefix.
const KEY_PATTERN = /^[^\s/*]+\/(?:[^\s/*]+\/)*\*?[^\s*]*$/;

function rowError(key: string, value: string): string | null {
	if (!KEY_PATTERN.test(key.trim())) return t("general.compactionEditorInvalidKey");
	const text = value.trim();
	if (text === "") return t("general.compactionEditorValueRequired");
	if (text.endsWith("%")) {
		const percent = Number(text.slice(0, -1));
		return percent > 0 && percent <= 100 ? null : t("general.compactionEditorInvalidValue");
	}
	return /^(?:f)?\d+(?:[kmb])?$/i.test(text) ? null : t("general.compactionEditorInvalidValue");
}

const SCALE: Record<string, number> = { k: 1_000, m: 1_000_000, b: 1_000_000_000 };

/** The persisted entry for a validated row: `80%` stays text, `f90k` → `f90000`, `90k` → `90000`. */
function parseValue(text: string): ThresholdEntry {
	const trimmed = text.trim();
	if (trimmed.endsWith("%")) return trimmed;
	const match = /^(f)?(\d+)([kmb])?$/i.exec(trimmed);
	if (!match) return trimmed;
	const tokens = Number(match[2]) * (match[3] ? SCALE[match[3].toLowerCase()] : 1);
	return match[1] ? `f${tokens}` : tokens;
}

function entryText(entry: ThresholdEntry): string {
	return entry === null ? "" : String(entry);
}

/**
 * Per-model compaction thresholds as rows instead of a JSON blob: each row
 * names a `provider/model-id` (or `provider/*` prefix) and its trigger
 * (`80%`, `f90000`, `400000`). Writes the whole map back through the settings
 * row's commit, so undo/reset semantics stay on the schema item.
 */
export function CompactionThresholdRowEditor({
	value,
	onCommit,
}: {
	value: unknown;
	onCommit(next: Record<string, ThresholdEntry>): void;
}): ReactNode {
	const record =
		value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, ThresholdEntry>) : {};
	const rows = useMemo(
		() =>
			Object.entries(record)
				.filter(([, entry]) => entry !== null && entry !== undefined)
				.map(([key, entry]) => ({ key, value: entryText(entry) })),
		[record],
	);
	const [draft, setDraft] = useState<ThresholdRow>({ key: "", value: "" });
	const [error, setError] = useState<string | null>(null);

	const save = (): void => {
		const message = rowError(draft.key, draft.value);
		if (message) {
			setError(message);
			return;
		}
		const key = draft.key.trim();
		onCommit({ ...record, [key]: parseValue(draft.value) });
		setDraft({ key: "", value: "" });
		setError(null);
	};

	const remove = (key: string): void => {
		const next = { ...record };
		delete next[key];
		onCommit(next);
		setError(null);
	};

	return (
		<div className="gui-threshold-editor">
			{rows.length === 0 ? (
				<div className="gui-threshold-editor-empty">{t("general.compactionEditorEmpty")}</div>
			) : (
				<ul className="gui-threshold-editor-list">
					{rows.map(row => (
						<li key={row.key} className="gui-threshold-editor-row">
							<code className="gui-threshold-editor-key">{row.key}</code>
							<span className="gui-threshold-editor-value">{row.value}</span>
							<button
								type="button"
								className="gui-threshold-editor-remove"
								onClick={() => remove(row.key)}
								aria-label={`${t("general.compactionEditorRemove")} ${row.key}`}
							>
								×
							</button>
						</li>
					))}
				</ul>
			)}
			<div className="gui-threshold-editor-add">
				<input
					type="text"
					className="gui-settings-select"
					placeholder={t("general.compactionEditorKeyPlaceholder")}
					aria-label={t("general.compactionEditorModel")}
					value={draft.key}
					onChange={event => setDraft(d => ({ ...d, key: event.target.value }))}
				/>
				<input
					type="text"
					className="gui-settings-select gui-threshold-editor-trigger"
					placeholder={t("general.compactionEditorTriggerPlaceholder")}
					aria-label={t("general.compactionEditorValue")}
					value={draft.value}
					onChange={event => setDraft(d => ({ ...d, value: event.target.value }))}
					onKeyDown={event => {
						if (event.key === "Enter") save();
					}}
				/>
				<button type="button" className="gui-threshold-editor-save" onClick={save}>
					{t("general.compactionEditorSave")}
				</button>
			</div>
			{error && (
				<div className="gui-threshold-editor-error" role="alert">
					{error}
				</div>
			)}
		</div>
	);
}
