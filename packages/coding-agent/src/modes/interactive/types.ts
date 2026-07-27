/**
 * Context interface for InteractiveMode controllers.
 *
 * Controllers receive an InteractiveModeContext (which is the InteractiveMode
 * instance itself) and use it to access session, UI, and configuration without
 * depending on the full class shape.
 */

import type { AgentMessage } from "@musepi/pi-agent-core";
import type { AssistantMessage, Model } from "@musepi/pi-ai/compat";
import type { Component, Container, EditorComponent, MarkdownTheme, TUI } from "@musepi/pi-tui";
import type { AgentSession, AgentSessionEvent } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import type { SessionManager } from "../../core/session-manager.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import type { AssistantMessageComponent } from "./components/assistant-message.ts";
import type { ToolExecutionComponent } from "./components/tool-execution.ts";
import type { Theme } from "./theme/theme.ts";

/**
 * Context interface for InteractiveMode controllers.
 *
 * Controllers receive an InteractiveModeContext (which is the InteractiveMode
 * instance itself) and use it to access session, UI, and configuration without
 * depending on the full class shape.
 *
 * Expand this interface as each new controller needs more from InteractiveMode.
 */
export interface InteractiveModeContext {
	// UI access
	readonly ui: TUI;
	readonly chatContainer: Container;
	readonly keybindings: KeybindingsManager;
	readonly theme: Theme;

	// Session access
	readonly session: AgentSession;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly runtimeHost: AgentSessionRuntime;

	// Status / display
	showStatus(message: string): void;
	showError(message: string): void;
	showWarning(message: string): void;
	requestRender(): void;
	clearStatusIndicator(): void;

	// Key display helpers
	getEditorKeyDisplay(action: string): string;
	getAppKeyDisplay(action: string): string;

	// Theme helpers
	getMarkdownTheme(): MarkdownTheme;
	getMarkdownThemeWithSettings(): MarkdownTheme;

	// Editor access
	readonly editor: EditorComponent;
	readonly defaultEditor: { getHistory(): readonly string[] };

	// Input mode
	readonly isBashMode: boolean;

	// Shutdown / cleanup
	clearEditor(): void;
	shutdown(options?: { fromSignal?: boolean }): Promise<void>;

	// Footer
	readonly footer: { invalidate(): void };

	// Border color
	updateEditorBorderColor(): void;

	// Model post-selection warnings
	warnAboutModel(model: Model<any>): void;

	// Fullscreen overlay management
	musepiEnterFullscreen(component: Component & { dispose?(): void }): void;
	musepiExitFullscreen(): void;

	// Selector overlays
	showSelector(create: (done: () => void) => { component: Component; focus: Component }): void;
	showFullscreenSelector(create: (done: () => void) => { component: Component; focus: Component }): void;

	// Dialog helpers
	showExtensionConfirm(title: string, message: string): Promise<boolean>;

	// ── Event handling ─────────────────────────────────────────
	/** Event dispatch — controller handles self-contained events, delegates coupled ones back. */
	handleEvent(event: AgentSessionEvent): Promise<void>;

	/** InteractiveMode convenience accessors needed by EventController's self-contained handlers. */
	updateTerminalTitle(): void;
	updatePendingMessagesDisplay(): void;
	addCustomEntryToChat(entry: Extract<AgentSessionEvent, { type: "entry_appended" }>["entry"]): void;
	addMessageToChat(message: AgentMessage): void;

	// ── Streaming reveal state (set by handler implementations) ─────
	/** Currently streaming assistant message component. */
	streamingComponent: AssistantMessageComponent | undefined;
	/** Currently streaming assistant message data. */
	streamingMessage: AssistantMessage | undefined;
	/** Map of toolCallId → ToolExecutionComponent for pending tool calls. */
	pendingTools: Map<string, ToolExecutionComponent>;

	/** Currently effective hide-thinking-block setting. */
	hideThinkingBlock: boolean;
	/** Label for hidden thinking blocks. */
	hiddenThinkingLabel: string;
	/** Output padding. */
	outputPad: number;
	/** Tool output expansion state. */
	toolOutputExpanded: boolean;

	/** Show a pinned error banner at the top of the chat. */
	showPinnedError(message: string): void;
	/** Optionally show a cache-miss notice for the given message. */
	maybeShowCacheMissNotice(message: AssistantMessage): void;
	/** Get the registered tool definition for a tool name (for rendering). */
	getRegisteredToolDefinition(toolName: string): import("../../core/extensions/types.ts").ToolDefinition | undefined;

	/**
	 * Abort the current stream for TTSR: abort the session turn, inject matched
	 * rules as context, and let the auto-retry mechanism regenerate.
	 */
	abortForTTSR(rules: ReadonlyArray<{ name: string; description?: string }>): void;
}
