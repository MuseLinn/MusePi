/**
 * @musepi/desktop-web — shared UI surface for the collab guest app and the
 * MusePi GUI.
 *
 * Re-export the components and utilities that are host-agnostic (pure data
 * props, no GuestClient coupling): the transcript renderer, the full per-tool
 * renderer registry, i18n, theme/language toggles and formatting helpers. The
 * GUI imports from here instead of reimplementing tool cards and transcript
 * chrome.
 */

export { AgentsPanel } from "./components/agents/AgentsPanel";
export { ImageLightbox } from "./components/image-lightbox";
export { ConnectScreen, type ConnectScreenProps } from "./components/shell/ConnectScreen";
export { LanguageToggle } from "./components/shell/LanguageToggle";
export { ThemeToggle } from "./components/shell/ThemeToggle";
export { type CodeHighlightFn, highlightToCodeHtml } from "./components/transcript/highlight";
export { CodeHighlightProvider, useCodeHighlight } from "./components/transcript/highlight-context";
export { DiffBlock, type DiffLayout } from "./tool-render/parts";
export { Markdown } from "./components/transcript/Markdown";
export { type MermaidMode, mermaidMode, renderMermaidHtml } from "./components/transcript/mermaid";
export {
	BlockUnitCounter,
	BURST_WINDOW,
	burstStyleFor,
	CATCHUP_FRAMES,
	countGraphemes,
	FLIP_WINDOW,
	flipStyleFor,
	GLITCH_CHARS,
	GLITCH_WINDOW,
	glitchGlyph,
	glitchScrambled,
	glitchStyleFor,
	graphemeSpans,
	INK_WINDOW,
	inkStyleFor,
	MIN_STEP,
	nextStep,
	RAINBOW_HUE_STEP,
	STREAMING_REVEAL_FRAME_MS,
	sliceGraphemes,
	TAIL_RENDERERS,
	TYPING_FADE_WINDOW,
	typingFadeOpacity,
} from "./components/transcript/reveal";
export { ToolCard, type ToolCardProps } from "./components/transcript/ToolCard";
export { Transcript, type TranscriptProps } from "./components/transcript/Transcript";
export {
	collectWidgetPayloads,
	latestWidgetFromEntries,
	WIDGET_STANDALONE_KEY,
	WidgetCard,
	WidgetFullscreen,
	type WidgetPayload,
	WidgetStandaloneCards,
	widgetStandaloneEnabled,
} from "./components/transcript/widget-standalone";
export {
	getLocaleSnapshot,
	type ParamsOf,
	registerTranslations,
	setLocale,
	subscribeLocale,
	type TranslationKey,
	type TranslationMap,
	t,
	tLoose,
} from "./i18n/index.js";
export { fmtCost, fmtDuration, fmtPercent, fmtTokens, messageText, relTime, shortenPath } from "./lib/format";
export { hashSeed, punkAvatarUri } from "./lib/punk-gen";
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
