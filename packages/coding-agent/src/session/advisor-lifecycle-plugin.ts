import { Context, type Fiber } from "@deepseek-ai/cordis";
import type { AgentMessage } from "@musepi/pi-agent-core";
import { SessionAdvisors, type SessionAdvisorsHost, type SessionAdvisorsOptions } from "./session-advisors";

/** One primary-turn notification delivered to the session advisor controller. */
export type AdvisorPrimaryTurnEndListener = (
	messages: AgentMessage[],
	willContinue: boolean | undefined,
	signal?: AbortSignal,
) => Promise<void>;

export interface CordisAdvisorLifecycleOptions {
	host: SessionAdvisorsHost;
	advisorOptions: SessionAdvisorsOptions;
	subscribeTurnEnd: (listener: AdvisorPrimaryTurnEndListener) => () => void;
}

/**
 * Session-scoped Cordis plugin that creates and owns the advisor controller.
 *
 * Construction and subscription are synchronous so AgentSession's public API and
 * first turn remain safe. The fiber owns subscription removal, runtime shutdown,
 * and the recorder-close barrier. SessionAdvisors keeps the model, context,
 * transcript, delivery, configuration, and statistics policies it implements.
 */
export class CordisAdvisorLifecycle {
	readonly #root = new Context();
	readonly #advisors: SessionAdvisors;
	readonly fiber: Fiber & PromiseLike<Fiber>;

	constructor(options: CordisAdvisorLifecycleOptions) {
		this.#advisors = new SessionAdvisors(options.host, options.advisorOptions);
		const active = this.#advisors;
		// Cordis applies plugin bodies after a microtask. Subscribe now so the
		// AgentSession constructor never opens a first-turn notification gap.
		const unsubscribe = options.subscribeTurnEnd((messages, willContinue, signal) =>
			active.onPrimaryTurnEnd(messages, willContinue, signal),
		);
		this.fiber = this.#root.plugin({
			name: "session-advisors",
			apply: ctx => {
				ctx.effect(() => {
					return async () => {
						unsubscribe();
						await active.stopRuntime();
					};
				}, "session-advisors:lifecycle");
			},
		});
	}

	get advisors(): SessionAdvisors {
		return this.#advisors;
	}

	async ready(): Promise<void> {
		await this.fiber.await();
	}

	async dispose(): Promise<void> {
		// Let apply register the effect even when disposal starts immediately after
		// construction; otherwise the synchronous subscription would have no owner.
		await this.ready();
		await this.fiber.dispose();
	}
}
