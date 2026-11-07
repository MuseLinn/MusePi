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
	onSelect(): void;
}

function RailButton({ item }: { item: RailItem }): ReactNode {
	const label = t(item.label);
	return (
		<button
			type="button"
			className={`gui-rail-btn${item.active ? " gui-rail-btn--active" : ""}`}
			title={label}
			aria-label={label}
			aria-current={item.active ? "page" : undefined}
			data-rail-destination={item.id}
			onClick={item.onSelect}
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
	onPointerEnter,
	onPointerLeave,
}: {
	destinations: readonly RailItem[];
	settings: RailItem;
	/** Instance / shortcuts / remote-control entries that used to live only
	 *  in the sidebar footer. They stay reachable when the panel is folded
	 *  or a page destination replaces it (ChatGPT's rail footer parity). */
	footerActions?: ReactNode;
	/** The active destination owns a left panel (首页). Page destinations do
	 *  not, so folding them is not a thing the rail should offer. */
	panelAvailable: boolean;
	onTogglePanel(): void;
	/** Hover-peek: when the panel is docked closed, entering the rail slides
	 *  it out as a floating surface (ChatGPT `app-shell-floating-left-panel`
	 *  parity). The handlers live on the rail so the gesture starts on an
	 *  icon, not only on the empty band. */
	onPointerEnter?(): void;
	onPointerLeave?(): void;
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
			onDoubleClick={onBackgroundDoubleClick}
			onPointerEnter={onPointerEnter}
			onPointerLeave={onPointerLeave}
		>
			<div className="gui-rail-top" aria-hidden="true" />
			<div className="gui-rail-scroll">
				{destinations.map(item => (
					<RailButton key={item.id} item={item} />
				))}
			</div>
			<div className="gui-rail-group">
				{footerActions}
				<RailButton item={settings} />
			</div>
		</nav>
	);
}
