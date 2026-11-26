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
export { GitPrefsRow, GitSection } from "./settings-sections/git";
export { InteractionSection } from "./settings-sections/interaction";
export { MediaSection } from "./settings-sections/media";
export { SchemaTabSection } from "./settings-sections/schema";
export { SessionMemorySection } from "./settings-sections/session-memory";
export { hitText, NumberStepper } from "./settings-sections/shared";
export { SkillsSection } from "./settings-sections/skills";
export { VoiceSection } from "./settings-sections/voice";
