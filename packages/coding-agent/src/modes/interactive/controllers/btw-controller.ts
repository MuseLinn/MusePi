/**
 * BTW (By The Way) controller — side-channel conversation panel.
 *
 * Extracted from InteractiveMode to keep the mode class focused on
 * orchestration (lifecycle, key routing, session wiring).
 *
 * /btw <question> — opens a dedicated panel with streaming answer
 * and keyboard shortcuts (Esc dismiss, c copy, b branch).
 */

import { runBtwTurn } from "../../../musepi/btw.ts";
import { BtwPanelComponent } from "../../../musepi/btw-panel.ts";
import { theme } from "../theme/theme.ts";
import type { InteractiveModeContext } from "../types.ts";

export class BtwController {
	#panel: BtwPanelComponent | null = null;
	#abortController: AbortController | null = null;
	#ctx: InteractiveModeContext;

	constructor(ctx: InteractiveModeContext) {
		this.#ctx = ctx;
	}

	/** Whether a BTW panel is currently open. */
	hasActive(): boolean {
		return this.#panel !== null;
	}

	/** Handle Escape while BTW panel is open. Returns true if consumed. */
	handleEscape(): boolean {
		if (!this.#panel) return false;
		this.close();
		return true;
	}

	/** Start a new /btw turn with the given question. */
	async start(question: string): Promise<void> {
		if (!question) {
			this.#ctx.showError("Usage: /btw <question>");
			return;
		}
		if (!this.#ctx.session.model) {
			this.#ctx.showError("No model selected — pick a model before using /btw.");
			return;
		}

		// Close any existing panel
		this.close();

		// Create panel
		const panel = new BtwPanelComponent(question, (s: string) => theme.fg("accent", s));
		this.#panel = panel;
		this.#ctx.chatContainer.addChild(panel);
		this.#ctx.requestRender();

		this.#abortController = new AbortController();

		try {
			const answer = await runBtwTurn(this.#ctx.session, question, this.#abortController.signal, (delta: string) => {
				panel.appendText(delta);
				this.#ctx.requestRender();
			});
			panel.setAnswer(answer);
			panel.markComplete();
		} catch (error: unknown) {
			if (error instanceof Error && error.name === "AbortError") {
				panel.markAborted();
			} else {
				panel.markError(error instanceof Error ? error.message : String(error));
			}
		}
		this.#ctx.requestRender();
	}

	/** Close the active panel and clean up. */
	close(): void {
		if (this.#abortController) {
			this.#abortController.abort();
			this.#abortController = null;
		}
		if (this.#panel) {
			this.#panel.close();
			this.#ctx.chatContainer.removeChild(this.#panel);
			this.#panel = null;
		}
	}

	/** Clean up all resources. */
	dispose(): void {
		this.close();
	}
}
