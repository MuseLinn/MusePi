/**
 * Todo Command Controller — `/todo` subcommand dispatch.
 *
 * Ported from OMP's todo-command-controller.ts. Wraps MusePi's native
 * todo module and following the OMP controller pattern.
 */

import { handleTodoCommand as musepiHandleTodo } from "../../../musepi/todo-native.ts";
import type { InteractiveModeContext } from "../types.ts";

export class TodoCommandController {
	readonly #ctx: InteractiveModeContext;

	constructor(ctx: InteractiveModeContext) {
		this.#ctx = ctx;
	}

	dispose(): void {
		// Nothing to dispose yet
	}

	async handleTodoCommand(text: string): Promise<void> {
		const args = text === "/todo" ? "" : text.slice(6).trim();
		const result = musepiHandleTodo(args);
		this.#ctx.showStatus(result);
	}
}
