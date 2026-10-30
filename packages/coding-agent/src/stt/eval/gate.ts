export interface GateDecision {
	state: "accept" | "uncertain" | "reject";
	score: number | null;
	autoSubmit: boolean;
}

export function decideGate(input: {
	targetMs: number;
	score: number | null;
	acceptThreshold: number;
	rejectThreshold: number;
}): GateDecision {
	if (input.targetMs === 0) return { state: "reject", score: null, autoSubmit: false };
	if (input.targetMs < 1000 || input.score === null)
		return { state: "uncertain", score: input.score, autoSubmit: false };
	if (input.score < input.rejectThreshold) return { state: "reject", score: input.score, autoSubmit: false };
	if (input.score >= input.acceptThreshold) return { state: "accept", score: input.score, autoSubmit: true };
	return { state: "uncertain", score: input.score, autoSubmit: false };
}
