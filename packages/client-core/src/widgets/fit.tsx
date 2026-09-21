import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

/**
 * Fit a widget's natural content into its container height.
 *
 * Widgets are fluid-width (they stretch to the card) with natural
 * heights; when a card is shorter than its content the widget would be
 * clipped. This wrapper measures the content's natural height and
 * shrinks it (top-anchored scale, never enlarged) so everything stays
 * fully visible. Used by the board canvas cards, the focus modal and
 * the pinned desktop window alike.
 */
export function WidgetFit({ children }: { children: ReactNode }): ReactNode {
	const outerRef = useRef<HTMLDivElement | null>(null);
	const innerRef = useRef<HTMLDivElement | null>(null);
	const [scale, setScale] = useState(1);
	useEffect(() => {
		const outer = outerRef.current;
		const inner = innerRef.current;
		if (!outer || !inner) return;
		const apply = (): void => {
			const oh = outer.clientHeight;
			const ih = inner.scrollHeight;
			if (!oh || !ih) return;
			const s = Math.min(1, oh / ih);
			setScale(Math.max(0.3, s));
		};
		apply();
		const ro = new ResizeObserver(apply);
		ro.observe(outer);
		return () => ro.disconnect();
	}, []);
	return (
		<div ref={outerRef} className="gui-widget-fit">
			<div ref={innerRef} className="gui-widget-fit-inner" style={{ transform: `scale(${scale})` }}>
				{children}
			</div>
		</div>
	);
}
