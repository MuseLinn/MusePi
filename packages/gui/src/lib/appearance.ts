/**
 * Appearance preferences shared between the settings UI (SettingsView) and
 * the startup application in app.tsx. Font picks persist by id and apply as
 * --font-ui / --font-mono on <html> (inline style beats the tokens.css
 * defaults); the spacing-density stepper scales paddings via --gui-density.
 */

export interface FontOption {
	id: string;
	label: string;
	/** Full font-family stack, applied to the matching CSS variable. */
	stack: string;
}

/** Default UI stack — a modern serif (Claude-style reading face, user
 * pick) with CJK falling back to the system serif (Songti on macOS).
 * The bundled font is Source Serif 4 (fonts.css latin subset); the old
 * Inter stack stays available as the "Inter" option. */
export const SYSTEM_UI_STACK =
	'"Source Serif 4 Variable", ui-serif, Georgia, "Songti SC", "Noto Serif SC", "SimSun", serif';

/** Default mono stack — bundled Maple Mono CN chunks (fonts.css) with the
 * Nerd-Font variant first when installed locally, then system monos. */
export const SYSTEM_MONO_STACK =
	'"Maple Mono NF CN", "Maple Mono CN", ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace';

export const UI_FONT_OPTIONS: FontOption[] = [
	{ id: "system", label: "Serif (Source Serif 4)", stack: SYSTEM_UI_STACK },
	{
		id: "inter",
		label: "Inter",
		stack: "'Inter Variable', 'Inter', ui-sans-serif, system-ui, sans-serif",
	},
	{
		id: "pingfang",
		label: "PingFang SC",
		stack: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, sans-serif",
	},
	{
		id: "jetbrains",
		label: "JetBrains Mono",
		stack: "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, monospace",
	},
];

export const CODE_FONT_OPTIONS: FontOption[] = [
	{ id: "system", label: "Maple Mono", stack: SYSTEM_MONO_STACK },
	{
		id: "maple",
		label: "Maple Mono NF CN",
		stack: "'Maple Mono NF CN', 'Maple Mono CN', ui-monospace, monospace",
	},
	{
		id: "jetbrains",
		label: "JetBrains Mono",
		stack: "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, monospace",
	},
	{ id: "sfmono", label: "SF Mono", stack: "'SF Mono', ui-monospace, Menlo, monospace" },
	{ id: "menlo", label: "Menlo", stack: "Menlo, ui-monospace, monospace" },
	{ id: "cascadia", label: "Cascadia Code", stack: "'Cascadia Code', ui-monospace, monospace" },
];

export const DEFAULT_UI_FONT: FontOption = UI_FONT_OPTIONS[0]!;
export const DEFAULT_CODE_FONT: FontOption = CODE_FONT_OPTIONS[0]!;

/** localStorage keys for the appearance prefs. */
export const UI_FONT_KEY = "musepi-gui-ui-font";
export const MONO_FONT_KEY = "musepi-gui-mono-font";
export const DENSITY_KEY = "musepi-gui-density";
export const TIME_FMT_KEY = "musepi-gui-timefmt";
export const WEEK_START_KEY = "musepi-gui-weekstart";
export const EDITOR_FONT_KEY = "musepi-gui-editor-font";

/**
 * Code block themes (ZCode-parity 代码设置): one pick per scheme, applied as
 * --code-bg-{light,dark} / --code-fg-{light,dark} CSS vars on <html>. The
 * transcript CSS selects the active pair through [data-theme], so switching
 * the app theme re-colors code blocks without a re-render.
 */
export interface CodeTheme {
	id: string;
	label: string;
	/** Code block background (light scheme value). */
	bg: string;
	/** Code block foreground (light scheme value). */
	fg: string;
}

export const LIGHT_CODE_THEMES: CodeTheme[] = [
	{ id: "github-light", label: "GitHub Light", bg: "#f6f8fa", fg: "#1f2328" },
	{ id: "one-light", label: "One Light", bg: "#fafafa", fg: "#383a42" },
	{ id: "solarized-light", label: "Solarized Light", bg: "#fdf6e3", fg: "#586e75" },
];

export const DARK_CODE_THEMES: CodeTheme[] = [
	{ id: "github-dark", label: "GitHub Dark", bg: "#0d1117", fg: "#e6edf3" },
	{ id: "one-dark", label: "One Dark", bg: "#282c34", fg: "#abb2bf" },
	{ id: "dracula", label: "Dracula", bg: "#282a36", fg: "#f8f8f2" },
];

export const DEFAULT_LIGHT_CODE_THEME: CodeTheme = LIGHT_CODE_THEMES[0]!;
export const DEFAULT_DARK_CODE_THEME: CodeTheme = DARK_CODE_THEMES[0]!;

export const CODE_THEME_LIGHT_KEY = "musepi-gui-code-theme-light";
export const CODE_THEME_DARK_KEY = "musepi-gui-code-theme-dark";
/** Line numbers + long-line wrap (ZCode 代码设置 toggles). */
export const CODE_LINES_KEY = "musepi-gui-code-lines";
export const CODE_WRAP_KEY = "musepi-gui-code-wrap";

/** Weekday i18n keys indexed by JS day number (0 = Sunday). */
export const WEEKDAY_KEYS = [
	"scheduled sun",
	"scheduled mon",
	"scheduled tue",
	"scheduled wed",
	"scheduled thu",
	"scheduled fri",
	"scheduled sat",
];

/** Week start from the settings page (auto → Monday for zh locale), as a
 *  day index (0 = Sunday). Calendar grids and weekday pickers rotate to
 *  match instead of hardcoding Sunday first. */
export function weekStartIndex(): number {
	const v = localStorage.getItem(WEEK_START_KEY);
	if (v === "sunday") return 0;
	if (v === "monday") return 1;
	return 1; // auto → Monday (zh-CN)
}

/** Weekday i18n keys ordered from the configured week start. */
export function orderedWeekdayKeys(): string[] {
	const start = weekStartIndex();
	return Array.from({ length: 7 }, (_, i) => WEEKDAY_KEYS[(start + i) % 7]!);
}

const findCodeTheme = (options: CodeTheme[], id: string | null): CodeTheme =>
	options.find(o => o.id === id) ?? options[0]!;

/** Apply the light/dark code theme pair as CSS vars (--code-bg-* / --code-fg-*). */
export function applyCodeThemes(
	lightId: string | null,
	darkId: string | null,
	root: HTMLElement = document.documentElement,
): void {
	const light = findCodeTheme(LIGHT_CODE_THEMES, lightId);
	const dark = findCodeTheme(DARK_CODE_THEMES, darkId);
	root.style.setProperty("--code-bg-light", light.bg);
	root.style.setProperty("--code-fg-light", light.fg);
	root.style.setProperty("--code-bg-dark", dark.bg);
	root.style.setProperty("--code-fg-dark", dark.fg);
}

/** Apply the code font size (code blocks / previews / diffs) as --gui-code-size. */
export function applyCodeSize(value: number, root: HTMLElement = document.documentElement): void {
	root.style.setProperty("--gui-code-size", `${value}px`);
}

const findFont = (options: FontOption[], id: string | null): FontOption =>
	options.find(o => o.id === id) ?? options[0]!;

const clampDensity = (value: number): number => (Number.isFinite(value) ? Math.min(200, Math.max(50, value)) : 100);

/** Apply one font pick to the UI font variable (--font-ui). */
export function applyUiFont(id: string | null, root: HTMLElement = document.documentElement): void {
	root.style.setProperty("--font-ui", findFont(UI_FONT_OPTIONS, id).stack);
}

/** Apply one font pick to the code font variable (--font-mono). */
export function applyMonoFont(id: string | null, root: HTMLElement = document.documentElement): void {
	root.style.setProperty("--font-mono", findFont(CODE_FONT_OPTIONS, id).stack);
}

/** Apply the spacing density (50-200, % of default) as --gui-density.
 * Stored as a UNITLESS factor (1 = 100%): `calc(28px * var(--gui-density))`
 * is only valid when the var is a plain number — a percentage operand makes
 * the whole calc() invalid and the padding silently falls back to 0. */
export function applyDensity(value: number, root: HTMLElement = document.documentElement): void {
	root.style.setProperty("--gui-density", String(clampDensity(value) / 100));
}

/** Re-apply every persisted appearance pref (fonts + density) — runs at
 * startup so choices survive relaunches, and after settings changes. */
export function applyAppearancePrefs(root: HTMLElement = document.documentElement): void {
	try {
		applyUiFont(localStorage.getItem(UI_FONT_KEY), root);
		applyMonoFont(localStorage.getItem(MONO_FONT_KEY), root);
		applyDensity(Number(localStorage.getItem(DENSITY_KEY) ?? 100), root);
		applyCodeThemes(localStorage.getItem(CODE_THEME_LIGHT_KEY), localStorage.getItem(CODE_THEME_DARK_KEY), root);
		applyCodeSize(Number(localStorage.getItem(EDITOR_FONT_KEY) ?? 13), root);
	} catch {
		// storage unavailable
	}
}
