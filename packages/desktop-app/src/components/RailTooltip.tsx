import { type TranslationKey, t } from "@musepi/guest-client";
import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";

const DELAY_MS = 150;
const GAP = 8;

/**
 * RailTooltip — right-rail icon hover hint (openchamber Tooltip parity,
 * hand-written). The rail is a fixed column flush against the viewport's
 * right edge, so the bubble is always placed to the LEFT of the anchor and
 * vertically centered on it: no flip/shift collision detection is possible
 * or needed (openchamber pays radix for that generality; here the geometry is
 * constant). Shows after a 150ms hover delay and follows scroll/resize.
 *
 * Content lines: the label, an optional description, and one optional extra
 * line (e.g. the changed-files count). Hidden while dragging — see
 * RightRail's `suppressTooltip`.
 */
export function RailTooltip({
	anchor,
	label,
	description,
	extra,
	suppressed,
}: {
	anchor: HTMLElement | null;
	label: string;
	description?: string;
	extra?: string | null;
	suppressed: boolean;
}): React.ReactNode {
	const [pos, setPos] = useState<{ right: number; top: number } | null>(null);

	useLayoutEffect(() => {
		if (!anchor) {
			setPos(null);
			return;
		}
		const place = (): void => {
			const r = anchor.getBoundingClientRect();
			setPos({ right: window.innerWidth - r.left + GAP, top: r.top + r.height / 2 });
		};
		place();
		const onScroll = (): void => place();
		document.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", onScroll);
		return () => {
			document.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", onScroll);
		};
	}, [anchor]);

	// Delayed show: an instant popup on a 34px icon target would flicker on
	// every rail sweep. Hide is immediate.
	const [shown, setShown] = useState(false);
	useEffect(() => {
		if (!anchor || suppressed) {
			setShown(false);
			return;
		}
		const id = window.setTimeout(() => setShown(true), DELAY_MS);
		return () => window.clearTimeout(id);
	}, [anchor, suppressed]);

	if (!pos || !shown) return null;
	return createPortal(
		<div
			className="gui-rail-tooltip"
			style={{ right: pos.right, top: pos.top, transform: "translateY(-50%)" }}
			role="tooltip"
		>
			<span className="gui-rail-tooltip-label">{t(label as TranslationKey)}</span>
			{description ? <span className="gui-rail-tooltip-desc">{t(description as TranslationKey)}</span> : null}
			{extra ? <span className="gui-rail-tooltip-desc">{extra}</span> : null}
		</div>,
		document.getElementById("root") ?? document.body,
	);
}
