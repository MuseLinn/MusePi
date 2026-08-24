import { setLocale, type TranslationKey, t } from "@musepi/desktop-web"
import { GuiSelect } from "./GuiSelect";
import { type ReactNode, useState } from "react";
import { Reveal } from "./Reveal";

/**
 * UI metadata for one setting, as returned by the daemon's
 * settings.schema RPC (the same single source of truth the TUI settings
 * panel renders — the GUI must not drift from it).
 */
export interface SchemaUi {
	tab?: string;
	group?: string;
	label?: string;
	description?: string;
	condition?: string;
	/** Terminal-only effect (UiBase.tuiOnly in settings-schema.ts): the
	 * setting only affects the TUI; the desktop panel lists it muted. */
	tuiOnly?: boolean;
	options?: readonly { value: string; label: string; description?: string }[] | "runtime";
	secret?: boolean;
	ordered?: boolean;
}

export interface SchemaItem {
	key: string;
	type: "boolean" | "enum" | "string" | "number" | "array" | "record";
	default?: unknown;
	/** Daemon-resolved choices for `ui.options === "runtime"` keys
	 * (theme.dark/theme.light → the TUI theme registry). */
	runtimeOptions?: string[];
	ui?: SchemaUi;
}

/**
 * Condition gates mirrored from the TUI's CONDITIONS map
 * (packages/coding-agent/src/modes/components/settings-defs.ts) — the
 * daemon schema sends the condition NAME, the GUI evaluates it against
 * the fetched values. Unknown names default to visible (parity-safe).
 */
const CONDITIONS: Record<string, (values: Record<string, unknown>) => boolean> = {
	mnemopiActive: v => v["memory.backend"] === "mnemopi",
	hindsightActive: v => v["memory.backend"] === "hindsight",
	autolearnActive: v => v["autolearn.enabled"] === true,
	advisorEnabled: v => v["advisor.enabled"] === true,
	autoThinkingActive: v => v.defaultThinkingLevel === "auto",
	usageAwareFallbackEnabled: v => v["retry.usageAwareFallback"] === true,
	planModeEnabled: v => v["plan.enabled"] === true,
	lspActive: v => v["lsp.enabled"] === true,
	summarizeActive: v => v["read.summarize.enabled"] === true,
	// TUI semantics: `hasImageProtocol` is a terminal-capability probe
	// (kitty/icat). The desktop renders images inline in the transcript
	// regardless, so it resolves true here.
	hasImageProtocol: () => true,
	unexpectedStopDetection: v => v["features.unexpectedStopDetection"] === true,
};

/**
 * Record-typed setting (retry.fallbackChains, tools.approval,
 * providers.maxInFlightRequests…): edited as compact JSON, committed on
 * blur. Invalid JSON shows an inline warning and keeps the stored value.
 */
function RecordInput({
	item,
	value,
	onChange,
}: {
	item: SchemaItem;
	value: unknown;
	onChange(key: string, value: unknown): void;
}): ReactNode {
	const [err, setErr] = useState(false);
	return (
		<div className="flex flex-col items-end gap-1">
			<input
				type="text"
				spellCheck={false}
				className={`gui-settings-select !w-auto max-w-[260px] font-mono text-[12px]${err ? " !border-[var(--color-warning)]" : ""}`}
				placeholder={`{"key": "value"}`}
				defaultValue={value && typeof value === "object" ? JSON.stringify(value) : ""}
				key={`${item.key}:${JSON.stringify(value)}`}
				onBlur={e => {
					const raw = e.target.value.trim();
					if (raw === "") {
						onChange(item.key, {});
						setErr(false);
						return;
					}
					try {
						onChange(item.key, JSON.parse(raw));
						setErr(false);
					} catch {
						setErr(true);
					}
				}}
			/>
			{err && <span className="text-[11px] text-[var(--color-warning)]">{t("invalid json")}</span>}
		</div>
	);
}

/**
 * Generic settings renderer driven by daemon schema metadata.
 * Boolean → toggle, enum → select, string → input (credentials render
 * masked and keep the stored value unless replaced), number → input.
 * Labels/descriptions resolve through the app locale (t()), falling
 * back to the schema's English text when untranslated.
 *
 * Rows marked `ui.tuiOnly` (terminal-only effect) render after the
 * GUI-effective rows in a muted block with an explanatory note and a
 * per-row "仅 TUI 生效" badge — still editable (they configure the TUI),
 * but never presented as if they affect the desktop UI.
 */
export function SchemaSettings({
	items,
	values,
	onChange,
	error,
	renderExtra,
}: {
	items: SchemaItem[];
	values: Record<string, unknown>;
	onChange(key: string, value: unknown): void;
	error?: string | null;
	/** Optional per-key extra renderer under a row (e.g. the task-card-style
	 *  preview). Third arg is the row's commit(key, value) so the extra can
	 *  act as the control (click-to-switch preview). When it renders for a
	 *  key, the row's standard control (select/toggle) is hidden — the extra
	 *  IS the control. */
	renderExtra?(key: string, value: unknown, commit: (key: string, value: unknown) => void): ReactNode;
}): ReactNode {
	const isCredential = (item: SchemaItem): boolean => {
		// Credential keys are masked by convention (daemon never echoes
		// them back — values[key] is undefined here even when stored).
		return item.type === "string" && /api[_-]?key|token|secret/i.test(item.key);
	};
	// settings.locale (daemon interface language) also flips the renderer
	// locale so the 交互 tab row and the 常规 select stay consistent —
	// config.yml is the single source, localStorage a render mirror (F1).
	const commit = (key: string, value: unknown): void => {
		if (key === "settings.locale" && (value === "zh-CN" || value === "en-US")) setLocale(value);
		onChange(key, value);
		// Live consumers (ChatView transcript prefs, recap, …) re-read the
		// daemon settings on this event instead of polling.
		window.dispatchEvent(new CustomEvent("omp-settings-changed", { detail: { key } }));
	};

	const shown = (item: SchemaItem): boolean => {
		const cond = item.ui?.condition;
		return !cond || (CONDITIONS[cond]?.(values) ?? true);
	};

	// Preserve schema order, grouping rows under their ui.group headings.
	const renderGroups = (list: SchemaItem[], tui: boolean): ReactNode => {
		const groups = new Map<string, SchemaItem[]>();
		for (const item of list) {
			const g = item.ui?.group ?? "";
			const rows = groups.get(g) ?? [];
			rows.push(item);
			groups.set(g, rows);
		}
		return (
			<>
				{[...groups.entries()].map(([group, rows]) => {
					// Condition-gated rows (memory backend, LSP/summarize
					// toggles…): hidden rows animate in/out via the shared
					// Reveal standard. The GROUP is a Reveal too — a group whose
					// items are ALL hidden (e.g. the whole Hindsight block while
					// another backend is selected) collapses heading + rows as one
					// unit instead of popping into existence; groups with any
					// visible item stay open and only their rows animate.
					const visible = rows.filter(shown);
					return (
						<Reveal key={group || "__root"} open={visible.length > 0}>
							{group !== "" && <div className="gui-settings-group-h">{t(group as TranslationKey)}</div>}
							{rows.map(item => {
								const value = values[item.key] ?? item.default;
								const label = item.ui?.label ?? item.key;
								const desc = item.ui?.description;
								const credential = isCredential(item);
								const cond = item.ui?.condition;
								const rowShown = !cond || (CONDITIONS[cond]?.(values) ?? true);
								// Custom per-key extra (e.g. the click-to-switch
								// task-card-style preview): when it renders, it
								// IS the control — hide the standard one.
								const extra = renderExtra?.(item.key, value, commit);
								const hasExtra = extra !== undefined && extra !== null;
								return (
									<Reveal key={item.key} open={rowShown}>
										<div className={`gui-settings-row${tui ? " gui-settings-row--tui" : ""}`}>
											<div className="min-w-0 flex-1">
												<div className="gui-settings-row-label">
													{t(label as TranslationKey)}
													{tui && <span className="gui-settings-tui-badge">{t("tui only")}</span>}
												</div>
												{desc && (
													<div className="text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
														{t(desc as TranslationKey)}
													</div>
												)}
											</div>
											{!hasExtra ? (
												item.type === "boolean" ? (
													<button
														type="button"
														role="switch"
														aria-checked={value === true}
														className={`gui-toggle${value === true ? " gui-toggle--on" : ""}`}
														onClick={() => commit(item.key, value !== true)}
													>
														<span className="gui-toggle-knob" />
													</button>
												) : item.type === "enum" && Array.isArray(item.ui?.options) ? (
													<GuiSelect
														className="gui-settings-select !w-auto max-w-[240px]"
														value={typeof value === "string" ? value : ""}
														onChange={v => commit(item.key, v)}
														options={item.ui.options.map(opt => ({
															value: opt.value,
															label: t(opt.label as TranslationKey),
														}))}
													/>
												) : item.ui?.options === "runtime" ? (
													// Runtime-populated select (TUI theme registry):
													// the daemon resolves the list into
													// runtimeOptions, so the GUI renders a real
													// select. Without the list (older daemon) it
													// falls back to a read-only input — typing a
													// bogus id would corrupt config.yml (F3 audit).
													Array.isArray(item.runtimeOptions) && item.runtimeOptions.length > 0 ? (
														<GuiSelect
															className="gui-settings-select !w-auto max-w-[240px]"
															value={typeof value === "string" ? value : ""}
															onChange={v => commit(item.key, v)}
															options={(() => {
																const opts = item.runtimeOptions.map(o => ({ value: o, label: o }));
																// Keep a stored value not in the registry selectable
																if (typeof value === "string" && value !== "" && !item.runtimeOptions.includes(value)) {
																	opts.push({ value, label: value });
																}
																return opts;
															})()}
														/>
													) : (
														<input
															type="text"
															className="gui-settings-select !w-auto max-w-[240px]"
															value={typeof value === "string" ? value : ""}
															disabled
															title={t("options come from the TUI runtime")}
														/>
													)
												) : item.type === "number" ? (
													<input
														type="number"
														className="gui-settings-select !w-auto max-w-[120px]"
														value={typeof value === "number" ? value : 0}
														onChange={e => commit(item.key, Number(e.target.value))}
													/>
												) : item.type === "array" ? (
													<input
														type="text"
														className="gui-settings-select !w-auto max-w-[240px]"
														placeholder={t("comma separated values")}
														defaultValue={Array.isArray(value) ? value.join(", ") : ""}
														key={`${item.key}:${Array.isArray(value) ? value.join(",") : ""}`}
														onBlur={e =>
															commit(
																item.key,
																e.target.value
																	.split(",")
																	.map(s => s.trim())
																	.filter(Boolean),
															)
														}
													/>
												) : item.type === "record" ? (
													<RecordInput item={item} value={value} onChange={commit} />
												) : (
													<input
														type={credential ? "password" : "text"}
														className="gui-settings-select !w-auto max-w-[240px]"
														placeholder={
															credential
																? t("keep stored credential unless replaced")
																: typeof item.default === "string"
																	? item.default
																	: undefined
														}
														defaultValue={credential ? "" : typeof value === "string" ? value : ""}
														key={`${item.key}:${String(value)}`}
														onBlur={e => {
															if (credential && e.target.value === "") return; // keep stored
															commit(item.key, e.target.value);
														}}
													/>
												)
											) : null}
											{extra !== undefined && extra !== null ? (
												<div className="gui-settings-row-extra">{extra}</div>
											) : null}
										</div>
									</Reveal>
								);
							})}
						</Reveal>
					);
				})}
			</>
		);
	};

	// Terminal-only rows are split out AFTER the GUI-effective ones so the
	// desktop user sees at a glance which options actually affect the GUI.
	// The block starts collapsed — 28 of the 30 appearance rows are TUI-only
	// and would otherwise bury the two GUI-effective ones.
	const tuiItems = items.filter(item => item.ui?.tuiOnly);
	const guiItems = items.filter(item => !item.ui?.tuiOnly);
	const [tuiOpen, setTuiOpen] = useState(false);

	return (
		<>
			{error && <div className="px-1 pb-1 text-[12.5px] text-[var(--color-warning)]">{error}</div>}
			{renderGroups(guiItems, false)}
			{tuiItems.length > 0 && (
				<div className="gui-settings-tui-block">
					<button
						type="button"
						className="gui-settings-tui-header"
						aria-expanded={tuiOpen}
						onClick={() => setTuiOpen(o => !o)}
					>
						<span className="gui-settings-tui-heading">{t("terminal only settings")}</span>
						<span className="gui-settings-tui-count">{tuiItems.length}</span>
						<span
							className={`gui-settings-tui-chevron${tuiOpen ? " gui-settings-tui-chevron--open" : ""}`}
							aria-hidden
						>
							▸
						</span>
					</button>
					<div className="gui-settings-tui-note">{t("terminal only settings note")}</div>
					<Reveal open={tuiOpen}>
						<div className="gui-settings-tui-rows">{renderGroups(tuiItems, true)}</div>
					</Reveal>
				</div>
			)}
		</>
	);
}
