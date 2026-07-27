/**
 * Advisor Runtime — lightweight background advisor loop.
 *
 * Uses MusePi's native types, buildAdvisorTranscript, and the already-ported
 * emission-guard, config, transcript-recorder, and obfuscator.
 * ~250 lines — not a port of OMP's 1118-line runtime.ts.
 */

import type { AgentMessage } from "@musepi/pi-agent-core";
import { buildAdvisorTranscript } from "../../../musepi/core/src/advisor/serialize.ts";
import type { SecretObfuscator } from "../secrets/obfuscator.ts";
import * as logger from "../utils/pi-logger.ts";
import { AdvisorEmissionGuard } from "./emission-guard.ts";
import type { AdvisorTranscriptRecorder } from "./transcript-recorder.ts";

/** Minimal agent interface that the advisor runtime drives. */
export interface AdvisorAgent {
	prompt(input: string): Promise<void>;
	abort(reason?: unknown): void;
	reset(): void;
	readonly state: { messages: AgentMessage[]; error?: string };
}

export interface AdvisorRuntimeHost {
	snapshotMessages(): AgentMessage[];
	enqueueAdvice(note: string, severity?: "nit" | "concern" | "blocker"): void;
	obfuscator?: SecretObfuscator;
}

export interface AdvisorRuntimeConfig {
	name: string;
	slug: string;
}

function promiseWithResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const MAX_CONSECUTIVE_FAILURES = 3;
const RETRY_DELAY_MS = 5_000;
const MAX_TRANSCRIPT_CHARS = 60_000;

export class AdvisorRuntime {
	readonly #agent: AdvisorAgent;
	readonly #host: AdvisorRuntimeHost;
	readonly #config: AdvisorRuntimeConfig;

	/** Expose config for host queries. */
	get config(): AdvisorRuntimeConfig {
		return this.#config;
	}
	readonly #emissionGuard: AdvisorEmissionGuard;
	readonly #recorder?: AdvisorTranscriptRecorder;
	#disposed = false;
	#consecutiveFailures = 0;

	constructor(
		agent: AdvisorAgent,
		host: AdvisorRuntimeHost,
		config: AdvisorRuntimeConfig,
		recorder?: AdvisorTranscriptRecorder,
		emissionGuard?: AdvisorEmissionGuard,
	) {
		this.#agent = agent;
		this.#host = host;
		this.#config = config;
		// No usage needed — config is exposed via getter.
		void this.#config;
		this.#recorder = recorder;
		this.#emissionGuard = emissionGuard ?? new AdvisorEmissionGuard();
	}

	dispose(): void {
		this.#disposed = true;
		this.#agent.abort("disposed");
	}

	/** Submit the latest primary transcript for advisor review. */
	async submitTurn(): Promise<void> {
		if (this.#disposed || this.#consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return;

		// Snapshot and obfuscate
		let messages = this.#host.snapshotMessages();
		if (this.#host.obfuscator) {
			messages = obfuscateMessages(messages, this.#host.obfuscator);
		}

		// Serialize transcript
		const transcript = buildAdvisorTranscript(messages as any, { maxChars: MAX_TRANSCRIPT_CHARS });
		if (!transcript?.trim()) return;

		// Emission guard — check against fingerprint of current state
		const fp = transcript.slice(-200);
		if (!this.#emissionGuard.accept(fp)) return;
		this.#emissionGuard.beginUpdate();

		try {
			// Call advisor model
			this.#agent.reset();
			const userPrompt = `<transcript>\n${transcript}\n</transcript>\n\nReview the transcript above and give your guidance for the agent.`;
			await this.#agent.prompt(userPrompt);

			if (this.#disposed) return;

			// Extract advice from response
			const advice = extractAdvice(this.#agent.state.messages);
			if (advice) {
				if (this.#emissionGuard.accept(advice)) {
					this.#host.enqueueAdvice(advice, "concern");
				}
			}

			this.#consecutiveFailures = 0;
			if (advice) {
				this.#recorder?.record({ role: "assistant", content: [{ type: "text", text: advice }] } as AgentMessage);
			}
		} catch (err) {
			this.#consecutiveFailures++;
			logger.warn("advisor turn failed", { err: String(err) });

			if (this.#consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
				const { promise, resolve } = promiseWithResolvers<void>();
				setTimeout(resolve, RETRY_DELAY_MS * this.#consecutiveFailures);
				await promise;
				return this.submitTurn();
			}
			logger.warn("advisor halted after repeated failures");
		}
	}
}

/** Extract the most recent assistant message text as advice. */
function extractAdvice(messages: AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const text = contentText(msg.content);
		if (text?.trim()) return text.trim();
	}
	return undefined;
}

function contentText(content: string | { type: string; text?: string }[] | undefined): string | undefined {
	if (!content) return undefined;
	if (typeof content === "string") return content;
	return content
		.filter((b): b is { type: string; text: string } => typeof b.text === "string")
		.map((b) => b.text)
		.join("\n");
}

/** Apply obfuscation rules to all messages in place. */
function obfuscateMessages(messages: AgentMessage[], obfuscator: SecretObfuscator): AgentMessage[] {
	return messages.map((m: AgentMessage) => {
		const obfuscated: Record<string, unknown> = {};
		for (const key of Object.keys(m)) {
			const val = (m as unknown as Record<string, unknown>)[key];
			obfuscated[key] = typeof val === "string" ? obfuscator.obfuscate(val) : val;
		}
		return obfuscated as unknown as AgentMessage;
	});
}
