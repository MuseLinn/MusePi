import { WidgetErrorBoundary } from "@musepi/collab-web/src/widgets/error-boundary";
import { WIDGET_REGISTRY, type WidgetDef } from "@musepi/collab-web/src/widgets/registry";
import type { ReactNode } from "react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { initTooltips } from "./lib/tooltips";
import { Icon, type IconName } from "./vendor/oc-icons";
import "@musepi/collab-web/src/styles/tokens.css";
import "@musepi/collab-web/src/styles/base.css";
import "./styles/fonts.css";
import "./styles/gui.css";

/** Preload's electronAPI (types live in lib/electron.ts); we only need the
 *  pin-top toggle and dismiss here — accessed via a narrow local cast. */
type PinAPI = { pinTopToggle?(): Promise<unknown>; pinDismiss?(): Promise<unknown> };
const pinAPI = (window as unknown as { electronAPI?: PinAPI }).electronAPI;

/**
 * Pinned-widget window (?pin.html?type=…&title=…&data=…): the widget
 * renders immersive (kimi parity — the card IS the window: rounded
 * surface, adaptive size, no chrome) with a slim drag strip on top that
 * reveals larger pin-top / close buttons on hover. No daemon wiring —
 * the widget is pure local state.
 */
function PinApp(): ReactNode {
	const params = new URLSearchParams(window.location.search);
	const type = params.get("type") ?? "";
	let data: Record<string, unknown> = {};
	try {
		const raw = params.get("data");
		if (raw) data = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		// malformed data → defaults
	}
	const def: WidgetDef | undefined = WIDGET_REGISTRY.find(w => w.type === type);
	const Comp = def?.Component;
	const [pinned, setPinned] = useState(true);
	return (
		<div className="gui-pin" data-tone={def?.tone ?? "default"}>
			{/* Drag strip only — NO title: the pinned card keeps the exact
			 * board-card look (kimi desktop card has no header text). */}
			<div className="gui-pin-drag">
				<div className="gui-pin-actions">
					<button
						type="button"
						className="gui-pin-btn"
						title={pinned ? "取消置顶" : "置顶"}
						aria-label={pinned ? "取消置顶" : "置顶"}
						onClick={() => {
							const next = !pinned;
							setPinned(next);
							void pinAPI?.pinTopToggle?.();
						}}
					>
						<Icon name={"pushpin" as IconName} className="h-4 w-4" />
					</button>
					<button
						type="button"
						className="gui-pin-btn gui-pin-btn--close"
						title="关闭"
						aria-label="关闭"
						onClick={() => {
							// Dismiss through IPC so the persisted pin record
							// is removed (plain window.close() would leave it
							// and the window would be recreated on launch).
							void pinAPI?.pinDismiss?.();
						}}
					>
						<Icon name="close" className="h-4 w-4" />
					</button>
				</div>
			</div>
			{Comp ? (
				<div className="gui-pin-card">
					{/* No WidgetFit: the pinned window is sized to the card's
					 * aspect — the widget surface bleeds edge-to-edge (kimi
					 * desktop card parity). Widgets are fluid (height:100%)
					 * and adapt; overflow is clipped like a real card. */}
					<WidgetErrorBoundary>
						<Comp data={data} update={() => {}} />
					</WidgetErrorBoundary>
				</div>
			) : (
				<div className="gui-pin-card gui-pin-card--empty">unknown widget · {type}</div>
			)}
		</div>
	);
}

// Unified tooltip layer for this window too (widget controls have titles).
initTooltips();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(<PinApp />);
