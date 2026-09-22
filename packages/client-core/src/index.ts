/**
 * @musepi/client-core — shared UI surface for the collab guest app and the
 * MusePi GUI.
 *
 * Re-export the components and utilities that are host-agnostic (pure data
 * props, no GuestClient coupling): the transcript renderer, the full per-tool
 * renderer registry, i18n, theme/language toggles and formatting helpers. The
 * GUI imports from here instead of reimplementing tool cards and transcript
 * chrome.
 */

export { AgentsPanel } from "./components/agents/AgentsPanel";
export { BarChart, type BarChartProps, type BarChartSerie } from "./components/charts/BarChart";
export { Donut, type DonutProps } from "./components/charts/Donut";
export { Gauge, type GaugeProps } from "./components/charts/Gauge";
export { KLine, type KLineCandle, type KLineProps } from "./components/charts/KLine";
export { LineChart, type LineChartProps, type LineChartSerie } from "./components/charts/LineChart";
export { Sparkline, type SparklineProps } from "./components/charts/Sparkline";
export { ImageLightbox } from "./components/image-lightbox";
/** Marketplace plugin store (GUI ↔ guest-client shared). The Marketplace
 *  panel itself stays in-app (it binds to SessionClient); the Grid + Card
 *  + Entry types are host-agnostic so the Electron GUI reuses them. */
export { MarketplaceCard } from "./components/marketplace/MarketplaceCard";
export { MarketplaceGrid } from "./components/marketplace/MarketplaceGrid";
export type { MarketplaceCardAction, MarketplaceCardEntry } from "./components/marketplace/types";
export { resolveCardIcon } from "./components/marketplace/types";
/** reactbits-parity brand chrome (zero-dependency, shared GUI ↔ guest): the
 *  blur-in wordmark reveal, shiny text sweep, cursor spotlight card and the
 *  interactive dot-matrix brand mark. The desktop app imports these from
 *  here instead of keeping local copies. */
export { BlurText } from "./components/shell/BlurText";
export { ConnectScreen, type ConnectScreenProps } from "./components/shell/ConnectScreen";
export { DotMatrixMark } from "./components/shell/DotMatrixMark";
export { LanguageToggle } from "./components/shell/LanguageToggle";
/** Sliding-thumb segmented control (shared by the header theme switch and
 *  the settings rows) — see styles/tokens.css § Segmented control. */
export { Segmented, type SegmentedOption } from "./components/shell/Segmented";
export { ShinyText } from "./components/shell/ShinyText";
export { SpotlightCard } from "./components/shell/SpotlightCard";
export { ThemeToggle } from "./components/shell/ThemeToggle";
export { type CodeHighlightFn, highlightToCodeHtml } from "./components/transcript/highlight";
export { CodeHighlightProvider, useCodeHighlight } from "./components/transcript/highlight-context";
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
export {
	Transcript,
	type TranscriptAnchor,
	type TranscriptAnchorCtl,
	type TranscriptNodeInjection,
	type TranscriptProps,
	transcriptNodeKind,
} from "./components/transcript/Transcript";
export { buildTurnIndex, TURN_SUMMARY_MAX, type TurnIndexItem } from "./components/transcript/turn-index";
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
export * from "./lib/download";
export { fmtCost, fmtDuration, fmtPercent, fmtTokens, messageText, relTime, shortenPath } from "./lib/format";
export { hashSeed, punkAvatarUri } from "./lib/punk-gen";
export {
	type ArchivedSession,
	archivedSessionIds,
	archiveSession,
	clearArchivedSessions,
	isSessionArchived,
	onArchivedSessionsChanged,
	readArchivedSessions,
	SESSION_ARCHIVE_EVENT,
	toggleArchivedSession,
	unarchiveSession,
	useArchivedSessions,
	writeArchivedSessions,
} from "./lib/session-archive";
export {
	ACCENT_PRESETS,
	type AccentPreference,
	accentInkContrast,
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
export { DiffBlock, type DiffLayout } from "./tool-render/parts";
