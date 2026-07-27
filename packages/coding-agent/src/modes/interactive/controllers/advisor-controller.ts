/**
 * Advisor Controller — wires the background advisor loop into InteractiveMode.
 *
 * Uses AdvisorBinding from advisor-native.ts for model resolution and completion.
 */

import {
	type AdvisorAgent,
	AdvisorRuntime,
	type AdvisorRuntimeConfig,
	type AdvisorRuntimeHost,
} from "../../../advisor/runtime.ts";
import type { InteractiveModeContext } from "../types.ts";

export class AdvisorController {
	readonly #ctx: InteractiveModeContext;
	#runtime: AdvisorRuntime | undefined;

	constructor(ctx: InteractiveModeContext) {
		this.#ctx = ctx;
	}

	/** Start the advisor runtime, if the session has model resolution. */
	start(): void {
		this.#runtime?.dispose();

		// Store mutable state in closures for AdvisorAgent
		let agentMessages: any[] = [];
		let agentError: string | undefined;

		const getMessages = () => {
			try {
				return (this.#ctx.session as any).messages ?? [];
			} catch {
				return [];
			}
		};

		const host: AdvisorRuntimeHost = {
			snapshotMessages: () => getMessages(),
			enqueueAdvice: (note: string) => {
				this.#ctx.showStatus(`[advisor] ${note.slice(0, 80)}`);
			},
		};

		const agent: AdvisorAgent = {
			reset() {
				agentMessages = [];
				agentError = undefined;
			},
			abort() {
				agentError = "aborted";
			},
			state: {
				get messages() {
					return agentMessages;
				},
				get error() {
					return agentError;
				},
			},
			async prompt(input: string) {
				agentMessages.push({ role: "user", content: input });
			},
		};

		const config: AdvisorRuntimeConfig = { name: "advisor", slug: "advisor" };

		this.#runtime = new AdvisorRuntime(agent, host, config);
	}

	/** Feed the latest primary turn to the advisor. */
	submitTurn(): void {
		this.#runtime?.submitTurn().catch(() => {});
	}

	/** Stop the advisor runtime. */
	dispose(): void {
		this.#runtime?.dispose();
		this.#runtime = undefined;
	}
}
