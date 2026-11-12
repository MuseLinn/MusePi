import type { HookOutput } from "./types";

/**
 * Decode a hook process outcome.
 *
 * Exit 2 blocks and uses stderr as the reason. Exit 0 may carry a JSON object
 * on stdout (plain stdout stays available to the bridge). Any other exit is a
 * non-blocking failure. `expectedEventName` guards `hookSpecificOutput`: a
 * block that names a different event (or omits the name) cannot affect the
 * event that is actually running.
 */

const BLOCKING_EXIT_CODE = 2;

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function topLevelDecision(value: string | undefined): HookOutput["decision"] {
	// The legacy top-level field only ever means approve/block; allow/deny/ask
	// belong to hookSpecificOutput.permissionDecision (an out-of-band value is
	// invalid and must not become a real decision).
	return value === "approve" || value === "block" ? value : undefined;
}

function permissionDecision(value: string | undefined): HookOutput["decision"] {
	return value === "allow" || value === "deny" || value === "ask" ? value : undefined;
}

export function parseHookOutput(
	exitCode: number | undefined,
	stdout: string,
	stderr: string,
	expectedEventName?: string,
): HookOutput {
	const trimmedErr = stderr.trim();
	const trimmedOut = stdout.trim();
	const output: HookOutput = { exitCode, stderr: trimmedErr, stdout: trimmedOut };

	if (exitCode === BLOCKING_EXIT_CODE) {
		output.decision = "block";
		if (trimmedErr.length > 0) output.reason = trimmedErr;
	}

	if (exitCode !== 0 || !trimmedOut.startsWith("{")) return output;
	let parsed: Record<string, unknown> | undefined;
	try {
		parsed = record(JSON.parse(trimmedOut));
	} catch {
		parsed = undefined;
	}
	if (!parsed) return output;

	const cont = bool(parsed.continue);
	if (cont !== undefined) output.continue = cont;
	const stopReason = str(parsed.stopReason);
	if (stopReason !== undefined) output.stopReason = stopReason;
	const systemMessage = str(parsed.systemMessage);
	if (systemMessage !== undefined) output.systemMessage = systemMessage;
	const decision = topLevelDecision(str(parsed.decision));
	if (decision !== undefined) output.decision = decision;
	const reason = str(parsed.reason);
	if (reason !== undefined) output.reason = reason;

	const specific = record(parsed.hookSpecificOutput);
	if (specific) {
		const eventName = str(specific.hookEventName);
		if (eventName !== undefined) output.hookEventName = eventName;
		if (expectedEventName !== undefined && eventName !== expectedEventName) return output;
		const permission = permissionDecision(str(specific.permissionDecision));
		if (permission !== undefined) output.decision = permission;
		const permissionReason = str(specific.permissionDecisionReason);
		if (permissionReason !== undefined) output.reason = permissionReason;
		const additionalContext = str(specific.additionalContext);
		if (additionalContext !== undefined) output.additionalContext = additionalContext;
	}
	return output;
}
