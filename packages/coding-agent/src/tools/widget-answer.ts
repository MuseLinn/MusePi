/**
 * Pending answers for `widget` pages that hold the turn.
 *
 * A page marked `awaitAnswer` is a question the user answers *in the page*:
 * the tool must not return until that answer lands, or the turn continues
 * past a choice the model has not seen yet. The bridge is deliberately tiny
 * and conversation-local: one promise per tool call, resolved by the daemon's
 * `widget.answer` RPC, and settled with `null` when the turn is aborted so an
 * abandoned page can never leave the loop awaiting forever.
 */
export interface WidgetAnswer {
	text: string;
	data?: unknown;
}

interface Pending {
	settle(answer: WidgetAnswer | null): void;
	cleanup(): void;
}

const pending = new Map<string, Pending>();

/**
 * Wait for the user's answer to one page. Resolves `null` when `signal`
 * aborts (turn stopped) — the tool then returns an unanswered page instead of
 * throwing, so the transcript keeps the page and the model learns nothing was
 * chosen.
 */
export function awaitWidgetAnswer(toolCallId: string, signal?: AbortSignal): Promise<WidgetAnswer | null> {
	if (signal?.aborted) return Promise.resolve(null);
	return new Promise(resolve => {
		let settled = false;
		const finish = (answer: WidgetAnswer | null): void => {
			if (settled) return;
			settled = true;
			pending.delete(toolCallId);
			signal?.removeEventListener("abort", onAbort);
			resolve(answer);
		};
		const onAbort = (): void => finish(null);
		pending.set(toolCallId, { settle: finish, cleanup: () => finish(null) });
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Resolve a waiting page. Returns false for an unknown or already-settled
 * call, which the RPC reports as "no page is waiting" instead of silently
 * acknowledging an answer nobody consumed.
 */
export function answerWidget(toolCallId: string, answer: WidgetAnswer): boolean {
	const entry = pending.get(toolCallId);
	if (!entry) return false;
	entry.settle(answer);
	return true;
}

/** Settle every waiting page (session teardown, tests). */
export function clearWidgetAnswers(): void {
	for (const entry of pending.values()) entry.cleanup();
	pending.clear();
}

/** Test/diagnostic hook: how many pages are waiting right now. */
export function pendingWidgetAnswers(): number {
	return pending.size;
}
