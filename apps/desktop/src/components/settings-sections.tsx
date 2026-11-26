/** Settings page sections — per-concern split of the former
 *  settings-sections.tsx monolith. Each section is a props-driven
 *  component; the host (SettingsView) renders by `section` id. The section
 *  components now live one-per-file in ./settings-sections/; this barrel
 *  keeps the original import surface — every public symbol is re-exported
 *  here unchanged. */

export { TypewriterPreview, useTypewriterSample } from "./MockConversationPreview";
export { TaskCardStylePreview } from "./settings-rows/task-card-style-preview";
export { BrowserSection } from "./settings-sections/browser";
export { ChatSection, PrefSegmented, PrefToggle } from "./settings-sections/chat";
export { CompanionCard, CompanionMarket, CompanionMarketCard, CompanionSection } from "./settings-sections/companion";
export { ConnectorsSection } from "./settings-sections/connectors";
export { ContextSection } from "./settings-sections/context";
export { GitPrefsRow, GitSection } from "./settings-sections/git";
export { IndexesSection } from "./settings-sections/indexes";
export { InteractionSection } from "./settings-sections/interaction";
export { MediaSection } from "./settings-sections/media";
export { ModesSection } from "./settings-sections/modes";
export { SchemaTabSection } from "./settings-sections/schema";
export { SessionMemorySection } from "./settings-sections/session-memory";
export { hitText, NumberStepper } from "./settings-sections/shared";
export { ShellSection } from "./settings-sections/shell";
export { SkillsSection } from "./settings-sections/skills";
export { SubagentsSection } from "./settings-sections/subagents";
export { ToolsSection } from "./settings-sections/tools";
export { VoiceSection } from "./settings-sections/voice";
