import { type TranslationKey, t } from "@musepi/client-core";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { Icon } from "../vendor/oc-icons";
import type { IconName } from "../vendor/oc-icons/icons";

/**
 * App rail — the persistent 52px destination column left of the panel.
 *
 * Two-tier shell (ChatGPT desktop parity): this column never leaves the
 * window, so every destination stays one click away while the panel slot
 * swaps content underneath it, and collapsing the panel cannot strand the
 * user because the way back never lives inside the collapsed layer.
 *
 * The rail is deliberately dumb: it takes prepared destinations and renders
 * them. Selection state lives in `app.tsx`, so the rail can never disagree
 * with the surface it drives.
 */

/** Must match `.gui-rail { width }` in `gui-chrome.css` — the side resize
 *  handle and the narrow-mode drawer offset are computed from it. */
export const RAIL_WIDTH = 52;

export interface RailItem {
	id: string;
	label: TranslationKey;
	icon: IconName;
	/** Destination currently shown (aria-current="page"). */
	active?: boolean;
	/** Unread activity dot — independent of `active` (a destination can hold
	 *  unread items while you are looking at a different one). */
	unread?: boolean;
	/** Id of the second-tier panel this destination owns. Only destinations
	 *  with a panel may float one on hover; the rail's empty band and action
	 *  buttons never peek (2026-11-08). */
	panelId?: string;
	onSelect(): void;
}

function RailButton({
	item,
	onPeekPanel,
	onPeekEnd,
}: {
	item: RailItem;
	onPeekPanel?: (panelId: string) => void;
	onPeekEnd?(): void;
}): ReactNode {
	const label = t(item.label);
	return (
		<button
			type="button"
			className={`gui-rail-btn${item.active ? " gui-rail-btn--active" : ""}`}
			title={label}
			aria-label={label}
			aria-current={item.active ? "page" : undefined}
			data-rail-destination={item.id}
			data-rail-panel={item.panelId}
			onClick={item.onSelect}
			onPointerEnter={item.panelId ? () => onPeekPanel?.(item.panelId as string) : undefined}
			onPointerLeave={item.panelId ? onPeekEnd : undefined}
		>
			<Icon name={item.icon} className="gui-rail-icon" />
			{item.unread ? <span className="gui-rail-dot" aria-hidden="true" /> : null}
		</button>
	);
}

export function AppRail({
	destinations,
	settings,
	footerActions,
	panelAvailable,
	onTogglePanel,
	onPeekPanel,
	onPeekEnd,
}: {
	destinations: readonly RailItem[];
	settings: RailItem;
	/** Instance / shortcuts / remote-control entries that used to live only
	 *  in the sidebar footer. They stay reachable when the panel is folded
	 *  or a page destination replaces it (ChatGPT's rail footer parity). */
	footerActions?: ReactNode;
	/** The active destination owns a left panel (首页 / 任务中心). Page
	 *  destinations without one do not offer folding. */
	panelAvailable: boolean;
	onTogglePanel(): void;
	/** Hover-peek (2026-11-08): the gesture starts on ONE destination button
	 *  that owns a panel, never on the rail's empty band. The host decides which
	 *  panel floats from the reported `panelId`, so 任务中心 can peek its own
	 *  task list instead of the 首页 session list. */
	onPeekPanel?(panelId: string): void;
	onPeekEnd?(): void;
}): ReactNode {
	// The 48px top band is EMPTY by design: the window's own fold/unfold
	// control lives in the titlebar cluster at the panel's top edge. Rendering
	// a second one in the rail duplicated it and (on frameless windows) the
	// fixed-position cluster landed on top of it. The band only keeps
	// destinations below the header row and stays draggable.
	const onBackgroundDoubleClick = (event: ReactMouseEvent<HTMLElement>): void => {
		if (!panelAvailable) return;
		if (event.target instanceof Element && event.target.closest("button")) return;
		onTogglePanel();
	};
	return (
		<nav
			className="gui-rail"
			aria-label={t("general.appRail")}
			data-gui-scrollbar="off"
			onDoubleClick={onBackgroundDoubleClick}
		>
			<div className="gui-rail-top" aria-hidden="true" />
			<div className="gui-rail-scroll" data-gui-scrollbar="off">
				{destinations.map(item => (
					<RailButton key={item.id} item={item} onPeekPanel={onPeekPanel} onPeekEnd={onPeekEnd} />
				))}
			</div>
			<div className="gui-rail-group">
				{footerActions}
				<RailButton item={settings} onPeekPanel={onPeekPanel} onPeekEnd={onPeekEnd} />
			</div>
		</nav>
	);
}
