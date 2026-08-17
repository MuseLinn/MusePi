/**
 * @musepi/collab-web — shared UI surface for the collab guest app and the
 * MusePi GUI.
 *
 * Re-export the components and utilities that are host-agnostic (pure data
 * props, no GuestClient coupling): the transcript renderer, the full per-tool
 * renderer registry, i18n, theme/language toggles and formatting helpers. The
 * GUI imports from here instead of reimplementing tool cards and transcript
 * chrome.
 */

export { AgentsPanel } from "./components/agents/AgentsPanel";
export { ConnectScreen, type ConnectScreenProps } from "./components/shell/ConnectScreen";
export { LanguageToggle } from "./components/shell/LanguageToggle";
export { ThemeToggle } from "./components/shell/ThemeToggle";
export { type CodeHighlightFn, highlightToCodeHtml } from "./components/transcript/highlight";
export { CodeHighlightProvider, useCodeHighlight } from "./components/transcript/highlight-context";
export { Markdown } from "./components/transcript/Markdown";
export { type MermaidMode, mermaidMode, renderMermaidHtml } from "./components/transcript/mermaid";
export { ToolCard, type ToolCardProps } from "./components/transcript/ToolCard";
export { Transcript, type TranscriptProps } from "./components/transcript/Transcript";
export {
	getLocaleSnapshot,
	type ParamsOf,
	setLocale,
	subscribeLocale,
	type TranslationKey,
	type TranslationMap,
	t,
} from "./i18n/index.js";
export { fmtCost, fmtDuration, fmtPercent, fmtTokens, messageText, relTime, shortenPath } from "./lib/format";
export {
	ACCENT_PRESETS,
	type AccentPreference,
	DARK_THEME_PRESETS,
	LIGHT_THEME_PRESETS,
	type SystemTheme,
	setAccentPreference,
	type ThemePreference,
	type UiThemeId,
	UNIFIED_THEME_PRESETS,
	useAccentPreference,
	useSystemTheme,
	useThemePreference,
	useUiThemePreferences,
} from "./lib/theme";
export * from "./tool-render";
