import { logger, prompt } from "@musepi/pi-utils";
import type { ExtensionContext, PluginAPI } from "../../extensibility/extensions/types";
import type { AgentEndEvent } from "../../extensibility/shared-events";
import suggestionInstruction from "../../prompts/system/suggestion-instruction.md" with { type: "text" };
import { promptSuggestionText, turnAllowsPromptSuggestion } from "../../session/prompt-suggestion";

export const name = "musepi-prompt-suggestion";
export const inject = [] as const;
export const provide = [] as const;

const INSTRUCTION = prompt.render(suggestionInstruction);

/** A prediction that outlives the next turn is no longer about anything. */
const SUGGESTION_TIMEOUT_MS = 80_000;

interface SuggestionState {
	abort?: AbortController;
}

/**
 * Next-input suggestions: after a turn ends on a model-authored reply, predict
 * the message the user is most likely to type next and offer it in their empty
 * composer.
 *
 * The prediction runs as an ephemeral side turn over the conversation that
 * just ended, pinned to the session's own model (`modelSource: "session"`).
 * Both halves matter: the turn's system prompt, history and tool catalog make
 * the wording continue the conversation instead of guessing at it, and keeping
 * its model (not the side-channel override, not a tiny role) is what lets the
 * provider's cached prefix still hit, which is why the hint promises cache
 * reuse rather than a cheap call.
 *
 * The session is never modified, a running main turn is never blocked, and
 * every failure stays here: a missing candidate is simply no candidate. Hosts
 * without a composer (print, RPC, TUI) call nothing at all, because they never
 * receive `ctx.showSuggestion`.
 */
export function apply(pi: PluginAPI): void {
	const states = new WeakMap<object, SuggestionState>();
	const stateFor = (ctx: ExtensionContext): SuggestionState => {
		const key = ctx.sessionManager;
		let state = states.get(key);
		if (!state) {
			state = {};
			states.set(key, state);
		}
		return state;
	};

	const cancel = (ctx: ExtensionContext): void => {
		const state = stateFor(ctx);
		state.abort?.abort();
		state.abort = undefined;
	};

	const enabled = (ctx: ExtensionContext): boolean => ctx.settings.get("suggestion.enabled") !== false;

	const predict = async (ctx: ExtensionContext, event: AgentEndEvent): Promise<void> => {
		const showSuggestion = ctx.showSuggestion;
		const runTurn = ctx.runEphemeralTurn;
		if (!showSuggestion || !runTurn) return;
		// `willContinue` means an automatic continuation is already scheduled:
		// the turn the user sees has not settled, so a prediction would answer a
		// conversation that is still moving.
		if (event.willContinue) return;
		if (!enabled(ctx) || !turnAllowsPromptSuggestion(event.messages)) return;

		const state = stateFor(ctx);
		// A newer turn supersedes the older prediction.
		state.abort?.abort();
		const abort = new AbortController();
		state.abort = abort;
		const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(SUGGESTION_TIMEOUT_MS)]);

		/** One provider rejection is usually transient; resend the identical request once. */
		const attempt = async (): Promise<string | null> => {
			try {
				const { replyText } = await runTurn({
					promptText: INSTRUCTION,
					signal,
					modelSource: "session",
				});
				return promptSuggestionText(replyText);
			} catch (error) {
				if (signal.aborted) throw error;
				logger.debug("prompt-suggestion: retrying once after failure", {
					error: error instanceof Error ? error.message : String(error),
				});
				const { replyText } = await runTurn({
					promptText: INSTRUCTION,
					signal,
					modelSource: "session",
				});
				return promptSuggestionText(replyText);
			}
		};

		try {
			const suggestion = await attempt();
			// Re-read the gate: a toggle or a newer turn during the request must
			// not publish a prediction the user has already dismissed past.
			if (!suggestion || abort.signal.aborted || !enabled(ctx)) return;
			showSuggestion(suggestion);
		} catch (error) {
			if (abort.signal.aborted) {
				logger.debug("prompt-suggestion: cancelled by a newer turn");
			} else if (signal.aborted) {
				logger.warn("prompt-suggestion: timed out", { timeoutMs: SUGGESTION_TIMEOUT_MS });
			} else {
				logger.warn("prompt-suggestion: skipped after background failure", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		} finally {
			if (state.abort === abort) state.abort = undefined;
		}
	};

	pi.on("agent_end", (event, ctx) => {
		void predict(ctx, event);
	});
	pi.on("turn_start", (_event, ctx) => {
		cancel(ctx);
	});
	pi.on("input", (_event, ctx) => {
		cancel(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		cancel(ctx);
	});
}
