/** Settings page sections — per-concern split of the former
 *  settings-sections.tsx monolith. Each section is a props-driven
 *  component; the host (SettingsView) renders by `section` id. The section
 *  components now live one-per-file in ./settings-sections/; this barrel
 *  keeps the original import surface — every public symbol is re-exported
 *  here unchanged. */
export { AppearanceSection, CodePreviewCard } from "./settings-sections/appearance";
export { BrowserSection } from "./settings-sections/browser";
export {
	ChatSection,
	PrefSegmented,
	PrefToggle,
	TypewriterPreview,
	useTypewriterSample,
} from "./settings-sections/chat";
export { CommandsSection } from "./settings-sections/commands";
export { ContextSection } from "./settings-sections/context";
export { FilesLspSection } from "./settings-sections/files";
export { GeneralSection, TaskCardStylePreview } from "./settings-sections/general";
export { GitPrefsRow, GitSection } from "./settings-sections/git";
export { HistorySection } from "./settings-sections/history";
export { HooksSection } from "./settings-sections/hooks";
export { IndexesSection } from "./settings-sections/indexes";
export { InteractionSection } from "./settings-sections/interaction";
export { McpSection } from "./settings-sections/mcp";
export { MemorySection } from "./settings-sections/memory";
export { ModelSection } from "./settings-sections/model";
export { ModesSection } from "./settings-sections/modes";
export { NotificationsSection, SoundEventRow } from "./settings-sections/notifications";
export { PetCard, PetMarket, PetMarketCard, PetSection } from "./settings-sections/pet";
export { SchemaTabSection } from "./settings-sections/schema";
export { SessionsSection } from "./settings-sections/sessions";
export { hitText, NumberStepper } from "./settings-sections/shared";
export { ShellSection } from "./settings-sections/shell";
export { ShortcutsSection } from "./settings-sections/shortcuts";
export { SkillsSection } from "./settings-sections/skills";
export { SubagentsSection } from "./settings-sections/subagents";
export { PromptsSection } from "./settings-sections/suggestions";
export { ToolsSection } from "./settings-sections/tools";
export { fmtCompact, fmtCost, fmtMs, UsageSection } from "./settings-sections/usage";
export { VoiceSection } from "./settings-sections/voice";
