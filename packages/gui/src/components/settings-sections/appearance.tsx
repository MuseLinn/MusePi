import {
	DARK_THEME_PRESETS,
	getLocaleSnapshot,
	highlightToCodeHtml,
	LIGHT_THEME_PRESETS,
	setLocale,
	subscribeLocale,
	type TranslationKey,
	t,
	type UiThemeId,
	UNIFIED_THEME_PRESETS,
	useAccentPreference,
	useThemePreference,
	useUiThemePreferences,
} from "@musepi/desktop-web";
import { Monitor as MonitorIcon, Moon as MoonIcon, Sun as SunIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
	applyCodeSize,
	applyCodeThemes,
	applyDensity,
	applyMonoFont,
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
	DEFAULT_UI_FONT,
	DENSITY_KEY,
	EDITOR_FONT_KEY,
	LIGHT_CODE_THEMES,
	MONO_FONT_KEY,
	TIME_FMT_KEY,
	UI_FONT_KEY,
	UI_FONT_OPTIONS,
	WEEK_START_KEY,
} from "../../lib/appearance";
import { applyGlassMaterial, applyGlassPreset, GLASS_PRESETS, readGlassPreset } from "../../lib/glass";
import { nativeHighlight } from "../../lib/highlight";
import type { RpcClient } from "../../lib/rpc";
import {
	readImportedSkins,
	readScrollbarStyle,
	SCROLLBAR_STYLE_CHANGED_EVENT,
	SCROLLBAR_STYLE_KEY,
	type ScrollbarSkin,
	saveImportedSkin,
	validateImportedSkin,
} from "../../lib/scrollbar-skins";
import { useFloatingMenu } from "../../lib/use-floating-menu";
import { Icon } from "../../vendor/oc-icons";
import { AgentAvatar } from "../AgentAvatar";
import { ColorPickerPanel } from "../ColorPicker";

import { GuiSelect } from "../GuiSelect";
import { Reveal } from "../Reveal";
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
	brand: "#34d399",
	mono: "#8a8a93",
	ocean: "#38bdf8",
	jade: "#44b782",
};

/** Accent preset → localized name (swatch tooltip/aria). */
const ACCENT_NAMES: Record<string, TranslationKey> = {
	brand: "accent brand",
	mono: "accent mono",
	ocean: "accent ocean",
	jade: "accent jade",
};

const THEME_OPTIONS = [
	{ id: "system", label: t("follow system") },
	{ id: "light", label: t("light") },
	{ id: "dark", label: t("dark") },
] as const;

/** Same options as a segmented picker with per-mode icons (monitor / sun /
 *  moon) — the theme flip overlay morphs between these same icons. */
const TYPE_THEME_OPTIONS = [
	{ id: "system", label: t("follow system"), Icon: MonitorIcon },
	{ id: "light", label: t("light"), Icon: SunIcon },
	{ id: "dark", label: t("dark"), Icon: MoonIcon },
] as const;
export function AppearanceSection({
	showAvatars,
	onToggleAvatars,
	rpc,
}: {
	showAvatars: boolean;
	onToggleAvatars(): void;
	rpc: RpcClient | null;
}): ReactNode {
	// Picking the already-active theme (theme.ts setThemePreference) emits
	// omp-theme-toggle-shake — jiggle the active segmented button instead
	// of running another overlay. The class is removed on animationend (no
	// timer: background-window timers throttle and would leave it stuck).
	const [themeShake, setThemeShake] = useState(false);
	useEffect(() => {
		const on = (): void => {
			setThemeShake(false);
			requestAnimationFrame(() => setThemeShake(true));
		};
		window.addEventListener("omp-theme-toggle-shake", on);
		return () => window.removeEventListener("omp-theme-toggle-shake", on);
	}, []);
	const { preference, resolved, setPreference } = useThemePreference();
	const { accent, setAccent, customAccent, applyCustomAccent } = useAccentPreference();
	// Custom-accent picker popover (app-styled ColorPickerPanel, replaces the
	// native <input type="color"> — portaled via useFloatingMenu). NOTE: no
	// className here — ColorPickerPanel's root carries the card surface;
	// passing one double-draws the rounded card (WelcomeComposer lesson).
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
	const [statusBarInfo, setStatusBarInfo] = useState<boolean>(
		() => localStorage.getItem("musepi-gui-statusbar-info") === "1",
	);
	const [fontScale, setFontScale] = useState<number>(() =>
		Number(localStorage.getItem("musepi-gui-font-scale") ?? 15),
	);
	const [termFont, setTermFont] = useState<number>(() =>
		Number(localStorage.getItem("musepi-gui-terminal-font") ?? 13),
	);
	const [codeFont, setCodeFont] = useState<number>(() => Number(localStorage.getItem(EDITOR_FONT_KEY) ?? 13));
	const [density, setDensity] = useState<number>(() => Number(localStorage.getItem(DENSITY_KEY) ?? 100));
	const [timeFmt, setTimeFmt] = useState<"auto" | "12h" | "24h">(
		() => (localStorage.getItem(TIME_FMT_KEY) as "auto" | "12h" | "24h") ?? "auto",
	);
	const [weekStart, setWeekStart] = useState<"auto" | "monday" | "sunday">(
		() => (localStorage.getItem(WEEK_START_KEY) as "auto" | "monday" | "sunday") ?? "auto",
	);
	const [uiFont, setUiFont] = useState<string>(() => localStorage.getItem(UI_FONT_KEY) ?? DEFAULT_UI_FONT.id);
	const [monoFont, setMonoFont] = useState<string>(() => localStorage.getItem(MONO_FONT_KEY) ?? DEFAULT_CODE_FONT.id);
	const [turnRailSide, setTurnRailSide] = useState<TurnRailSide>(
		() => (localStorage.getItem(TURN_RAIL_SIDE_KEY) as TurnRailSide) ?? "right",
	);
	const [turnRailStyle, setTurnRailStyle] = useState<TurnRailStyle>(
		() => (localStorage.getItem(TURN_RAIL_STYLE_KEY) as TurnRailStyle) ?? "burger",
	);
	const [scrollbarStyle, setScrollbarStyle] = useState<string>(() => readScrollbarStyle());
	const [importedSkins, setImportedSkins] = useState<ScrollbarSkin[]>(() => readImportedSkins());
	const [skinError, setSkinError] = useState(false);
	const [importingSkin, setImportingSkin] = useState(false);
	const [glass, setGlass] = useState<string>(() => readGlassPreset().id);
	const [glassEnabled, setGlassEnabled] = useState<boolean>(
		() => localStorage.getItem("musepi-gui-glass-enabled") !== "0",
	);
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
			<h2 className="gui-settings-page-title">{t("appearance")}</h2>
			<p className="gui-settings-page-desc">{t("appearance settings")}</p>

			{/* ── 本地化 — language / time format / week start (openchamber parity). ── */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("localization")}</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("language")}</div>
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
					<div className="gui-settings-field-label">{t("time format")}</div>
					<GuiSelect
						className="gui-settings-select"
						value={timeFmt}
						onChange={nv => {
							const v = nv as "auto" | "12h" | "24h";
							setTimeFmt(v);
							setPref(TIME_FMT_KEY, v);
						}}
						options={[
							{ value: "auto", label: t("auto") },
							{ value: "12h", label: t("12-hour") },
							{ value: "24h", label: t("24-hour") },
						]}
					/>
				</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("week starts on")}</div>
					<GuiSelect
						className="gui-settings-select"
						value={weekStart}
						onChange={nv => {
							const v = nv as "auto" | "monday" | "sunday";
							setWeekStart(v);
							setPref(WEEK_START_KEY, v);
						}}
						options={[
							{ value: "auto", label: t("auto") },
							{ value: "monday", label: t("monday") },
							{ value: "sunday", label: t("sunday") },
						]}
					/>
				</div>
			</div>

			{/* ── 界面设置 — theme + interface type (ZCode section). ── */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("interface settings")}</div>
				<div className="gui-settings-section-desc">{t("interface settings description")}</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("interface theme")}</div>
					<div className="gui-settings-field-hint">{t("choose light, dark or follow the system")}</div>
					<div className="gui-settings-field-control">
						<div className="gui-segmented gui-theme-seg" role="radiogroup" aria-label={t("interface theme")}>
							{TYPE_THEME_OPTIONS.map(o => (
								<button
									key={o.id}
									type="button"
									role="radio"
									aria-checked={preference === o.id}
									className={`gui-seg-btn${preference === o.id ? " gui-seg-btn--active" : ""}${themeShake && preference === o.id ? " gui-seg-btn--shake" : ""}`}
									onAnimationEnd={() => setThemeShake(false)}
									onClick={() => setPreference(o.id)}
								>
									<o.Icon size={14} />
									<span>{o.label}</span>
								</button>
							))}
						</div>
					</div>
				</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("theme mode")}</div>
					<div className="gui-settings-field-hint">{t("theme mode description")}</div>
					<div className="gui-settings-field-control">
						<div className="gui-segmented" role="radiogroup" aria-label={t("theme mode")}>
							<button
								type="button"
								role="radio"
								aria-checked={!unifiedMode}
								className={`gui-seg-btn${unifiedMode ? "" : " gui-seg-btn--active"}`}
								onClick={() => setUnifiedMode(false)}
							>
								{t("theme mode separate")}
							</button>
							<button
								type="button"
								role="radio"
								aria-checked={unifiedMode}
								className={`gui-seg-btn${unifiedMode ? " gui-seg-btn--active" : ""}`}
								onClick={() => setUnifiedMode(true)}
							>
								{t("theme mode unified")}
							</button>
						</div>
					</div>
				</div>
				<Reveal open={unifiedMode}>
					<div className="gui-settings-field">
						<div className="gui-settings-field-label">{t("unified theme")}</div>
						<div className="gui-settings-field-hint">{t("unified theme description")}</div>
						<div className="gui-settings-field-control">
							<GuiSelect
								className="gui-settings-select"
								value={unifiedThemeId}
								onChange={v => setUnifiedTheme(v as UiThemeId)}
								options={UNIFIED_THEME_PRESETS.map(p => ({ value: p.id, label: t(`theme preset ${p.id}`) }))}
							/>
						</div>
					</div>
				</Reveal>
				<Reveal open={!unifiedMode}>
					<div className="gui-settings-field">
						<div className="gui-settings-field-label">{t("light theme")}</div>
						<div className="gui-settings-field-hint">{t("light theme description")}</div>
						<div className="gui-settings-field-control">
							<GuiSelect
								className="gui-settings-select"
								value={lightThemeId}
								onChange={v => setLightTheme(v as UiThemeId)}
								options={LIGHT_THEME_PRESETS.map(p => ({ value: p.id, label: t(`theme preset ${p.id}`) }))}
							/>
						</div>
					</div>
					<div className="gui-settings-field">
						<div className="gui-settings-field-label">{t("dark theme")}</div>
						<div className="gui-settings-field-hint">{t("dark theme description")}</div>
						<div className="gui-settings-field-control">
							<GuiSelect
								className="gui-settings-select"
								value={darkThemeId}
								onChange={v => setDarkTheme(v as UiThemeId)}
								options={DARK_THEME_PRESETS.map(p => ({ value: p.id, label: t(`theme preset ${p.id}`) }))}
							/>
						</div>
					</div>
				</Reveal>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("interface font size")}</div>
					<NumberStepper
						label={t("interface font size")}
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
					<div className="gui-settings-field-label">{t("interface font")}</div>
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
							title={t("reset")}
							aria-label={t("reset")}
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
					<div className="gui-settings-field-label">{t("spacing density")}</div>
					<NumberStepper
						label={t("spacing density")}
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
					<div className="gui-settings-field-label">{t("turn rail position")}</div>
					<div className="gui-settings-field-hint">{t("turn rail position hint")}</div>
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
								{ value: "right", label: t("right side") },
								{ value: "left", label: t("left side") },
							]}
						/>
					</div>
				</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("turn rail style")}</div>
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
								{ value: "burger", label: t("burger layers") },
								{ value: "pacman", label: t("pacman") },
							]}
						/>
					</div>
				</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("scrollbar style")}</div>
					<div className="gui-settings-field-hint">{t("scrollbar style hint")}</div>
					<div className="gui-settings-field-control">
						<GuiSelect
							className="gui-settings-select"
							value={scrollbarStyle}
							onChange={nv => {
								const v = nv as string;
								setScrollbarStyle(v);
								setPref(SCROLLBAR_STYLE_KEY, v);
								window.dispatchEvent(new Event(SCROLLBAR_STYLE_CHANGED_EVENT));
							}}
							options={[
								...importedSkins.map(s => ({ value: s.id, label: s.displayName })),
								{ value: "builtin-snake", label: t("snake") },
								{ value: "builtin-gummy-rainbow", label: t("gummy rainbow") },
								{ value: "builtin-pacman", label: t("pacman") },
							]}
						/>
						<div className="flex items-center gap-2 mt-2">
							<button
								type="button"
								className="gui-btn gui-btn--small"
								disabled={importingSkin}
								onClick={() => {
									const bridge = (
										window as unknown as {
											electronAPI?: { importScrollbarSkin?(): Promise<unknown> };
										}
									).electronAPI;
									if (!bridge?.importScrollbarSkin) return;
									setImportingSkin(true);
									setSkinError(false);
									void bridge
										.importScrollbarSkin()
										.then(raw => {
											if (!raw) return; // cancelled
											const skin = validateImportedSkin(raw);
											if (!skin) {
												setSkinError(true);
												return;
											}
											saveImportedSkin(skin);
											setImportedSkins(readImportedSkins());
											setScrollbarStyle(skin.id);
											setPref(SCROLLBAR_STYLE_KEY, skin.id);
											window.dispatchEvent(new Event(SCROLLBAR_STYLE_CHANGED_EVENT));
										})
										.catch(() => setSkinError(true))
										.finally(() => setImportingSkin(false));
								}}
							>
								{importingSkin ? "…" : t("import scrollbar skin")}
							</button>
							{skinError && (
								<span className="text-xs" style={{ color: "var(--color-danger, #ff5c5c)" }}>
									{t("invalid scrollbar skin")}
								</span>
							)}
						</div>
					</div>
				</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("accent")}</div>
					<div className="gui-settings-field-hint">{t("accent color")}</div>
					<div className="gui-settings-field-control">
						<div className="flex items-center gap-2">
							{Object.entries(ACCENT_SWATCH).map(([id, color]) => (
								<button
									key={id}
									type="button"
									className={`gui-accent-swatch${accent === id ? " gui-accent-swatch--active" : ""}`}
									style={{ background: color }}
									aria-label={t(ACCENT_NAMES[id] ?? "accent brand")}
									title={t(ACCENT_NAMES[id] ?? "accent brand")}
									onClick={() => setAccent(id as "brand" | "mono" | "ocean" | "jade")}
								/>
							))}
							<button
								ref={accentPickerRef}
								type="button"
								className={`gui-accent-swatch gui-accent-swatch--custom${accent === "custom" ? " gui-accent-swatch--active" : ""}`}
								style={{ background: customAccent }}
								title={t("custom accent")}
								aria-label={t("custom accent")}
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
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("window transparency")}</div>
						<div className="gui-settings-row-desc">{t("window transparency description")}</div>
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
						aria-label={t("window transparency")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<Reveal open={glassEnabled}>
					<div className="gui-settings-field">
						<div className="gui-settings-field-label">{t("glass opacity")}</div>
						<div className="gui-settings-field-hint">{t("glass opacity description")}</div>
						<div className="gui-settings-field-control">
							<div className="gui-segmented gui-glass-seg" role="radiogroup" aria-label={t("glass opacity")}>
								{GLASS_PRESETS.map(p => (
									<button
										key={p.id}
										type="button"
										role="radio"
										aria-checked={glass === p.id}
										className={`gui-seg-btn${glass === p.id ? " gui-seg-btn--active" : ""}`}
										onClick={() => {
											setGlass(p.id);
											setPref("musepi-gui-glass", p.id);
											applyGlassPreset(p);
										}}
									>
										{t(`glass preset ${p.id}`)}
									</button>
								))}
							</div>
						</div>
					</div>
				</Reveal>
			</div>

			{/* ── 代码设置 — code themes / line numbers / wrap / sizes (ZCode). ── */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("code settings")}</div>
				<div className="gui-settings-section-desc">{t("code settings description")}</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("light code theme")}</div>
					<div className="gui-settings-field-hint">{t("light code theme description")}</div>
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
					<div className="gui-settings-field-label">{t("dark code theme")}</div>
					<div className="gui-settings-field-hint">{t("dark code theme description")}</div>
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
						<div className="gui-settings-row-label">{t("show line numbers")}</div>
						<div className="gui-settings-row-desc">{t("show line numbers description")}</div>
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
						aria-label={t("show line numbers")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("wrap long lines")}</div>
						<div className="gui-settings-row-desc">{t("wrap long lines description")}</div>
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
						aria-label={t("wrap long lines")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<div className="gui-settings-field">
					<div className="gui-settings-field-label">{t("code font size")}</div>
					<div className="gui-settings-field-hint">{t("code font size description")}</div>
					<NumberStepper
						label={t("code font size")}
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
					<div className="gui-settings-field-label">{t("code font")}</div>
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
							title={t("reset")}
							aria-label={t("reset")}
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
					<div className="gui-settings-field-label">{t("terminal font size")}</div>
					<NumberStepper
						label={t("terminal font size")}
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
			</div>

			{/* ── 代码预览 — light/dark preview cards (ZCode), the active main
			 * theme's card carries the "currently active" tag. ── */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("code preview")}</div>
				<div className="gui-settings-section-desc">{t("code preview description")}</div>
				<div className="grid grid-cols-2 gap-3">
					<CodePreviewCard
						title={t("light preview")}
						theme={lightTheme}
						active={resolved === "light"}
						scheme="light"
					/>
					<CodePreviewCard
						title={t("dark preview")}
						theme={darkTheme}
						active={resolved === "dark"}
						scheme="dark"
					/>
				</div>
			</div>

			{/* ── Effects (motion / status line / images) with live preview ── */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("effects")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("motion effects")}</div>
						<div className="gui-settings-row-desc">{t("menu popups, orb animation, splash pulse")}</div>
					</div>
					<div className="gui-segmented">
						{(["full", "reduced", "off"] as const).map(m => (
							<button
								key={m}
								type="button"
								className={`gui-seg-btn${motion === m ? " gui-seg-btn--active" : ""}`}
								onClick={() => {
									setMotion(m);
									localStorage.setItem("musepi-gui-motion", m);
									document.documentElement.classList.toggle("gui-motion-off", m === "off");
								}}
							>
								{m === "full" ? t("full") : m === "reduced" ? t("reduced") : t("off")}
							</button>
						))}
					</div>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("info status bar")}</div>
						<div className="gui-settings-row-desc">{t("info status bar desc")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={statusBarInfo}
						className={`gui-toggle${statusBarInfo ? " gui-toggle--on" : ""}`}
						onClick={() => {
							const next = !statusBarInfo;
							setStatusBarInfo(next);
							localStorage.setItem("musepi-gui-statusbar-info", next ? "1" : "0");
						}}
					/>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("inline images")}</div>
						<div className="gui-settings-row-desc">{t("show images inside the transcript")}</div>
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
						aria-label={t("inline images")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<div className="gui-settings-row">
					<div className="flex-1">
						<div className="gui-settings-row-label">{t("show avatars")}</div>
						<div className="gui-settings-row-desc">
							{t("agent orb avatar beside replies, your avatar at the bubble")}
						</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={showAvatars}
						className={`gui-toggle${showAvatars ? " gui-toggle--on" : ""}`}
						onClick={onToggleAvatars}
						aria-label={t("show avatars")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
			</div>

			{/* ── 效果预览 — one mock scene for the whole effects block (code
			 * preview parity): transcript rows reuse the REAL tr-* classes
			 * so bubbles and avatars match the chat surface, above a mock
			 * input card — the same arrangement as the actual composer
			 * column (agent working state now lives in the send button). */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("effects preview")}</div>
				<div className="gui-settings-section-desc">{t("effects preview description")}</div>
				<div className="gui-effect-preview">
					<div className="tr-row">
						<div className="tr-gutter">{showAvatars && <AgentAvatar state="working" size={64} />}</div>
						<div className="tr-body">
							<div className="tr-md">{t("preview agent message")}</div>
						</div>
					</div>
					<div className="tr-row tr-row--user">
						<div className="tr-gutter" />
						<div className="tr-body">
							<div className="tr-md">{t("preview user message")}</div>
						</div>
					</div>
					<div className="gui-effect-preview-composer">
						<div className="gui-effect-preview-input">{t("ask anything, / for commands, @ for context…")}</div>
						<span className="gui-effect-preview-send" aria-hidden>
							<Icon name="send-plane" className="h-3.5 w-3.5" />
						</span>
					</div>
				</div>
			</div>
			{/* TUI appearance-tab parity (schema-driven): theme presets, status
			 * line, display and images groups from settings.schema. */}
			<SchemaTabSection rpc={rpc} tabs={["appearance"]} />
			{/* Chat display settings (previously the 聊天设置 tab): transcript
			 * rendering prefs are appearance — merged into one 外观 page. */}
			<ChatSection />
		</>
	);
}

/** ZCode code-preview card: the selected theme's real colors over a sample
 * snippet; the card matching the active main scheme gets the tag. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: sample code shown verbatim in the preview card
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
	return (
		<div className="gui-code-preview-card">
			<div className="gui-code-preview-head">
				<span className="text-[13px] font-medium">{title}</span>
				<span className="gui-settings-row-desc">{theme.label}</span>
				{active && <span className="gui-code-preview-tag">{t("currently active")}</span>}
			</div>
			<pre className="gui-code-preview-body" style={{ background: theme.bg, color: theme.fg }}>
				{html !== null ? (
					// biome-ignore lint/security/noDangerouslySetInnerHtml: escaped spans built by highlightToCodeHtml
					<code dangerouslySetInnerHTML={{ __html: html }} />
				) : (
					<span className="tr-code-line">{PREVIEW_SNIPPET}</span>
				)}
			</pre>
		</div>
	);
}
