import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	arrayMove,
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { setLocale, type TranslationKey, t } from "@musepi/client-core";
import { type ReactNode, useState } from "react";
import { restrictToYAxis } from "../lib/dnd-axis";
import { sortOrderedOptions } from "../lib/ordered-options";
import { dispatchSettingsChanged } from "../lib/settings-events";
import { Icon } from "../vendor/oc-icons";
import { GuiSelect } from "./GuiSelect";
import { Reveal } from "./Reveal";
import { LadderSlider } from "./settings-controls/LadderSlider";
import { RollingNumber } from "./settings-controls/RollingNumber";
import { JsonListEditor, TextListEditor } from "./settings-controls/ValueLists";

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
	/** Dead/placeholder key (UiBase.hidden in settings-schema.ts): the
	 *  feature behind it does not exist yet, so no settings surface lists
	 *  it. The key stays readable/writable via config.yml. */
	hidden?: boolean;
	/** Terminal-only effect (UiBase.tuiOnly in settings-schema.ts): the
	 *  setting only affects the TUI; the desktop panel lists it muted. */
	tuiOnly?: boolean;
	options?: readonly { value: string; label: string; description?: string }[] | "runtime";
	secret?: boolean;
	ordered?: boolean;
	/** Element shape for free-form arrays (UiArray.item): `"record"` needs a
	 *  JSON list; strings get a row list. */
	item?: "string" | "record";
	/** Free-number affordance hints (UiNumber.min/max/step). */
	min?: number;
	max?: number;
	step?: number;
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

/** Resolve one row's visibility. Exported so a page can assert its condition
 *  overrides without mounting the whole settings surface. */
export function isSettingShown(
	item: Pick<SchemaItem, "ui">,
	values: Record<string, unknown>,
	conditions?: Record<string, (values: Record<string, unknown>) => boolean>,
): boolean {
	const cond = item.ui?.condition;
	if (!cond) return true;
	const evaluate = conditions?.[cond] ?? CONDITIONS[cond];
	// Unknown names stay visible (parity-safe), but a page that knows the
	// answer — e.g. the voice tab's plugin state — must win over that default.
	return evaluate ? evaluate(values) : true;
}

function sameSettingValue(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((entry, index) => sameSettingValue(entry, b[index]));
	}
	if (a && b && typeof a === "object" && typeof b === "object") {
		const keysA = Object.keys(a);
		const keysB = Object.keys(b);
		return (
			keysA.length === keysB.length &&
			keysA.every(key => sameSettingValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
		);
	}
	return false;
}

/** True when the stored value differs from the schema default — drives the
 *  row's reset affordance. A setting without a declared default has nothing to
 *  reset to. */
export function isSettingChanged(item: Pick<SchemaItem, "default">, value: unknown): boolean {
	if (item.default === undefined) return false;
	return !sameSettingValue(value, item.default);
}

/** Copy container defaults before writing them back: the schema object is
 *  shared with every render and must not become the live settings state. */
function defaultForReset(value: unknown): unknown {
	if (Array.isArray(value)) return [...value];
	if (value && typeof value === "object") return { ...(value as Record<string, unknown>) };
	return value;
}

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
			{err && <span className="text-[11px] text-[var(--color-warning)]">{t("settings.invalidJson")}</span>}
		</div>
	);
}

interface SchemaChoice {
	value: string;
	label: string;
	description?: string;
}

function selectedValues(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Declared choices translated for the app locale; stored values outside the
 *  declared set keep a fallback entry so nothing is silently dropped. */
function resolveChoices(item: SchemaItem, current: readonly string[]): SchemaChoice[] {
	const declared = (
		Array.isArray(item.ui?.options) ? item.ui.options : ([] as readonly SchemaChoice[])
	) as readonly SchemaChoice[];
	const choices: SchemaChoice[] = declared.map(opt => ({
		value: opt.value,
		label: t(opt.label as TranslationKey),
		description: opt.description ? t(opt.description as TranslationKey) : undefined,
	}));
	for (const v of current) {
		if (!choices.some(o => o.value === v)) choices.push({ value: v, label: v });
	}
	return choices;
}

/**
 * The control a schema row gets. Kept as a pure function so the mapping can be
 * asserted without mounting the panel.
 *
 * The vocabulary follows the setting's semantics, not its storage type: a
 * numeric setting with a declared preset ladder is a bounded choice (detent
 * slider), an unbounded one is a stepper (rolling counter), and a free-form
 * array is a list — never a comma-joined text field, which corrupts values
 * that contain commas (bash patterns, prompt text).
 */
export type SettingsControl =
	| "toggle"
	| "select"
	| "ladder"
	| "number"
	| "chips"
	| "ordered"
	| "list"
	| "json-list"
	| "record"
	| "text";

export function settingsControl(item: SchemaItem): SettingsControl {
	if (item.type === "boolean") return "toggle";
	if (item.type === "enum") {
		const declared = Array.isArray(item.ui?.options) && item.ui.options.length > 0;
		const runtime = item.ui?.options === "runtime" || (item.runtimeOptions?.length ?? 0) > 0;
		// An enum with neither is synthesized by the daemon; if it still
		// arrives bare there is nothing to choose from, so keep the old
		// free-text fallback instead of rendering an empty menu.
		return declared || runtime ? "select" : "text";
	}
	if (item.type === "number") {
		return Array.isArray(item.ui?.options) && item.ui.options.length > 0 ? "ladder" : "number";
	}
	if (item.type === "array") {
		if (Array.isArray(item.ui?.options) && item.ui.options.length > 0) {
			return item.ui.ordered === true ? "ordered" : "chips";
		}
		return item.ui?.item === "record" ? "json-list" : "list";
	}
	if (item.type === "record") return "record";
	return "text";
}

/** Declared numeric presets in ladder order (already translated). */
function numericLadder(item: SchemaItem): { value: number; label: string; description?: string }[] {
	const declared = Array.isArray(item.ui?.options) ? item.ui.options : [];
	const fallback = typeof item.default === "number" ? item.default : Number.NaN;
	return declared.flatMap(option => {
		const literal = Number(option.value);
		// TUI submenus spell the "use the default" stop as `default`; the
		// stored value is the setting's numeric sentinel (-1 for the
		// compaction thresholds). Keep that stop on the ladder permanently:
		// dropping it made the default reachable only while it happened to be
		// the current value.
		const value = Number.isFinite(literal) ? literal : option.value === "default" ? fallback : Number.NaN;
		if (!Number.isFinite(value)) return [];
		// A label equal to its value ("0.7") is a literal, not a translation
		// key: the i18n fallback strips everything before the first dot and
		// would render "7".
		const labelIsLiteral = option.label === option.value;
		return [
			{
				value,
				label: labelIsLiteral ? option.label : t(option.label as TranslationKey),
				description: option.description ? t(option.description as TranslationKey) : undefined,
			},
		];
	});
}

/**
 * Declared-membership array editor (TUI MultiSelectSubmenu parity): one
 * pressed chip per choice, click flips membership.
 *
 * Large option sets (the image URL backend list ships ~50 entries)
 * collapse to "selected chips + add dropdown": rendering every choice as
 * a chip buries the row and, under the segmented control's flex:1, squeezes
 * each chip down to its first character. Small sets keep every choice one
 * click away.
 */
function ArrayChipsEditor({
	item,
	value,
	commit,
}: {
	item: SchemaItem;
	value: unknown;
	commit(key: string, value: unknown): void;
}): ReactNode {
	const current = selectedValues(value);
	const opts = resolveChoices(item, current);
	const compact = opts.length > 8;
	const shown = compact ? opts.filter(o => current.includes(o.value)) : opts;
	const addable = opts.filter(o => !current.includes(o.value));
	return (
		<span className="gui-settings-chips">
			{shown.map(opt => {
				const on = current.includes(opt.value);
				return (
					<span key={opt.value} className="gui-seg-item">
						<button
							type="button"
							className={`gui-seg-btn${on ? " gui-seg-btn--active" : ""}`}
							aria-pressed={on}
							title={opt.description}
							onClick={() =>
								commit(item.key, on ? current.filter(v => v !== opt.value) : [...current, opt.value])
							}
						>
							{opt.label}
						</button>
					</span>
				);
			})}
			{compact && addable.length > 0 && (
				<GuiSelect
					className="gui-settings-chips-add"
					value=""
					ariaLabel={t("settings.add")}
					onChange={v => {
						if (v !== "") commit(item.key, [...current, v]);
					}}
					options={[{ value: "", label: t("settings.add") }, ...addable]}
				/>
			)}
		</span>
	);
}

/**
 * Ordered fallback editor (`ui.ordered`, TUI ordered-multiselect parity):
 * stored position IS the priority, so it renders as a numbered list. Rows
 * reorder by drag — the right-panel-tab gesture (dnd-kit: grab the handle, the
 * row lifts, slots open live). Keyboard: focus the handle, Space to lift,
 * ↑/↓ to move, Space to drop. Inline chips cannot hold this: five long method
 * names would squeeze the label column to one character per line.
 */
function OrderedListEditor({
	item,
	value,
	commit,
}: {
	item: SchemaItem;
	value: unknown;
	commit(key: string, value: unknown): void;
}): ReactNode {
	const current = selectedValues(value);
	const ranked = sortOrderedOptions(resolveChoices(item, current), current);
	const active = ranked.filter(o => current.includes(o.value));
	const inactive = ranked.filter(o => !current.includes(o.value));
	const addViaSelect = ranked.length > 8;

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);
	const onDragEnd = (event: DragEndEvent): void => {
		const from = String(event.active.id);
		const to = event.over ? String(event.over.id) : null;
		if (!to || from === to) return;
		const fromIndex = active.findIndex(option => option.value === from);
		const toIndex = active.findIndex(option => option.value === to);
		if (fromIndex < 0 || toIndex < 0) return;
		// The stored array IS the priority: commit the moved order as-is.
		commit(
			item.key,
			arrayMove(
				active.map(option => option.value),
				fromIndex,
				toIndex,
			),
		);
	};

	return (
		<span className="gui-ordered-editor">
			{active.length > 0 && (
				<DndContext
					sensors={sensors}
					collisionDetection={closestCenter}
					modifiers={[restrictToYAxis]}
					onDragEnd={onDragEnd}
				>
					<SortableContext items={active.map(option => option.value)} strategy={verticalListSortingStrategy}>
						<ol className="gui-ordered-list">
							{active.map((option, index) => (
								<SortableOrderedRow
									key={option.value}
									option={option}
									rank={index + 1}
									removeLabel={t("settings.removeOption")}
									onRemove={() =>
										commit(
											item.key,
											current.filter(v => v !== option.value),
										)
									}
								/>
							))}
						</ol>
					</SortableContext>
				</DndContext>
			)}
			{inactive.length > 0 &&
				(addViaSelect ? (
					<GuiSelect
						className="gui-settings-chips-add"
						value=""
						ariaLabel={t("settings.add")}
						onChange={v => {
							if (v !== "") commit(item.key, [...current, v]);
						}}
						options={[
							{ value: "", label: t("settings.add") },
							...inactive.map(o => ({ value: o.value, label: o.label })),
						]}
					/>
				) : (
					<span className="gui-ordered-add">
						{inactive.map(opt => (
							<button
								key={opt.value}
								type="button"
								className="gui-ordered-add-btn"
								title={opt.description}
								onClick={() => commit(item.key, [...current, opt.value])}
							>
								<span aria-hidden="true">+</span>
								{opt.label}
							</button>
						))}
					</span>
				))}
		</span>
	);
}

/** One priority row: the handle is the only drag activator, so clicking or
 *  selecting the row never starts a gesture. */
function SortableOrderedRow({
	option,
	rank,
	removeLabel,
	onRemove,
}: {
	option: { value: string; label: string; description?: string };
	rank: number;
	removeLabel: string;
	onRemove(): void;
}): ReactNode {
	const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
		id: option.value,
	});
	return (
		<li
			ref={setNodeRef}
			className={`gui-ordered-item${isDragging ? " gui-ordered-item--dragging" : ""}`}
			style={transform ? { transform: CSS.Transform.toString(transform), transition } : undefined}
		>
			<button
				type="button"
				ref={setActivatorNodeRef}
				className="gui-ordered-grip"
				{...attributes}
				{...listeners}
				aria-label={t("settings.dragReorder")}
				title={t("settings.dragReorder")}
			>
				<Icon name="draggable" className="h-3.5 w-3.5" />
			</button>
			<span className="gui-ordered-rank" aria-hidden="true">
				{rank}
			</span>
			<span className="gui-ordered-name" title={option.description}>
				{option.label}
			</span>
			<button
				type="button"
				className="gui-ordered-btn gui-ordered-btn--remove"
				aria-label={removeLabel}
				title={removeLabel}
				onClick={onRemove}
			>
				✕
			</button>
		</li>
	);
}

/**
 * Generic settings renderer driven by daemon schema metadata.
 *
 * The control follows the setting's semantics (see {@link settingsControl}):
 * boolean → toggle, enum → select (two choices slide as a segmented
 * control), numeric preset ladder → detent slider, free number → rolling
 * counter, declared-membership array → chips/priority list, free-form array →
 * value list (strings) or JSON list (records), string → input (credentials
 * render masked and keep the stored value unless replaced). Labels and
 * descriptions resolve through the app locale (t()), falling back to the
 * schema's English text when untranslated.
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
	conditions,
}: {
	items: SchemaItem[];
	values: Record<string, unknown>;
	onChange(key: string, value: unknown): void;
	error?: string | null;
	/** Per-tab overrides for condition names that depend on GUI-side state
	 *  (plugin registry, window capabilities) rather than on settings values. */
	conditions?: Record<string, (values: Record<string, unknown>) => boolean>;
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
		dispatchSettingsChanged(key);
	};

	const shown = (item: SchemaItem): boolean => isSettingShown(item, values, conditions);

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
								// Credentials never echo back (values[key] is undefined), so a
								// default comparison would flag every stored key as changed.
								const changed = !credential && isSettingChanged(item, value);
								// Must use the same evaluator as `visible` above: a
								// per-tab conditions override has to reach BOTH the
								// group collapse and the individual row, or a
								// plugin-disabled row stays visible via Reveal.
								const rowShown = shown(item);
								// Custom per-key extra (e.g. the click-to-switch
								// task-card-style preview): when it renders, it
								// IS the control — hide the standard one.
								const extra = renderExtra?.(item.key, value, commit);
								const hasExtra = extra !== undefined && extra !== null;
								const control = settingsControl(item);
								// Every array editor (chips, priority list, value list, JSON
								// list) is content-sized and wider than the control column;
								// it takes its own line so the label keeps a readable width.
								const wideControl = !hasExtra && item.type === "array";
								return (
									<Reveal key={item.key} open={rowShown}>
										<div
											data-setting-key={item.key}
											className={`gui-settings-row${tui ? " gui-settings-row--tui" : ""}${wideControl ? " gui-settings-row--wide-control" : ""}`}
										>
											<div className="min-w-0 flex-1">
												<div className="gui-settings-row-label">
													<span className="gui-settings-row-label-text">{t(label as TranslationKey)}</span>
													{tui && <span className="gui-settings-tui-badge">{t("settings.tuiOnly")}</span>}
													{changed && (
														<button
															type="button"
															className="gui-settings-row-reset"
															title={t("settings.resetToDefault")}
															aria-label={t("settings.resetToDefault")}
															onClick={() => commit(item.key, defaultForReset(item.default))}
														>
															<Icon name="restart" className="h-3.5 w-3.5" />
														</button>
													)}
												</div>
												{desc && (
													<div className="text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
														{t(desc as TranslationKey)}
													</div>
												)}
											</div>
											{!hasExtra ? (
												control === "toggle" ? (
													<button
														type="button"
														role="switch"
														aria-checked={value === true}
														className={`gui-toggle${value === true ? " gui-toggle--on" : ""}`}
														onClick={() => commit(item.key, value !== true)}
													>
														<span className="gui-toggle-knob" />
													</button>
												) : control === "select" && Array.isArray(item.ui?.options) ? (
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
																if (
																	typeof value === "string" &&
																	value !== "" &&
																	!item.runtimeOptions.includes(value)
																) {
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
															title={t("settings.optionsComeTuiRuntime")}
														/>
													)
												) : control === "ladder" ? (
													<LadderSlider
														steps={numericLadder(item)}
														value={typeof value === "number" && Number.isFinite(value) ? value : 0}
														onChange={next => commit(item.key, next)}
														ariaLabel={t(label as TranslationKey)}
													/>
												) : control === "number" ? (
													<RollingNumber
														value={typeof value === "number" && Number.isFinite(value) ? value : 0}
														onChange={next => commit(item.key, next)}
														min={item.ui?.min ?? 0}
														max={item.ui?.max}
														step={item.ui?.step}
														ariaLabel={t(label as TranslationKey)}
													/>
												) : control === "ordered" ? (
													<OrderedListEditor item={item} value={value} commit={commit} />
												) : control === "chips" ? (
													<ArrayChipsEditor item={item} value={value} commit={commit} />
												) : control === "json-list" ? (
													<JsonListEditor
														value={value}
														onChange={next => commit(item.key, next)}
														invalidLabel={t("settings.invalidJsonArray")}
														emptyHint={t("settings.listEmpty")}
														ariaLabel={t(label as TranslationKey)}
													/>
												) : control === "list" ? (
													<TextListEditor
														values={selectedValues(value)}
														onChange={next => commit(item.key, next)}
														placeholder={t("settings.valuePlaceholder")}
														emptyHint={t("settings.listEmpty")}
														addLabel={t("settings.addValue")}
														removeLabel={t("settings.removeValue")}
														ariaLabel={t(label as TranslationKey)}
													/>
												) : control === "record" ? (
													<RecordInput item={item} value={value} onChange={commit} />
												) : (
													<input
														type={credential ? "password" : "text"}
														className="gui-settings-select !w-auto max-w-[240px]"
														placeholder={
															credential
																? t("settings.keepStoredCredentialUnless")
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

	// Dead keys (ui.hidden) never render — not even in the TUI-only block:
	// the feature behind them does not exist, so presenting a control would
	// be a dead button. The schema item still arrives over the RPC; it is
	// filtered here so every SchemaTabSection consumer skips it uniformly.
	const visibleItems = items.filter(item => !item.ui?.hidden);
	// Terminal-only rows are split out AFTER the GUI-effective ones so the
	// desktop user sees at a glance which options actually affect the GUI.
	// The block starts collapsed — 28 of the 30 appearance rows are TUI-only
	// and would otherwise bury the two GUI-effective ones.
	const tuiItems = visibleItems.filter(item => item.ui?.tuiOnly);
	const guiItems = visibleItems.filter(item => !item.ui?.tuiOnly);
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
						<span className="gui-settings-tui-heading">{t("settings.terminalOnlySettings")}</span>
						<span className="gui-settings-tui-count">{tuiItems.length}</span>
						<span
							className={`gui-settings-tui-chevron${tuiOpen ? " gui-settings-tui-chevron--open" : ""}`}
							aria-hidden
						>
							▸
						</span>
					</button>
					<div className="gui-settings-tui-note">{t("settings.terminalOnlySettingsNote")}</div>
					<Reveal open={tuiOpen}>
						<div className="gui-settings-tui-rows">{renderGroups(tuiItems, true)}</div>
					</Reveal>
				</div>
			)}
		</>
	);
}
