import type { ToolResultMessage } from "@musepi/pi-wire";
import type { ReactNode } from "react";
import { memo } from "react";
import { messageText } from "../../lib/format";
import { ToolView } from "../../tool-render/ToolView";
import type { ToolRenderHost } from "../../tool-render/types";
import { toolKind } from "./toolcard-shared";

export interface ToolCardProps {
	toolCallId: string;
	name: string;
	args: unknown;
	intent?: string;
	result?: ToolResultMessage;
	running?: boolean;
	partialResult?: unknown;
	host?: ToolRenderHost;
}

/** Widget cards render expanded by default (GUI setting
 *  omp-gui-widget-expanded; default on — the card IS the visualization).
 *  Board cards render the board itself — same artifact semantics. Both are
 *  turn *artifacts*, so they never auto-collapse when the turn completes
 *  (process tools fold away, the artifact stays). */
function isArtifactCard(name: string): boolean {
	return name === "widget" || name === "board";
}

function widgetDefaultOpen(): boolean {
	try {
		return localStorage.getItem("omp-gui-widget-expanded") !== "false";
	} catch {
		return true;
	}
}

/** Wire-type adapter over the shared per-tool renderer stack. */
export const ToolCard = memo(function ToolCard(props: ToolCardProps): ReactNode {
	const { name, intent, args, result, running, partialResult, host } = props;
	const partial =
		running && !result ? (typeof partialResult === "string" ? partialResult : messageText(partialResult)) : "";
	return (
		<ToolView
			name={name}
			args={args}
			result={result}
			running={running}
			intent={intent}
			kind={toolKind(name, intent)}
			partial={partial || undefined}
			host={host}
			/* ZCode parity: live tools open while they run, fold when done;
			 * artifacts (widget/board cards) stay open per the user setting. */
			defaultOpen={isArtifactCard(name) ? widgetDefaultOpen() : running === true}
			collapseWhenDone={!isArtifactCard(name)}
		/>
	);
});
