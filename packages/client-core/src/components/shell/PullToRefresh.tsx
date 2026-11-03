import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

/** Pull distance (px, damped) that triggers a refresh. */
const THRESHOLD = 56;
/** Hard cap so a long drag never uncovers more than a header's worth. */
const MAX_PULL = 96;

/**
 * Pull-to-refresh for the transcript.
 *
 * The gesture is a convenience, never the only path: the reconnect banner's
 * Rejoin button stays the explicit equivalent (Arc convention). It only starts
 * when the transcript is at its top, so normal scrolling and nested horizontal
 * scrollers are untouched; the native listener is non-passive because the pull
 * has to cancel the browser's overscroll once it takes over.
 *
 * Touch-only: a mouse or stylus (desktop web) gets the plain children.
 */
export function PullToRefresh({
	onRefresh,
	children,
}: {
	onRefresh(): void | Promise<void>;
	children: ReactNode;
}): ReactNode {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const [pull, setPull] = useState(0);
	const [busy, setBusy] = useState(false);
	const pullRef = useRef(0);
	const startRef = useRef(0);
	const activeRef = useRef(false);
	const busyRef = useRef(false);

	useEffect(() => {
		const el = hostRef.current;
		if (!el || typeof window === "undefined") return;
		if (!window.matchMedia("(pointer: coarse)").matches) return;

		const scroller = (): HTMLElement | null => el.closest(".sh-transcript") as HTMLElement | null;
		const reset = (): void => {
			pullRef.current = 0;
			setPull(0);
		};
		const onStart = (event: TouchEvent): void => {
			if (busyRef.current || event.touches.length !== 1) return;
			const box = scroller();
			if (box && box.scrollTop > 0) return;
			startRef.current = event.touches[0]!.clientY;
			activeRef.current = true;
		};
		const onMove = (event: TouchEvent): void => {
			if (!activeRef.current || event.touches.length !== 1) return;
			const dy = event.touches[0]!.clientY - startRef.current;
			if (dy <= 0) {
				reset();
				return;
			}
			const damped = Math.min(MAX_PULL, dy * 0.45);
			pullRef.current = damped;
			setPull(damped);
			if (damped > 6) event.preventDefault();
		};
		const onEnd = (): void => {
			if (!activeRef.current) return;
			activeRef.current = false;
			if (pullRef.current < THRESHOLD) {
				reset();
				return;
			}
			busyRef.current = true;
			setBusy(true);
			void Promise.resolve(onRefresh()).finally(() => {
				busyRef.current = false;
				setBusy(false);
				reset();
			});
		};

		el.addEventListener("touchstart", onStart, { passive: true });
		el.addEventListener("touchmove", onMove, { passive: false });
		el.addEventListener("touchend", onEnd);
		el.addEventListener("touchcancel", onEnd);
		return () => {
			el.removeEventListener("touchstart", onStart);
			el.removeEventListener("touchmove", onMove);
			el.removeEventListener("touchend", onEnd);
			el.removeEventListener("touchcancel", onEnd);
		};
	}, [onRefresh]);

	return (
		<div
			ref={hostRef}
			className="sh-pull"
			data-busy={busy ? "true" : "false"}
			style={pull > 0 ? { transform: `translateY(${pull}px)` } : undefined}
		>
			<div className="sh-pull-indicator" style={{ opacity: pull > 0 || busy ? 1 : 0 }} aria-hidden="true">
				<Loader2
					size={16}
					className={busy ? "ss-spin" : undefined}
					style={busy ? undefined : { transform: `rotate(${pull * 3}deg)` }}
				/>
			</div>
			{children}
		</div>
	);
}
