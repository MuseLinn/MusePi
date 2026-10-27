import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

/**
 * Fit a widget's natural content into its container.
 *
 * The wrapper measures both content axes and shrinks uniformly (centered,
 * never enlarged) so fluid content stays fully visible. It observes the
 * container and content because data updates can change either measurement.
 * Used by board cards, collection previews, focus modals and pinned windows.
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
			const ow = outer.clientWidth;
			const oh = outer.clientHeight;
			const iw = inner.scrollWidth;
			const ih = inner.scrollHeight;
			if (!ow || !oh || !iw || !ih) return;
			setScale(Math.min(1, ow / iw, oh / ih));
		};
		apply();
		const ro = new ResizeObserver(apply);
		ro.observe(outer);
		ro.observe(inner);
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
