/**
 * One predicate shared by both session_stop dispatch paths: a result continues
 * the settle only when it asks to (`continue` / `decision: "block"`) AND
 * carries something to say. An empty continuation is treated as "no".
 */
import type { SessionStopEventResult } from "./types";

export function sessionStopContinues(result: SessionStopEventResult | undefined): boolean {
	if (!result) return false;
	const hasContext =
		(typeof result.additionalContext === "string" && result.additionalContext.length > 0) ||
		(typeof result.reason === "string" && result.reason.length > 0);
	return (result.continue === true || result.decision === "block") && hasContext;
}
