/**
 * Input Controller — keyboard input and Ctrl+key handling.
 *
 * Ported from OMP's input-controller.ts.
 * Manages Ctrl+C/D/Z and editor input processing.
 */

import type { InteractiveModeContext } from "../types.ts";

export class InputController {
	readonly #ctx: InteractiveModeContext;
	#lastSigintTime = 0;

	constructor(ctx: InteractiveModeContext) {
		this.#ctx = ctx;
	}

	dispose(): void {
		// Nothing to dispose yet
	}

	handleCtrlC(): void {
		const now = Date.now();
		if (now - this.#lastSigintTime < 500) {
			void this.#ctx.shutdown();
		} else {
			this.#ctx.clearEditor();
			this.#lastSigintTime = now;
		}
	}

	handleCtrlD(): void {
		// Only called when editor is empty (enforced by CustomEditor)
		void this.#ctx.shutdown();
	}

	handleCtrlZ(): void {
		if (process.platform === "win32") {
			this.#ctx.showStatus("Suspend to background is not supported on Windows");
			return;
		}

		// Keep the event loop alive while suspended. Without this, stopping the TUI
		// can leave Node with no ref'ed handles, causing the process to exit on fg
		// before the SIGCONT handler gets a chance to restore the terminal.
		const suspendKeepAlive = setInterval(() => {}, 2 ** 30);

		// Ignore SIGINT while suspended so Ctrl+C in the terminal does not
		// kill the backgrounded process. The handler is removed on resume.
		const ignoreSigint = () => {};
		process.on("SIGINT", ignoreSigint);

		// Set up handler to restore TUI when resumed
		process.once("SIGCONT", () => {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			this.#ctx.ui.start();
			this.#ctx.ui.requestRender(true);
		});

		try {
			// Stop the TUI (restore terminal to normal mode)
			this.#ctx.ui.stop();

			// Send SIGTSTP to process group (pid=0 means all processes in group)
			process.kill(0, "SIGTSTP");
		} catch (error) {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			throw error;
		}
	}

	async handleQueueCommand(message: string): Promise<void> {
		if (!message) {
			this.#ctx.showStatus("Usage: /queue <message> — queues a message for after the agent yields");
			return;
		}
		try {
			await this.#ctx.session.followUp(message);
			this.#ctx.showStatus(`Queued: "${message.slice(0, 60)}${message.length > 60 ? "…" : ""}"`);
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			this.#ctx.showStatus(`Failed to queue: ${errMsg}`);
		}
	}
}
