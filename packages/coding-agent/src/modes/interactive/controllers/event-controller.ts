/**
 * Event Controller — session event dispatch and handling.
 *
 * Aligned with OMP's event-controller.ts. Owns ALL event routing including
 * message_* and tool_* handlers (not delegated). Self-contained handling here.
 *
 * Controllers owned:
 *  - StreamingRevealController — 30fps grapheme-level typewriter reveal
 *  - ToolArgsRevealController — streaming tool-call argument preview
 */

import type { Component } from "@musepi/pi-tui";
import type { AgentSessionEvent } from "../../../core/agent-session.ts";
import { TtsrManager, type TtsrMatchContext } from "../../../export/ttsr.ts";
import { AssistantMessageComponent } from "../components/assistant-message.ts";
import { ToolExecutionComponent } from "../components/tool-execution.ts";
import type { InteractiveModeContext } from "../types.ts";
import { AdvisorController } from "./advisor-controller.ts";
import { StreamingRevealController } from "./streaming-reveal.ts";
import { ToolArgsRevealController } from "./tool-args-reveal.ts";

type EventKind = AgentSessionEvent["type"];

type EventHandlers = {
	[E in EventKind]?: (event: Extract<AgentSessionEvent, { type: E }>) => Promise<void>;
};

export class EventController {
	readonly #ctx: InteractiveModeContext;
	#handlers: EventHandlers;
	readonly #streamingReveal: StreamingRevealController;
	readonly #toolArgsReveal: ToolArgsRevealController;
	readonly #advisor: AdvisorController;
	readonly #ttsr: TtsrManager;

	/** Resolve tool display style from settings. */
	get #toolDisplayStyle(): "bordered" | "filled" {
		try {
			const musepi = this.#ctx.settingsManager.getMusepi();
			const style = (musepi as any).edit?.toolDisplayStyle;
			if (style === "filled" || style === "bordered") return style;
		} catch {}
		return "bordered";
	}

	constructor(ctx: InteractiveModeContext) {
		this.#ctx = ctx;
		this.#ttsr = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "once",
			repeatGap: 10,
		});
		this.#streamingReveal = new StreamingRevealController({
			getSmoothStreaming: () => true,
			getHideThinkingBlock: () => ctx.hideThinkingBlock,
			getProseOnlyThinking: () => true,
			requestRender: (_component: Component) => ctx.requestRender(),
		});
		this.#toolArgsReveal = new ToolArgsRevealController({
			getSmoothStreaming: () => true,
			requestRender: (_component: Component) => ctx.requestRender(),
		});
		this.#advisor = new AdvisorController(ctx);
		this.#handlers = {
			// ── All handled here ─────────────────────────────────
			session_info_changed: async () => this.#handleSessionInfoChanged(),
			thinking_level_changed: async () => this.#handleThinkingLevelChanged(),
			queue_update: async () => this.#handleQueueUpdate(),
			entry_appended: async (e) => this.#handleEntryAppended(e),
			bash_execution_update: async () => {},
			message_start: async (e) => this.#handleMessageStart(e),
			message_update: async (e) => this.#handleMessageUpdate(e),
			message_end: async (e) => {
				await this.#handleMessageEnd(e);
				this.#advisor.submitTurn();
			},
			tool_execution_start: async (e) => this.#handleToolExecutionStart(e),
			tool_execution_update: async (e) => this.#handleToolExecutionUpdate(e),
			tool_execution_end: async (e) => this.#handleToolExecutionEnd(e),

			// ── Delegated (deeply coupled, low value to extract) ─
			agent_start: async (e) => {
				this.#advisor.start();
				await this.#ctx.handleEvent(e);
			},
			agent_end: async (e) => this.#ctx.handleEvent(e),
			compaction_start: async (e) => this.#ctx.handleEvent(e),
			compaction_end: async (e) => this.#ctx.handleEvent(e),
			auto_retry_start: async (e) => this.#ctx.handleEvent(e),
			auto_retry_end: async (e) => this.#ctx.handleEvent(e),
		};
	}

	async handleEvent(event: AgentSessionEvent): Promise<void> {
		const handler = this.#handlers[event.type as EventKind];
		if (handler) {
			await (handler as (event: AgentSessionEvent) => Promise<void>)(event);
		}
	}

	dispose(): void {
		this.#streamingReveal.stop();
		this.#toolArgsReveal.stop();
		this.#advisor.dispose();
		this.#ttsr.resetBuffer();
	}

	// ── message_* handlers ──────────────────────────────────────

	async #handleMessageStart(event: Extract<AgentSessionEvent, { type: "message_start" }>): Promise<void> {
		const msg = event.message;
		if (msg.role === "custom") {
			this.#ctx.addMessageToChat(msg);
			this.#ctx.requestRender();
		} else if (msg.role === "user") {
			this.#ctx.addMessageToChat(msg);
			this.#ctx.updatePendingMessagesDisplay();
			this.#ctx.requestRender();
		} else if (msg.role === "assistant") {
			const component = new AssistantMessageComponent(
				undefined,
				this.#ctx.hideThinkingBlock,
				this.#ctx.getMarkdownThemeWithSettings(),
				this.#ctx.hiddenThinkingLabel,
				this.#ctx.outputPad,
			);
			this.#ctx.streamingComponent = component;
			this.#ctx.streamingMessage = msg;
			this.#ctx.chatContainer.addChild(component);
			component.updateContent(msg);

			// Start streaming reveal immediately (no frame delay)
			this.#streamingReveal.begin(component, msg);

			// Reset TTSR buffer for this assistant turn
			this.#ttsr.resetBuffer();

			this.#ctx.requestRender();
		}
	}

	async #handleMessageUpdate(event: Extract<AgentSessionEvent, { type: "message_update" }>): Promise<void> {
		const component = this.#ctx.streamingComponent;
		const msg = event.message;
		if (component && msg.role === "assistant") {
			this.#ctx.streamingMessage = msg;
			component.updateContent(msg);

			// Continue streaming reveal
			this.#streamingReveal.setTarget(msg);

			// TTSR: check text content for rule matches
			const textBlocks = msg.content.filter((b) => b.type === "text");
			for (const block of textBlocks) {
				const ttsrCtx: TtsrMatchContext = { source: "text" };
				const matched = this.#ttsr.checkDelta("text" in block ? ((block as any).text ?? "") : "", ttsrCtx);
				if (matched.length > 0) {
					// Mark injected and abort for retry
					this.#ttsr.markInjected(matched);
					this.#ctx.abortForTTSR(matched.map((r) => ({ name: r.name, description: r.description })));
					return;
				}
			}

			for (const content of msg.content) {
				if (content.type === "toolCall") {
					if (!this.#ctx.pendingTools.has(content.id)) {
						const toolComponent = new ToolExecutionComponent(
							content.name,
							content.id,
							content.arguments,
							{
								showImages: this.#ctx.settingsManager.getShowImages(),
								imageWidthCells: this.#ctx.settingsManager.getImageWidthCells(),
								displayStyle: this.#toolDisplayStyle,
							},
							this.#ctx.getRegisteredToolDefinition(content.name),
							this.#ctx.ui,
							this.#ctx.sessionManager.getCwd(),
						);
						toolComponent.setExpanded(this.#ctx.toolOutputExpanded);
						this.#ctx.chatContainer.addChild(toolComponent);
						this.#ctx.pendingTools.set(content.id, toolComponent);
					} else {
						const existing = this.#ctx.pendingTools.get(content.id);
						if (existing) {
							existing.updateArgs(content.arguments);
						}
					}
				}
			}
			this.#ctx.requestRender();
		}
	}

	async #handleMessageEnd(event: Extract<AgentSessionEvent, { type: "message_end" }>): Promise<void> {
		const msg = event.message;
		if (msg.role === "user") return;

		const component = this.#ctx.streamingComponent;
		if (component && msg.role === "assistant") {
			this.#ctx.streamingMessage = msg;
			let errorMessage: string | undefined;
			if (msg.stopReason === "aborted") {
				const retryAttempt = this.#ctx.session.retryAttempt;
				errorMessage =
					retryAttempt > 0
						? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
						: "Operation aborted";
				msg.errorMessage = errorMessage;
			}
			component.updateContent(msg);

			// Finalize reveals
			this.#streamingReveal.stop();
			this.#toolArgsReveal.stop();

			if (msg.stopReason === "aborted" || msg.stopReason === "error") {
				if (!errorMessage) {
					errorMessage = msg.errorMessage || "Error";
				}
				for (const [, toolComponent] of this.#ctx.pendingTools.entries()) {
					toolComponent.updateResult({
						content: [{ type: "text", text: errorMessage }],
						isError: true,
					});
				}
				this.#ctx.pendingTools.clear();
				this.#ctx.showPinnedError(errorMessage);
			} else {
				for (const [, toolComponent] of this.#ctx.pendingTools.entries()) {
					toolComponent.setArgsComplete();
				}
				this.#ctx.maybeShowCacheMissNotice(msg);
			}
			this.#ctx.streamingComponent = undefined;
			this.#ctx.streamingMessage = undefined;
			this.#ctx.footer.invalidate();
		}
		this.#ctx.requestRender();
	}

	// ── tool_* handlers ─────────────────────────────────────────

	async #handleToolExecutionStart(event: Extract<AgentSessionEvent, { type: "tool_execution_start" }>): Promise<void> {
		let component = this.#ctx.pendingTools.get(event.toolCallId);
		if (!component) {
			component = new ToolExecutionComponent(
				event.toolName,
				event.toolCallId,
				event.args,
				{
					showImages: this.#ctx.settingsManager.getShowImages(),
					imageWidthCells: this.#ctx.settingsManager.getImageWidthCells(),
					displayStyle: this.#toolDisplayStyle,
				},
				this.#ctx.getRegisteredToolDefinition(event.toolName),
				this.#ctx.ui,
				this.#ctx.sessionManager.getCwd(),
			);
			component.setExpanded(this.#ctx.toolOutputExpanded);
			this.#ctx.chatContainer.addChild(component);
			this.#ctx.pendingTools.set(event.toolCallId, component);
		}
		component.markExecutionStarted();

		// Start tool args reveal
		this.#toolArgsReveal.setTarget(event.toolCallId, event.args, {
			rawInput: false,
			exposeRawPartialJson: false,
			streamingStringKeys: undefined,
		});
		// Stop streaming reveal before tool card renders
		this.#streamingReveal.stop();

		this.#ctx.requestRender();
	}

	async #handleToolExecutionUpdate(
		event: Extract<AgentSessionEvent, { type: "tool_execution_update" }>,
	): Promise<void> {
		const component = this.#ctx.pendingTools.get(event.toolCallId);
		if (component) {
			component.updateResult({ ...event.partialResult, isError: false }, true);
			this.#ctx.requestRender();
		}
	}

	async #handleToolExecutionEnd(event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>): Promise<void> {
		const component = this.#ctx.pendingTools.get(event.toolCallId);
		if (component) {
			component.updateResult({ ...event.result, isError: event.isError });
			this.#ctx.pendingTools.delete(event.toolCallId);
			this.#ctx.requestRender();
		}
	}

	// ── Self-contained handlers ─────────────────────────────────

	async #handleSessionInfoChanged(): Promise<void> {
		this.#ctx.updateTerminalTitle();
		this.#ctx.footer.invalidate();
		this.#ctx.requestRender();
	}

	async #handleThinkingLevelChanged(): Promise<void> {
		this.#ctx.footer.invalidate();
		this.#ctx.updateEditorBorderColor();
	}

	async #handleQueueUpdate(): Promise<void> {
		this.#ctx.updatePendingMessagesDisplay();
		this.#ctx.requestRender();
	}

	async #handleEntryAppended(event: Extract<AgentSessionEvent, { type: "entry_appended" }>): Promise<void> {
		if (event.entry.type === "custom") {
			this.#ctx.addCustomEntryToChat(event.entry as Extract<typeof event.entry, { type: "custom" }>);
			this.#ctx.requestRender();
		}
	}
}
