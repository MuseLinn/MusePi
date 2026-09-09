/**
 * Floating member grid (kimiwork parity): renders the guest-client task
 * renderer's SwarmCard against the live task tool's partialResult details
 * (progress/results) — the frosted card opened from the composer's
 * temporary swarm status chip. Host wires agent-trajectory drill-down.
 */
import { resolveToolRenderer, type ToolRenderHost } from "@musepi/guest-client";
import type { ReactNode } from "react";

export function SwarmCardPreview({ details, host }: { details?: unknown; host?: ToolRenderHost }): ReactNode {
	const SwarmCard = resolveToolRenderer("task").SwarmCard;
	if (!SwarmCard) return null;
	return <SwarmCard name="task" args={{}} result={{ content: [], details }} host={host} />;
}
