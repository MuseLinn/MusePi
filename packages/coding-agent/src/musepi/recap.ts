// ============================================================
// MusePi native idle recap.
//
// Ported from OMP's event-controller.ts idle recap feature.
// After each completed turn, schedules a one-shot recap when
// the terminal has been idle for `idleSeconds` (default 240).
// The recap runs a lightweight LLM call to summarize current
// goal/task/next action, displayed as a dim italic status line.
// ============================================================

import type { AgentSession } from "../core/agent-session.ts";

// ── Config ─────────────────────────────────────────────────

const DEFAULT_IDLE_SECONDS = 240;
const MIN_IDLE_SECONDS = 1;
const MAX_OUTPUT_TOKENS = 256;

// ── Internal state (per binding) ───────────────────────────

interface RecapBinding {
	session: AgentSession;
	onRecapText: (text: string) => void;
	timer: ReturnType<typeof setTimeout> | null;
	abortController: AbortController | null;
	currentGoal?: string;
	currentTask?: string;
	enabled: boolean;
	idleSeconds: number;
}

// ── Public API ─────────────────────────────────────────────

export interface RecapOptions {
	enabled?: boolean;
	idleSeconds?: number;
}

/**
 * Initialize recap state. Call once per session bind.
 * Returns an API object — call .onTurnEnd() from the session subscription.
 */
export function initMusepiRecap(
	session: AgentSession,
	onRecapText: (text: string) => void,
	options: RecapOptions = {},
) {
	const idleSeconds = options.idleSeconds ?? DEFAULT_IDLE_SECONDS;
	const enabled = options.enabled ?? false;

	const b: RecapBinding = {
		session,
		onRecapText,
		timer: null,
		abortController: null,
		enabled,
		idleSeconds,
	};

	return {
		/** Call when a turn ends — schedules the idle timer. */
		onTurnEnd: () => {
			if (!b.enabled) return;
			scheduleRecap(b, b.idleSeconds);
		},

		/** Signal user activity — cancels pending recap timer. */
		poke: () => {
			cancelRecap(b);
		},

		/** Update context (goal, active task). */
		setContext: (goal?: string, task?: string) => {
			b.currentGoal = goal;
			b.currentTask = task;
		},

		/** Dispose — clean up timer and abort. */
		dispose: () => {
			cancelRecap(b);
		},
	};
}

// ── Internal ───────────────────────────────────────────────

function scheduleRecap(b: RecapBinding, idleSeconds: number): void {
	cancelRecap(b);
	const clamped = Math.max(MIN_IDLE_SECONDS, Math.min(idleSeconds, 3600));
	b.timer = setTimeout(() => runRecap(b), clamped * 1000);
	if (b.timer && typeof b.timer === "object" && "unref" in b.timer) {
		(b.timer as ReturnType<typeof setTimeout>).unref();
	}
}

function cancelRecap(b: RecapBinding): void {
	if (b.timer !== null) {
		clearTimeout(b.timer);
		b.timer = null;
	}
	if (b.abortController !== null) {
		b.abortController.abort();
		b.abortController = null;
	}
}

async function runRecap(b: RecapBinding): Promise<void> {
	const session = b.session;
	if (!session.isIdle || !session.model) return;
	const messages = session.agent.state.messages;
	if (messages.length === 0) return;

	b.abortController = new AbortController();

	const goalLine = b.currentGoal ? `Overall goal: ${b.currentGoal}` : "";
	const taskLine = b.currentTask ? `Active task: ${b.currentTask}` : "";
	const ctxLines = [goalLine, taskLine].filter(Boolean).join("\n");

	const prompt = `<recap>
The user stepped away and is coming back. Recap in under 40 words, 1-2 plain sentences, no markdown.
Lead with the overall goal and current task, then the one next action.
Skip root-cause narrative, fix internals, secondary to-dos, and em-dash tangents.
${ctxLines ? `\n${ctxLines}\n` : ""}
</recap>`;

	try {
		const { completeSimple } = await import("@musepi/pi-ai/compat");
		const model = session.model;
		if (!model) return;

		const auth = await getAuth(session, model);

		const options: Record<string, unknown> = {
			maxTokens: MAX_OUTPUT_TOKENS,
			signal: b.abortController.signal,
		};
		if (auth.apiKey) options.apiKey = auth.apiKey;
		if (auth.headers) options.headers = auth.headers;
		if (auth.env) options.env = auth.env;

		const context = {
			messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() } as any],
		};

		const response = await completeSimple(model, context, options);
		if (response.stopReason === "error" || response.stopReason === "aborted") return;

		const { contentText } = await import("@musepi/pi-ai");
		const text = contentText(response.content).trim();
		if (!text) return;

		const truncated = text.length > 280 ? `${text.slice(0, 277)}...` : text;
		b.onRecapText(truncated);
	} catch (err: any) {
		if (err?.name === "AbortError") return;
	}
}

async function getAuth(
	session: AgentSession,
	model: any,
): Promise<{ apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }> {
	try {
		const result = await (session as any).modelRuntime?.getAuth(model);
		if (result) {
			return {
				apiKey: result.auth?.apiKey,
				headers: result.auth?.headers
					? Object.fromEntries(
							Object.entries(result.auth.headers).filter(
								(entry): entry is [string, string] => entry[1] !== null,
							),
						)
					: undefined,
				env: result.env,
			};
		}
	} catch {
		/* no auth available */
	}
	return {};
}
