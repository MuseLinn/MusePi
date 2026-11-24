import {
	DARK_THEME_PRESETS,
	getLocaleSnapshot,
	highlightToCodeHtml,
	LIGHT_THEME_PRESETS,
	Segmented,
	type SegmentedOption,
	setLocale,
	subscribeLocale,
	type ThemePreference,
	type TranslationKey,
	t,
	tLoose,
	type UiThemeId,
	UNIFIED_THEME_PRESETS,
	useAccentPreference,
	useThemePreference,
	useUiThemePreferences,
} from "@musepi/client-core";
import { Monitor as MonitorIcon, Moon as MoonIcon, Sun as SunIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
	applyCodeSize,
	applyCodeThemes,
	applyDensity,
	applyMonoFont,
	applyTerminalFont,
	applyTranscriptFont,
	applyUiFont,
	CODE_FONT_OPTIONS,
	CODE_LINES_KEY,
	CODE_THEME_DARK_KEY,
	CODE_THEME_LIGHT_KEY,
	CODE_WRAP_KEY,
	type CodeTheme,
	DARK_CODE_THEMES,
	DEFAULT_CODE_FONT,
	DEFAULT_DARK_CODE_THEME,
	DEFAULT_LIGHT_CODE_THEME,
	DEFAULT_TERMINAL_FONT,
	DEFAULT_TRANSCRIPT_FONT,
	DEFAULT_UI_FONT,
	DENSITY_KEY,
	EDITOR_FONT_KEY,
	LIGHT_CODE_THEMES,
	MONO_FONT_KEY,
	readTimeFormat,
	readWeekStart,
	TERMINAL_FONT_KEY,
	TERMINAL_FONT_OPTIONS,
	TIME_FMT_KEY,
	type TimeFormatPref,
	TRANSCRIPT_FONT_KEY,
	TRANSCRIPT_FONT_OPTIONS,
	UI_FONT_KEY,
	UI_FONT_OPTIONS,
	WEEK_START_KEY,
	type WeekStartPref,
} from "../../lib/appearance";
import type { BrandIconStyle } from "../../lib/brand-icon-style";
import { activeCompanionArt, BUILTIN_VECTOR_ART_ID } from "../../lib/companion";
import {
	COMPANION_ACCESSORIES,
	COMPANION_DECOR_FLAGS,
	type CompanionAccessory,
	type CompanionDecor,
	companionDecor,
	setCompanionAccessory,
	setCompanionDecorFlag,
} from "../../lib/companion-decor";
import { applyGlassMaterial } from "../../lib/glass";
import { nativeHighlight } from "../../lib/highlight";
import type { RpcClient } from "../../lib/rpc";
import { THEME_PRESET_LABEL } from "../../lib/theme-preset-labels";
import { useFloatingMenu } from "../../lib/use-floating-menu";
import { useScrollShadow } from "../../lib/use-scroll-shadow";
import { Icon } from "../../vendor/oc-icons";
import { AppRail, type RailItem } from "../AppRail";
import {
	AVATAR_PRESETS,
	avatarPresetId,
	PunkAvatar,
	randomPunkSeed,
	setPunkSeed,
	userPunkSeed,
} from "../avatar-presets";
import { ColorPickerPanel } from "../ColorPicker";
import { GuiSelect } from "../GuiSelect";
import { MockConversationPreview } from "../MockConversationPreview";
import { Reveal } from "../Reveal";
import { RightRail } from "../RightRail";
import {
	TURN_RAIL_CHANGED_EVENT,
	TURN_RAIL_SIDE_KEY,
	TURN_RAIL_STYLE_KEY,
	type TurnRailSide,
	type TurnRailStyle,
} from "../TurnRail";
import { ChatSection } from "./chat";
import { SchemaTabSection } from "./schema";
import { NumberStepper } from "./shared";

const ACCENT_SWATCH: Record<string, string> = {
	// The "follow theme" swatch paints the ACTIVE theme's own accent, so the
	// control shows what it does rather than a fixed color chip.
	theme: "var(--theme-accent)",
	brand: "#d9a441",
	mono: "#8a8a93",
	ocean: "#38bdf8",
	jade: "#44b782",
};

/** Accent preset → localized name (swatch tooltip/aria). */
const ACCENT_NAMES: Record<string, TranslationKey> = {
	theme: "settings.accentTheme",
	brand: "settings.accentBrand",
	mono: "settings.accentMono",
	ocean: "settings.accentOcean",
	jade: "settings.accentJade",
};

/** Motion budget: full springs / reduced / off (the `gui-motion-off` class
 * on <html> is what the CSS degrades on). */
const MOTION_SEGMENTS: SegmentedOption<"full" | "reduced" | "off">[] = [
	{ value: "full", label: t("settings.full") },
	{ value: "reduced", label: t("settings.reduced") },
	{ value: "off", label: t("settings.off") },
];

/** Separate light/dark presets vs one unified preset — Segmented keys on a
 * string, so the boolean rides on these two ids. */
const THEME_MODE_SEGMENTS: SegmentedOption<"separate" | "unified">[] = [
	{ value: "separate", label: t("settings.themeModeSeparate") },
	{ value: "unified", label: t("settings.themeModeUnified") },
];

/** Follow-system / light / dark with per-mode icons (monitor / sun / moon) —
 * the theme flip overlay morphs between these same icons. */
const TYPE_THEME_SEGMENTS: SegmentedOption<ThemePreference>[] = [
	{ value: "system", label: t("settings.followSystem"), icon: MonitorIcon },
	{ value: "light", label: t("settings.light"), icon: SunIcon },
	{ value: "dark", label: t("settings.dark"), icon: MoonIcon },
];

/** 桌宠小球's own detail (球面光泽 / 配饰), rendered only while the pet
 *  preset owns the conversation avatar. The decoration set lives in
 *  lib/companion-decor.ts as a flag record; mapping over
 *  COMPANION_DECOR_FLAGS keeps "add an accessory" a one-line change there plus
 *  two i18n keys — never a new hand-written row here.
 *
 *  Self-contained on purpose: it resolves its own decor state and re-resolves
 *  on the shared `omp-pet-changed` broadcast (the companion page's pick,
 *  import and size sliders all fire it), so it works wherever it mounts.
 *
 *  An imported petdex spritesheet is a baked bitmap, so none of these layers
 *  exist to toggle; the rows disable and the description says why. */
function CompanionDecorSection(): ReactNode {
	const [decor, setDecor] = useState<CompanionDecor>(() => companionDecor());
	const [activeArtId, setActivePetId] = useState<string>(() => {
		const pet = activeCompanionArt();
		return pet.kind === "builtin" ? pet.id : "";
	});
	const builtinSelected = activeArtId === BUILTIN_VECTOR_ART_ID;
	const decorDescription = builtinSelected
		? t("settings.petDecorDescription")
		: t("settings.petDecorDescriptionImported");
	useEffect(() => {
		const refresh = (): void => {
			setDecor(companionDecor());
			const pet = activeCompanionArt();
			setActivePetId(pet.kind === "builtin" ? pet.id : "");
		};
		window.addEventListener("omp-pet-changed", refresh);
		window.addEventListener("storage", refresh);
		return () => {
			window.removeEventListener("omp-pet-changed", refresh);
			window.removeEventListener("storage", refresh);
		};
	}, []);
	return (
		<div className="gui-settings-section">
			<div className="gui-settings-section-title">{t("settings.petDecor")}</div>
			<div className="gui-settings-section-desc">{decorDescription}</div>
			{COMPANION_DECOR_FLAGS.map(flag => (
				<div className="gui-settings-row" key={flag.key}>
					<div>
						<div className="gui-settings-row-label">{t(flag.labelKey as TranslationKey)}</div>
						<div className="gui-settings-row-desc">{t(flag.descKey as TranslationKey)}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={decor[flag.key]}
						className={`gui-toggle${decor[flag.key] ? " gui-toggle--on" : ""}`}
						disabled={!builtinSelected}
						title={builtinSelected ? undefined : decorDescription}
						onClick={() => {
							setDecor({ ...decor, [flag.key]: !decor[flag.key] });
							setCompanionDecorFlag(flag.key, !decor[flag.key]);
						}}
						aria-label={t(flag.labelKey as TranslationKey)}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
			))}
			<div className="gui-settings-row">
				<div>
					<div className="gui-settings-row-label">{t("settings.petAccessory")}</div>
					<div className="gui-settings-row-desc">{t("settings.petAccessoryDescription")}</div>
				</div>
				<div className="gui-pet-accessory-picker" role="radiogroup" aria-label={t("settings.petAccessory")}>
					{COMPANION_ACCESSORIES.map((value: CompanionAccessory) => (
						<button
							key={value}
							type="button"
							role="radio"
							aria-checked={decor.accessory === value}
							className={`gui-pet-accessory-option${decor.accessory === value ? " gui-pet-accessory-option--on" : ""}`}
							disabled={!builtinSelected}
							title={builtinSelected ? undefined : decorDescription}
							onClick={() => {
								setDecor({ ...decor, accessory: value });
								setCompanionAccessory(value);
							}}
						>
							{t(`pet accessory ${value}` as TranslationKey)}
						</button>
					))}
				</div>
			</div>
		</div>
	);
}

/** Preview-only destinations for the hero's left rail: the real AppRail, with
 *  sample entries so the shell reads as the app (首页 active) without asking
 *  the settings page for the app's live navigation state. Clicks never fire —
 *  the shell is inert. */
const noop = (): void => {};
const HERO_RAIL: readonly RailItem[] = [
	{ id: "home", label: "general.home", icon: "home", panelId: "home", active: true, onSelect: noop },
	{
		id: "scheduled",
		label: "settings.scheduledTasks",
		icon: "calendar-schedule",
		panelId: "scheduled",
		onSelect: noop,
	},
	{ id: "board", label: "settings.board", icon: "layout-column", onSelect: noop },
];

export function AppearanceSection({
	showAvatars,
	onToggleAvatars,
	brandIconStyle,
	onToggleBrandIconStyle,
	rpc,
}: {
	showAvatars: boolean;
	onToggleAvatars(): void;
	brandIconStyle?: BrandIconStyle;
	onToggleBrandIconStyle?(): void;
	rpc: RpcClient | null;
}): ReactNode {
	// Picking the already-active theme (theme.ts setThemePreference) emits
	// musepi-theme-toggle-shake — jiggle the active segmented button instead
	// of running another overlay. The class is removed on animationend (no
	// timer: background-window timers throttle and would leave it stuck).
	const [themeShake, setThemeShake] = useState(false);
	useEffect(() => {
		const on = (): void => {
			setThemeShake(false);
			requestAnimationFrame(() => setThemeShake(true));
		};
		window.addEventListener("musepi-theme-toggle-shake", on);
		return () => window.removeEventListener("musepi-theme-toggle-shake", on);
	}, []);
	const { preference, resolved, setPreference } = useThemePreference();
	const { accent, setAccent, customAccent, applyCustomAccent } = useAccentPreference();
	// Custom-accent picker popover (app-styled ColorPickerPanel, replaces the
	// native <input type="color"> — portaled via useFloatingMenu). NOTE: no
	// className here — ColorPickerPanel's root carries the card surface;
	// passing one double-draws the rounded card (HeroComposer lesson).
	// Interaction: opening snapshots the current preference into a LOCAL
	// preview; edits touch only the preview (no veil/apply); 「应用」 applies
	// it (veil + morphicon); closing discards the preview.
	const [pickerOpen, setPickerOpen] = useState(false);
	const [pickerPreview, setPickerPreview] = useState<string | null>(null);
	const { anchorRef: accentPickerRef, renderMenu: renderAccentPicker } = useFloatingMenu(pickerOpen, setPickerOpen);
	const {
		lightThemeId,
		darkThemeId,
		setLightTheme,
		setDarkTheme,
		unifiedMode,
		unifiedThemeId,
		setUnifiedMode,
		setUnifiedTheme,
	} = useUiThemePreferences();
	// Locale: subscribe so the dropdown reflects the current language.
	const locale = useSyncExternalStore(subscribeLocale, getLocaleSnapshot);
	// Custom appearance (persisted, applied on the root element).

	const [motion, setMotion] = useState<"full" | "reduced" | "off">(
		() => (localStorage.getItem("musepi-gui-motion") as "full" | "reduced" | "off") ?? "full",
	);
	const [inlineImages, setInlineImages] = useState<boolean>(() => localStorage.getItem("musepi-gui-images") !== "0");
	const [fontScale, setFontScale] = useState<number>(() =>
		Number(localStorage.getItem("musepi-gui-font-scale") ?? 15),
	);
	const [termFont, setTermFont] = useState<number>(() =>
		Number(localStorage.getItem("musepi-gui-terminal-font") ?? 13),
	);
	const [codeFont, setCodeFont] = useState<number>(() => Number(localStorage.getItem(EDITOR_FONT_KEY) ?? 13));
	const [density, setDensity] = useState<number>(() => Number(localStorage.getItem(DENSITY_KEY) ?? 100));
	// Preference state holds the option id ("auto" | "12h" | "24h"), never the
	// i18n key: the dropdown matches on id and falls back to the raw value
	// when nothing matches, so a key in state rendered as "general.auto".
	const [timeFmt, setTimeFmt] = useState<TimeFormatPref>(() => readTimeFormat() ?? "auto");
	const [weekStart, setWeekStart] = useState<WeekStartPref>(() => readWeekStart() ?? "auto");
	const [uiFont, setUiFont] = useState<string>(() => localStorage.getItem(UI_FONT_KEY) ?? DEFAULT_UI_FONT.id);
	const [monoFont, setMonoFont] = useState<string>(() => localStorage.getItem(MONO_FONT_KEY) ?? DEFAULT_CODE_FONT.id);
	const [termFontFamily, setTermFontFamily] = useState<string>(
		() => localStorage.getItem(TERMINAL_FONT_KEY) ?? DEFAULT_TERMINAL_FONT.id,
	);
	const [terminalPlacement, setTerminalPlacement] = useState<"bottom" | "right">(() =>
		localStorage.getItem("musepi-gui-terminal-placement") === "right" ? "right" : "bottom",
	);
	const [transcriptFont, setTranscriptFont] = useState<string>(
		() => localStorage.getItem(TRANSCRIPT_FONT_KEY) ?? DEFAULT_TRANSCRIPT_FONT.id,
	);
	const [turnRailSide, setTurnRailSide] = useState<TurnRailSide>(
		() => (localStorage.getItem(TURN_RAIL_SIDE_KEY) as TurnRailSide) ?? "right",
	);
	const [turnRailStyle, setTurnRailStyle] = useState<TurnRailStyle>(
		() => (localStorage.getItem(TURN_RAIL_STYLE_KEY) as TurnRailStyle) ?? "burger",
	);
	const [glassEnabled, setGlassEnabled] = useState<boolean>(
		() => localStorage.getItem("musepi-gui-glass-enabled") !== "0",
	);
	const [avatarId, setAvatarId] = useState<string>(avatarPresetId);
	const [punkSeedInput, setPunkSeedInput] = useState<string>(userPunkSeed() ?? "");
	const [lightCodeTheme, setLightCodeTheme] = useState<string>(
		() => localStorage.getItem(CODE_THEME_LIGHT_KEY) ?? DEFAULT_LIGHT_CODE_THEME.id,
	);
	const [darkCodeTheme, setDarkCodeTheme] = useState<string>(
		() => localStorage.getItem(CODE_THEME_DARK_KEY) ?? DEFAULT_DARK_CODE_THEME.id,
	);
	const [codeLines, setCodeLines] = useState<boolean>(() => localStorage.getItem(CODE_LINES_KEY) !== "0");
	const [codeWrap, setCodeWrap] = useState<boolean>(() => localStorage.getItem(CODE_WRAP_KEY) !== "0");
	const lightTheme: CodeTheme = LIGHT_CODE_THEMES.find(o => o.id === lightCodeTheme) ?? DEFAULT_LIGHT_CODE_THEME;
	const darkTheme: CodeTheme = DARK_CODE_THEMES.find(o => o.id === darkCodeTheme) ?? DEFAULT_DARK_CODE_THEME;
	const setPref = (key: string, value: string | number): void => {
		try {
			localStorage.setItem(key, String(value));
		} catch {
			// storage unavailable
		}
	};
	return (
		<>
			<h2 className="gui-settings-page-title">{t("settings.appearance")}</h2>
			<p className="gui-settings-page-desc">{t("settings.appearanceSettings")}</p>

			{/* ── 头图预览 — the app scene itself, not a swatch. Theme, accent,
			 * fonts, spacing, transparency and the avatar switches reach it through
			 * the same components and tokens the app uses, so it answers every row
			 * below instead of illustrating one of them. ── */}
			<div className="gui-appearance-hero" role="img" aria-label={t("settings.appearancePreview")}>
				{/* The app shell around the session: the real left rail and right
				 * rail, with the chat card between them — its side panel folded,
				 * which is a real state of the app. `inert` keeps a preview from
				 * being clicked or tabbed into. */}
				<div className="gui-appearance-hero-window" inert>
					<AppRail destinations={HERO_RAIL} panelAvailable onTogglePanel={noop} />
					<MockConversationPreview showAvatars={showAvatars} framed activity="collapsed" />
					<RightRail rpc={null} rightPanelOpen={false} terminalOpen={false} onSelect={noop} />
				</div>
			</div>

			{/* ── 主题 — the palette first: scheme, preset and accent. ── */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("settings.theme")}</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("settings.interfaceTheme")}</div>
					<div className="gui-settings-field-hint">{t("settings.chooseLightDark.info")}</div>
					<div className="gui-settings-field-control">
						<Segmented
							ariaLabel={t("settings.interfaceTheme")}
							value={preference}
							options={TYPE_THEME_SEGMENTS}
							onChange={setPreference}
							shake={themeShake}
							onShakeEnd={() => setThemeShake(false)}
						/>
					</div>
				</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("settings.themeMode")}</div>
					<div className="gui-settings-field-hint">{t("settings.themeModeDescription")}</div>
					<div className="gui-settings-field-control">
						<Segmented
							ariaLabel={t("settings.themeMode")}
							value={unifiedMode ? "unified" : "separate"}
							options={THEME_MODE_SEGMENTS}
							onChange={v => setUnifiedMode(v === "unified")}
						/>
					</div>
				</div>
				<Reveal open={unifiedMode}>
					<div className="gui-settings-field">
						<div className="gui-settings-field-label">{t("settings.unifiedTheme")}</div>
						<div className="gui-settings-field-hint">{t("settings.unifiedThemeDescription")}</div>
						<div className="gui-settings-field-control">
							<GuiSelect
								className="gui-settings-select"
								value={unifiedThemeId}
								onChange={v => setUnifiedTheme(v as UiThemeId)}
								options={UNIFIED_THEME_PRESETS.map(p => ({
									value: p.id,
									label: t(THEME_PRESET_LABEL[p.id]),
								}))}
							/>
						</div>
					</div>
				</Reveal>
				<Reveal open={!unifiedMode}>
					<div className="gui-settings-field">
						<div className="gui-settings-field-label">{t("settings.lightTheme")}</div>
						<div className="gui-settings-field-hint">{t("settings.lightThemeDescription")}</div>
						<div className="gui-settings-field-control">
							<GuiSelect
								className="gui-settings-select"
								value={lightThemeId}
								onChange={v => setLightTheme(v as UiThemeId)}
								options={LIGHT_THEME_PRESETS.map(p => ({
									value: p.id,
									label: t(THEME_PRESET_LABEL[p.id]),
								}))}
							/>
						</div>
					</div>
					<div className="gui-settings-field">
						<div className="gui-settings-field-label">{t("settings.darkTheme")}</div>
						<div className="gui-settings-field-hint">{t("settings.darkThemeDescription")}</div>
						<div className="gui-settings-field-control">
							<GuiSelect
								className="gui-settings-select"
								value={darkThemeId}
								onChange={v => setDarkTheme(v as UiThemeId)}
								options={DARK_THEME_PRESETS.map(p => ({
									value: p.id,
									label: t(THEME_PRESET_LABEL[p.id]),
								}))}
							/>
						</div>
					</div>
				</Reveal>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("settings.accent")}</div>
					<div className="gui-settings-field-hint">{t("settings.accentThemeHint")}</div>
					<div className="gui-settings-field-control">
						<div className="flex items-center gap-2">
							{Object.entries(ACCENT_SWATCH).map(([id, color]) => (
								<button
									key={id}
									type="button"
									className={`gui-accent-swatch${accent === id ? " gui-accent-swatch--active" : ""}`}
									style={{ background: color }}
									aria-label={t(ACCENT_NAMES[id] ?? "settings.accentBrand")}
									title={t(ACCENT_NAMES[id] ?? "settings.accentBrand")}
									onClick={() => setAccent(id as "theme" | "brand" | "mono" | "ocean" | "jade")}
								/>
							))}
							<button
								ref={accentPickerRef}
								type="button"
								className={`gui-accent-swatch gui-accent-swatch--custom${accent === "custom" ? " gui-accent-swatch--active" : ""}`}
								style={{ background: customAccent }}
								title={t("settings.customAccent")}
								aria-label={t("settings.customAccent")}
								aria-haspopup="dialog"
								onClick={() => {
									// Open only — no accent switch, no veil. Snapshot
									// the current preference as the starting preview;
									// apply happens exclusively via the card buttons.
									setPickerPreview(customAccent);
									setPickerOpen(o => !o);
								}}
							/>
						</div>
						{renderAccentPicker(
							<ColorPickerPanel
								value={pickerPreview ?? customAccent}
								onChange={setPickerPreview}
								onApply={applyCustomAccent}
							/>,
						)}
					</div>
				</div>
			</div>

			{/* ── 界面设置 — type, spacing and window chrome. ── */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("settings.interfaceSettings")}</div>
				<div className="gui-settings-section-desc">{t("settings.interfaceSettingsDescription")}</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("settings.interfaceFontSize")}</div>
					<NumberStepper
						label={t("settings.interfaceFontSize")}
						value={fontScale}
						min={12}
						max={18}
						unit="px"
						defaultValue={15}
						onChange={v => {
							setFontScale(v);
							setPref("musepi-gui-font-scale", v);
							document.documentElement.style.setProperty("--gui-font-scale", `${v}px`);
						}}
					/>
				</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("general.interfaceFont")}</div>
					<div className="gui-settings-field-control">
						<GuiSelect
							className="gui-settings-select"
							value={uiFont}
							onChange={nv => {
								const v = nv;
								setUiFont(v);
								setPref(UI_FONT_KEY, v);
								applyUiFont(v);
							}}
							options={UI_FONT_OPTIONS.map(o => ({ value: o.id, label: o.label }))}
						/>
						<button
							type="button"
							className="gui-settings-reset"
							title={t("general.reset")}
							aria-label={t("general.reset")}
							disabled={uiFont === DEFAULT_UI_FONT.id}
							onClick={() => {
								setUiFont(DEFAULT_UI_FONT.id);
								setPref(UI_FONT_KEY, DEFAULT_UI_FONT.id);
								applyUiFont(DEFAULT_UI_FONT.id);
							}}
						>
							<Icon name="restart" className="h-3.5 w-3.5" />
						</button>
					</div>
				</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("general.transcriptFont")}</div>
					<div className="gui-settings-field-control">
						<GuiSelect
							className="gui-settings-select"
							value={transcriptFont}
							onChange={nv => {
								setTranscriptFont(nv);
								setPref(TRANSCRIPT_FONT_KEY, nv);
								applyTranscriptFont(nv);
							}}
							options={TRANSCRIPT_FONT_OPTIONS.map(o => ({ value: o.id, label: o.label }))}
						/>
						<button
							type="button"
							className="gui-settings-reset"
							title={t("general.reset")}
							aria-label={t("general.reset")}
							disabled={transcriptFont === DEFAULT_TRANSCRIPT_FONT.id}
							onClick={() => {
								setTranscriptFont(DEFAULT_TRANSCRIPT_FONT.id);
								setPref(TRANSCRIPT_FONT_KEY, DEFAULT_TRANSCRIPT_FONT.id);
								applyTranscriptFont(DEFAULT_TRANSCRIPT_FONT.id);
							}}
						>
							<Icon name="restart" className="h-3.5 w-3.5" />
						</button>
					</div>
				</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("general.spacingDensity")}</div>
					<NumberStepper
						label={t("general.spacingDensity")}
						value={density}
						min={50}
						max={200}
						step={5}
						unit="%"
						defaultValue={100}
						onChange={v => {
							setDensity(v);
							setPref(DENSITY_KEY, v);
							applyDensity(v);
						}}
					/>
				</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("settings.turnRailPosition")}</div>
					<div className="gui-settings-field-hint">{t("settings.turnRailPositionHint")}</div>
					<div className="gui-settings-field-control">
						<GuiSelect
							className="gui-settings-select"
							value={turnRailSide}
							onChange={nv => {
								const v = nv as "right" | "left";
								setTurnRailSide(v);
								setPref(TURN_RAIL_SIDE_KEY, v);
								window.dispatchEvent(new Event(TURN_RAIL_CHANGED_EVENT));
							}}
							options={[
								{ value: "right", label: t("settings.rightSide") },
								{ value: "left", label: t("settings.leftSide") },
							]}
						/>
					</div>
				</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("settings.turnRailStyle")}</div>
					<div className="gui-settings-field-control">
						<GuiSelect
							className="gui-settings-select"
							value={turnRailStyle}
							onChange={nv => {
								const v = nv as "burger" | "pacman";
								setTurnRailStyle(v);
								setPref(TURN_RAIL_STYLE_KEY, v);
								window.dispatchEvent(new Event(TURN_RAIL_CHANGED_EVENT));
							}}
							options={[
								{ value: "burger", label: t("settings.burgerLayers") },
								{ value: "pacman", label: t("settings.pacman") },
							]}
						/>
					</div>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("settings.windowTransparency")}</div>
						<div className="gui-settings-row-desc">{t("settings.windowTransparencyDescription")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={glassEnabled}
						className={`gui-toggle${glassEnabled ? " gui-toggle--on" : ""}`}
						onClick={() => {
							const next = !glassEnabled;
							setGlassEnabled(next);
							setPref("musepi-gui-glass-enabled", next ? "1" : "0");
							// OFF = opaque panes: a global 100% overlay beats every
							// per-rule translucency; ON restores the slider level.
							if (next) {
								document.documentElement.style.removeProperty("--gui-glass-overlay");
							} else {
								document.documentElement.style.setProperty("--gui-glass-overlay", "100%");
								document.documentElement.classList.remove("gui-glass-adaptive");
							}
							// Desktop shell: mirror onto the native window material.
							applyGlassMaterial(next);
						}}
						aria-label={t("settings.windowTransparency")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
			</div>

			{/* ── 效果 — motion / info status bar / avatars (session chrome the
			 * hero above reflects live). ── */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("settings.effects")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("settings.motionEffects")}</div>
						<div className="gui-settings-row-desc">{t("settings.menuPopupsOrb.info")}</div>
					</div>
					<Segmented
						ariaLabel={t("settings.motionEffects")}
						value={motion}
						options={MOTION_SEGMENTS}
						onChange={m => {
							setMotion(m);
							localStorage.setItem("musepi-gui-motion", m);
							document.documentElement.classList.toggle("gui-motion-off", m === "off");
						}}
					/>
				</div>
				<div className="gui-settings-row">
					<div className="flex-1">
						<div className="gui-settings-row-label">{t("settings.showAvatars")}</div>
						<div className="gui-settings-row-desc">{t("settings.agentOrbAvatar.info")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={showAvatars}
						className={`gui-toggle${showAvatars ? " gui-toggle--on" : ""}`}
						onClick={onToggleAvatars}
						aria-label={t("settings.showAvatars")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				{brandIconStyle && onToggleBrandIconStyle ? (
					<div className="gui-settings-row">
						<div className="flex-1">
							<div className="gui-settings-row-label">{t("settings.brandIconsColor")}</div>
							<div className="gui-settings-row-desc">{t("settings.brandIconsColorHint")}</div>
						</div>
						<button
							type="button"
							role="switch"
							aria-checked={brandIconStyle === "color"}
							className={`gui-toggle${brandIconStyle === "color" ? " gui-toggle--on" : ""}`}
							onClick={onToggleBrandIconStyle}
							aria-label={t("settings.brandIconsColor")}
						>
							<span className="gui-toggle-knob" />
						</button>
					</div>
				) : null}
			</div>

			{/* ── Agent 头像 — the conversation avatar's animation style. The
			 * 效果 section above owns whether avatars show at all; this owns
			 * which one, and the ball-only detail rides under its preset. ── */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("settings.agentAvatarStyle")}</div>
				<div className="gui-settings-section-desc">{t("settings.agentAvatarStyleDescription")}</div>
				{/* Preset picker as a labelled card grid: each card carries a live
				 * preview at a size the preset can actually be judged at, its name,
				 * and the selected state. The pet card previews through
				 * BuiltinCompanionArt directly, so a gloss / accessory change reads
				 * back instantly in the card. */}
				<div className="gui-avatar-grid" role="radiogroup" aria-label={t("settings.agentAvatarStyle")}>
					{AVATAR_PRESETS.map(p => {
						const selected = avatarId === p.id;
						return (
							<button
								key={p.id}
								type="button"
								role="radio"
								aria-checked={selected}
								className={`gui-avatar-card${selected ? " gui-avatar-card--active" : ""}`}
								onClick={() => {
									setAvatarId(p.id);
									localStorage.setItem("musepi-gui-avatar", p.id);
									window.dispatchEvent(new CustomEvent("omp-avatar-changed"));
								}}
							>
								<span className="gui-avatar-card__stage">{p.render("working", 32)}</span>
								<span className="gui-avatar-card__name">
									{t(p.labelKey as TranslationKey)}
									{selected && <Icon name="check" className="gui-avatar-card__check" />}
								</span>
							</button>
						);
					})}
				</div>
				{avatarId === "pet" && <CompanionDecorSection />}
				{avatarId === "punk" && (
					<div className="gui-settings-row">
						<div>
							<div className="gui-settings-row-label">{t("settings.pixelFace")}</div>
							<div className="gui-settings-row-desc">{t("settings.pixelFaceDescription")}</div>
						</div>
						<div className="flex items-center gap-2">
							<PunkAvatar size={40} />
							<button
								type="button"
								className="gui-btn gui-btn--secondary"
								onClick={() => {
									setPunkSeedInput("");
									setPunkSeed(randomPunkSeed());
								}}
							>
								{t("settings.changeFace")}
							</button>
							<input
								className="gui-input w-[150px]"
								value={punkSeedInput}
								placeholder={t("settings.faceSeed")}
								aria-label={t("settings.faceSeed")}
								onChange={e => setPunkSeedInput(e.target.value)}
								onKeyDown={e => {
									if (e.key === "Enter" && punkSeedInput.trim()) setPunkSeed(punkSeedInput.trim());
								}}
							/>
							<button
								type="button"
								className="gui-btn gui-btn--secondary"
								disabled={!punkSeedInput.trim()}
								onClick={() => setPunkSeed(punkSeedInput.trim())}
							>
								{t("tools.apply")}
							</button>
						</div>
					</div>
				)}
			</div>

			{/* ── 图片 — the GUI inline-images toggle + the daemon schema's
			 * Images group (auto-resize / block images) in one place. ── */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("settings.images")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("settings.inlineImages")}</div>
						<div className="gui-settings-row-desc">{t("settings.showImagesInsideTranscript")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={inlineImages}
						className={`gui-toggle${inlineImages ? " gui-toggle--on" : ""}`}
						onClick={() => {
							const next = !inlineImages;
							setInlineImages(next);
							localStorage.setItem("musepi-gui-images", next ? "1" : "0");
							document.documentElement.classList.toggle("gui-no-images", !next);
						}}
						aria-label={t("settings.inlineImages")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<SchemaTabSection rpc={rpc} tabs={["appearance"]} groups={["images"]} />
			</div>
			{/* ── 本地化 — language / time format / week start (openchamber parity). ── */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("general.localization")}</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("settings.language")}</div>
					<GuiSelect
						className="gui-settings-select"
						value={locale}
						onChange={v => {
							const next = v;
							// Renderer mirror updates immediately; the daemon key
							// (settings.locale, config.yml) is the single source the
							// TUI and the GUI boot sync both read (F1 audit fix).
							setLocale(next);
							if (rpc) void rpc.request("settings.set", { key: "settings.locale", value: next }).catch(() => {});
						}}
						options={[
							{ value: "zh-CN", label: "中文" },
							{ value: "en-US", label: "English" },
						]}
					/>
				</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("general.timeFormat")}</div>
					<GuiSelect
						className="gui-settings-select"
						value={timeFmt}
						onChange={v => {
							setTimeFmt(v);
							setPref(TIME_FMT_KEY, v);
						}}
						options={[
							{ value: "auto", label: t("general.auto") },
							{ value: "12h", label: t("general.12Hour") },
							{ value: "24h", label: t("general.24Hour") },
						]}
					/>
				</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("general.weekStarts")}</div>
					<GuiSelect
						className="gui-settings-select"
						value={weekStart}
						onChange={v => {
							setWeekStart(v);
							setPref(WEEK_START_KEY, v);
						}}
						options={[
							{ value: "auto", label: t("general.auto") },
							{ value: "monday", label: t("general.monday") },
							{ value: "sunday", label: t("general.sunday") },
						]}
					/>
				</div>
			</div>

			{/* ── 代码设置 — code themes / line numbers / wrap / sizes (ZCode). ── */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("settings.codeSettings")}</div>
				<div className="gui-settings-section-desc">{t("settings.codeSettingsDescription")}</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("settings.lightCodeTheme")}</div>
					<div className="gui-settings-field-hint">{t("settings.lightCodeThemeDescription")}</div>
					<div className="gui-settings-field-control">
						<GuiSelect
							className="gui-settings-select"
							value={lightCodeTheme}
							onChange={nv => {
								const v = nv;
								setLightCodeTheme(v);
								setPref(CODE_THEME_LIGHT_KEY, v);
								applyCodeThemes(v, darkCodeTheme);
							}}
							options={LIGHT_CODE_THEMES.map(o => ({ value: o.id, label: o.label }))}
						/>
					</div>
				</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("settings.darkCodeTheme")}</div>
					<div className="gui-settings-field-hint">{t("settings.darkCodeThemeDescription")}</div>
					<div className="gui-settings-field-control">
						<GuiSelect
							className="gui-settings-select"
							value={darkCodeTheme}
							onChange={nv => {
								const v = nv;
								setDarkCodeTheme(v);
								setPref(CODE_THEME_DARK_KEY, v);
								applyCodeThemes(lightCodeTheme, v);
							}}
							options={DARK_CODE_THEMES.map(o => ({ value: o.id, label: o.label }))}
						/>
					</div>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("settings.showLineNumbers")}</div>
						<div className="gui-settings-row-desc">{t("settings.showLineNumbersDescription")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={codeLines}
						className={`gui-toggle${codeLines ? " gui-toggle--on" : ""}`}
						onClick={() => {
							const next = !codeLines;
							setCodeLines(next);
							setPref(CODE_LINES_KEY, next ? "1" : "0");
							document.documentElement.classList.toggle("gui-code-lines", next);
						}}
						aria-label={t("settings.showLineNumbers")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("settings.wrapLongLines")}</div>
						<div className="gui-settings-row-desc">{t("settings.wrapLongLinesDescription")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={codeWrap}
						className={`gui-toggle${codeWrap ? " gui-toggle--on" : ""}`}
						onClick={() => {
							const next = !codeWrap;
							setCodeWrap(next);
							setPref(CODE_WRAP_KEY, next ? "1" : "0");
							document.documentElement.classList.toggle("gui-code-wrap", next);
						}}
						aria-label={t("settings.wrapLongLines")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("settings.codeFontSize")}</div>
					<div className="gui-settings-field-hint">{t("settings.codeFontSizeDescription")}</div>
					<NumberStepper
						label={t("settings.codeFontSize")}
						value={codeFont}
						min={9}
						max={32}
						unit="px"
						defaultValue={13}
						onChange={v => {
							setCodeFont(v);
							setPref(EDITOR_FONT_KEY, v);
							applyCodeSize(v);
						}}
					/>
				</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("general.codeFont")}</div>
					<div className="gui-settings-field-control">
						<GuiSelect
							className="gui-settings-select"
							value={monoFont}
							onChange={nv => {
								const v = nv;
								setMonoFont(v);
								setPref(MONO_FONT_KEY, v);
								applyMonoFont(v);
							}}
							options={CODE_FONT_OPTIONS.map(o => ({ value: o.id, label: o.label }))}
						/>
						<button
							type="button"
							className="gui-settings-reset"
							title={t("general.reset")}
							aria-label={t("general.reset")}
							disabled={monoFont === DEFAULT_CODE_FONT.id}
							onClick={() => {
								setMonoFont(DEFAULT_CODE_FONT.id);
								setPref(MONO_FONT_KEY, DEFAULT_CODE_FONT.id);
								applyMonoFont(DEFAULT_CODE_FONT.id);
							}}
						>
							<Icon name="restart" className="h-3.5 w-3.5" />
						</button>
					</div>
				</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("general.terminalFontSize")}</div>
					<NumberStepper
						label={t("general.terminalFontSize")}
						value={termFont}
						min={9}
						max={32}
						unit="px"
						defaultValue={13}
						onChange={v => {
							setTermFont(v);
							setPref("musepi-gui-terminal-font", v);
						}}
					/>
				</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("general.terminalFont")}</div>
					<div className="gui-settings-field-control">
						<GuiSelect
							className="gui-settings-select"
							value={termFontFamily}
							onChange={nv => {
								setTermFontFamily(nv);
								setPref(TERMINAL_FONT_KEY, nv);
								applyTerminalFont(nv);
							}}
							options={TERMINAL_FONT_OPTIONS.map(o => ({ value: o.id, label: o.label }))}
						/>
						<button
							type="button"
							className="gui-settings-reset"
							title={t("general.reset")}
							aria-label={t("general.reset")}
							disabled={termFontFamily === DEFAULT_TERMINAL_FONT.id}
							onClick={() => {
								setTermFontFamily(DEFAULT_TERMINAL_FONT.id);
								setPref(TERMINAL_FONT_KEY, DEFAULT_TERMINAL_FONT.id);
								applyTerminalFont(DEFAULT_TERMINAL_FONT.id);
							}}
						>
							<Icon name="restart" className="h-3.5 w-3.5" />
						</button>
					</div>
				</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("settings.terminalPlacement")}</div>
					<GuiSelect
						className="gui-settings-select"
						value={terminalPlacement}
						onChange={nv => {
							const v = nv as "bottom" | "right";
							setTerminalPlacement(v);
							setPref("musepi-gui-terminal-placement", v);
							window.dispatchEvent(new CustomEvent("musepi-gui-terminal-placement-changed", { detail: v }));
						}}
						options={[
							{ value: "bottom", label: t("settings.terminalPlacementBottom") },
							{ value: "right", label: t("settings.terminalPlacementRight") },
						]}
					/>
				</div>
			</div>

			{/* ── 代码预览 — light/dark preview cards (ZCode), the active main
			 * theme's card carries the "settings.currentlyActive" tag. ── */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("settings.codePreview")}</div>
				<div className="gui-settings-section-desc">{t("settings.codePreviewDescription")}</div>
				<div className="grid grid-cols-2 gap-3">
					<CodePreviewCard
						title={t("settings.lightPreview")}
						theme={lightTheme}
						active={resolved === "light"}
						scheme="light"
					/>
					<CodePreviewCard
						title={t("settings.darkPreview")}
						theme={darkTheme}
						active={resolved === "dark"}
						scheme="dark"
					/>
				</div>
			</div>

			{/* ── 终端行为 — the daemon schema's appearance leftovers (Theme /
			 * Composer / Status Line / Display groups): TUI-only rows are
			 * split into the collapsed 仅终端 block by SchemaSettings, so
			 * desktop-irrelevant options (Resize Scrollback, Mermaid, …)
			 * never mix with the desktop behavior above. ── */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{tLoose("terminal behavior")}</div>
				<div className="gui-settings-section-desc">
					{tLoose("Affects the terminal (TUI) interface only; desktop settings live above")}
				</div>
				<SchemaTabSection rpc={rpc} tabs={["appearance"]} excludeGroups={["images"]} />
			</div>
			{/* Chat display settings (previously the 聊天设置 tab): transcript
			 * rendering prefs are appearance — merged into one 外观 page. */}
			<ChatSection />
		</>
	);
}

/** ZCode code-preview card: the selected theme's real colors over a sample
 * snippet; the card matching the active main scheme gets the tag. */
const PREVIEW_SNIPPET = ["const greet = (name: string) => {", "  return `hello, ${name}!`;", "};"].join("\n");

/** Once-per-scheme cache: the snippet is static, the bridge is async. */
const previewHighlightCache = new Map<"light" | "dark", string | null>();

export function CodePreviewCard({
	title,
	theme,
	active,
	scheme,
}: {
	title: string;
	theme: CodeTheme;
	active: boolean;
	scheme: "light" | "dark";
}): ReactNode {
	const [html, setHtml] = useState<string | null>(() => previewHighlightCache.get(scheme) ?? null);
	useEffect(() => {
		const cached = previewHighlightCache.get(scheme);
		if (cached !== undefined) {
			setHtml(cached);
			return;
		}
		let alive = true;
		void nativeHighlight(PREVIEW_SNIPPET, "typescript", scheme).then(out => {
			if (!alive) return;
			const next = out ? highlightToCodeHtml(out) : null;
			previewHighlightCache.set(scheme, next);
			setHtml(next);
		});
		return () => {
			alive = false;
		};
	}, [scheme]);
	// 横向边缘羽化:主题代码预览块横向滚动时左右羽化。
	const previewRef = useRef<HTMLPreElement | null>(null);
	useScrollShadow(previewRef);
	return (
		<div className="gui-code-preview-card">
			<div className="gui-code-preview-head">
				<span className="text-[13px] font-medium">{title}</span>
				<span className="gui-settings-row-desc">{theme.label}</span>
				{active && <span className="gui-code-preview-tag">{t("settings.currentlyActive")}</span>}
			</div>
			<pre ref={previewRef} className="gui-code-preview-body" style={{ background: theme.bg, color: theme.fg }}>
				{html !== null ? (
					<code dangerouslySetInnerHTML={{ __html: html }} />
				) : (
					<span className="tr-code-line">{PREVIEW_SNIPPET}</span>
				)}
			</pre>
		</div>
	);
}
