/**
 * Shared 1s work-timer (openchamber useDurationTicker pattern): ONE
 * interval serves every subscriber — a long turn with many tool cards
 * doesn't spawn a setInterval per row. The timer only runs while at least
 * one component is actively subscribed.
 */
import { useEffect, useState } from "react";

const listeners = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | null = null;

function ensureTicker(): void {
	if (ticker === null) {
		ticker = setInterval(() => {
			for (const l of listeners) l();
		}, 1_000);
	}
}

function stopIfIdle(): void {
	if (listeners.size === 0 && ticker !== null) {
		clearInterval(ticker);
		ticker = null;
	}
}

/** Re-renders every second while `active`; returns the current wall clock. */
export function useWorkingNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		const l = (): void => setNow(Date.now());
		listeners.add(l);
		setNow(Date.now());
		ensureTicker();
		return () => {
			listeners.delete(l);
			stopIfIdle();
		};
	}, [active]);
	return now;
}
