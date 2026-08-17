import type { ReactNode } from "react";
import type { RpcClient } from "../lib/rpc";
import { RIGHT_RAIL_SLOT, SlotComponentHost } from "../lib/slot-host";
import { Icon } from "../vendor/oc-icons";
import { TOOLS } from "./ContextPanel";

/**
 * Right-edge 44px icon rail (openchamber ContextPanelRail parity): a slim
 * vertical column of the ContextPanel tool icons, always visible regardless
 * of panel collapse, plus the panel fold toggle and the extension rail slot
 * (rail.right) at the bottom.
 *
 * Placement: sibling of ContextPanel inside the chat-scene row, so it sits
 * at the surface's right edge while the panel animates its width beside it.
 */
export function RightRail({
	rpc,
	sessionId,
	cwd,
	tool,
	rightPanelOpen,
	onSelect,
	onToggleRightPanel,
}: {
	rpc: RpcClient | null;
	/** Active session id (passed through to extension rail components). */
	sessionId?: string | null;
	/** Session working directory (passed through to extension components). */
	cwd?: string;
	/** Currently active ContextPanel tool (shared selection). */
	tool: string | null;
	rightPanelOpen: boolean;
	onSelect(tool: string): void;
	/** Panel fold toggle; absent (mini window) renders the button inert. */
	onToggleRightPanel?(): void;
}): ReactNode {
	return (
		<aside className={`gui-right-rail${rightPanelOpen ? "" : " gui-right-rail--closed"}`} aria-label="right rail">
			<div className="gui-right-rail-group">
				{TOOLS.map(toolDef => (
					<button
						key={toolDef.id}
						type="button"
						className={`gui-right-rail-btn${tool === toolDef.id ? " gui-right-rail-btn--active" : ""}`}
						title={toolDef.label}
						aria-label={toolDef.label}
						aria-pressed={tool === toolDef.id}
						onClick={() => onSelect(toolDef.id)}
					>
						<Icon name={toolDef.icon as never} className="h-4 w-4" />
					</button>
				))}
			</div>
			<div className="gui-right-rail-spacer" />
			<div className="gui-right-rail-group">
				<button
					type="button"
					className="gui-right-rail-btn"
					title={rightPanelOpen ? "collapse" : "expand"}
					aria-label={rightPanelOpen ? "collapse right panel" : "expand right panel"}
					onClick={() => onToggleRightPanel?.()}
				>
					<Icon name={rightPanelOpen ? "arrow-right" : "arrow-left"} className="h-4 w-4" />
				</button>
				{/* Extension-contributed rail icons (modes v2 右面板 Phase 0-2). */}
				<SlotComponentHost rpc={rpc} slot={RIGHT_RAIL_SLOT} sessionId={sessionId} cwd={cwd} />
			</div>
		</aside>
	);
}
