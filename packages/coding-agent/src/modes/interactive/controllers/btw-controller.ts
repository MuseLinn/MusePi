/**
 * BTW (By The Way) controller — side-channel conversation panel.
 *
 * /btw <question> — opens a dedicated panel with streaming answer
 * and keyboard shortcuts (Esc dismiss, c copy, b branch).
 */

import { runBtwTurn } from "../../../musepi/btw.ts";
import { BtwPanelComponent } from "../../../musepi/btw-panel.ts";
import { copyToClipboard } from "../../../utils/clipboard.ts";
import { theme } from "../theme/theme.ts";
import type { InteractiveModeContext } from "../types.ts";

export class BtwController {
	#panel: BtwPanelComponent | null = null;
	#abortController: AbortController | null = null;
	#ctx: InteractiveModeContext;
	#copyInFlight = false;
	#branchInFlight = false;
	#lastQuestion: string | undefined;

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

	/** Whether the active panel has text ready to copy. */
	canCopy(): boolean {
		return this.#panel?.isCopyable() === true && !this.#copyInFlight;
	}

	/** Handle copy — copies BTW answer to clipboard. Returns true if consumed. */
	async handleCopy(): Promise<boolean> {
		if (!this.canCopy()) return false;
		const text = this.#panel!.getCopyText();
		if (!text) return false;

		this.#copyInFlight = true;
		try {
			await copyToClipboard(text);
			this.#ctx.showStatus("Copied to clipboard");
		} catch {
			this.#ctx.showStatus("Failed to copy");
		}
		this.#copyInFlight = false;
		return true;
	}

	/** Whether the active panel can be branched into the main chat. */
	canBranch(): boolean {
		return this.#panel?.isCopyable() === true && !this.#branchInFlight;
	}

	/** Handle branch (b) key — fork BTW answer into main session. Returns true if consumed. */
	async handleBranch(): Promise<boolean> {
		if (!this.canBranch()) return false;
		const text = this.#panel!.getBranchText();
		if (!text || !this.#lastQuestion) return false;

		this.#branchInFlight = true;
		try {
			// TODO: wire proper branch → fork session with BTW answer
			// this.#ctx.session.sendCustomMessage(...)
			this.#ctx.showStatus("Branch not yet wired — coming soon");
		} catch {
			this.#ctx.showStatus("Branch failed");
		}
		this.#branchInFlight = false;
		return true;
	}

	/** Start a new /btw turn with the given question. */
	async start(question: string): Promise<void> {
		if (!question) {
			this.#ctx.showError("Usage: /btw <question>");
			return;
		}
		if (!this.#ctx.session.model) {
			this.#ctx.showError("No model selected");
			return;
		}

		this.close();

		this.#lastQuestion = question;

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

	dispose(): void {
		this.close();
	}
}
