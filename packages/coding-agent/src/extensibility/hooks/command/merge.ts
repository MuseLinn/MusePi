import type { HookOutput, MergedDecision, MergedHookOutcome } from "./types";

/**
 * Fold every matched hook's outcome into one most-restrictive result.
 *
 * Precedence is `deny > ask > allow`; only reasons attached to the winning
 * rank surface (an allow reason must not explain a deny). The first `continue:
 * false` is sticky. Context and system messages accumulate in hook order
 * because each is meant to be delivered, not collapsed.
 */

function rank(decision: HookOutput["decision"]): number {
	switch (decision) {
		case "deny":
		case "block":
			return 3;
		case "ask":
			return 2;
		case "approve":
		case "allow":
			return 1;
		default:
			return 0;
	}
}

function decisionForRank(max: number): MergedDecision {
	switch (max) {
		case 3:
			return "deny";
		case 2:
			return "ask";
		case 1:
			return "allow";
		default:
			return "none";
	}
}

export function mergeHookOutputs(outputs: readonly HookOutput[]): MergedHookOutcome {
	let maxRank = 0;
	const reasonsByRank = new Map<number, string[]>();
	let stop = false;
	let stopReason: string | undefined;
	const additionalContext: string[] = [];
	const systemMessages: string[] = [];

	for (const output of outputs) {
		const r = rank(output.decision);
		if (r > maxRank) maxRank = r;
		if ((r === 2 || r === 3) && output.reason !== undefined && output.reason.length > 0) {
			const list = reasonsByRank.get(r) ?? [];
			list.push(output.reason);
			reasonsByRank.set(r, list);
		}
		if (output.continue === false && !stop) {
			stop = true;
			if (output.stopReason !== undefined) stopReason = output.stopReason;
		}
		if (output.additionalContext !== undefined && output.additionalContext.length > 0) {
			additionalContext.push(output.additionalContext);
		}
		if (output.systemMessage !== undefined && output.systemMessage.length > 0) {
			systemMessages.push(output.systemMessage);
		}
	}

	const reasons = reasonsByRank.get(maxRank) ?? [];
	return {
		decision: decisionForRank(maxRank),
		...(reasons.length > 0 ? { reason: reasons.join("\n\n") } : {}),
		stop,
		...(stopReason !== undefined ? { stopReason } : {}),
		additionalContext,
		systemMessages,
	};
}
