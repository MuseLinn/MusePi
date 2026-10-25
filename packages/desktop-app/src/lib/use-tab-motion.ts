import { useEffect, useMemo, useRef, useState } from "react";

const ENTER_MS = 130;
const EXIT_MS = 140;

function motionDisabled(): boolean {
	if (typeof document === "undefined" || typeof window === "undefined") return false;
	return (
		document.documentElement?.classList?.contains("gui-motion-off") === true ||
		window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
	);
}

interface ClosingTab<T> {
	tab: T;
	index: number;
}

export interface TabMotionResult<T> {
	tabs: readonly T[];
	enteringIds: ReadonlySet<string>;
	closingIds: ReadonlySet<string>;
}

export function useTabMotion<T extends { id: string }>(tabs: readonly T[]): TabMotionResult<T> {
	const previousRef = useRef(tabs);
	const [enteringIds, setEnteringIds] = useState<ReadonlySet<string>>(new Set());
	const [closing, setClosing] = useState<ReadonlyMap<string, ClosingTab<T>>>(new Map());
	const enterTimers = useRef(new Map<string, number>());
	const exitTimers = useRef(new Map<string, number>());
	const [reducedMotion, setReducedMotion] = useState(motionDisabled);

	useEffect(() => {
		const media =
			typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
		const update = (): void => setReducedMotion(motionDisabled());
		media?.addEventListener("change", update);
		const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(update);
		observer?.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
		return () => {
			media?.removeEventListener("change", update);
			observer?.disconnect();
		};
	}, []);

	useEffect(() => {
		if (reducedMotion) {
			previousRef.current = tabs;
			for (const timer of enterTimers.current.values()) clearTimeout(timer);
			for (const timer of exitTimers.current.values()) clearTimeout(timer);
			enterTimers.current.clear();
			exitTimers.current.clear();
			setEnteringIds(new Set());
			setClosing(new Map());
			return;
		}
		const previous = previousRef.current;
		const previousIds = new Set(previous.map(tab => tab.id));
		const liveIds = new Set(tabs.map(tab => tab.id));
		const added = tabs.filter(tab => !previousIds.has(tab.id));
		const removed = previous.filter(tab => !liveIds.has(tab.id));

		for (const id of liveIds) {
			const timer = exitTimers.current.get(id);
			if (timer !== undefined) clearTimeout(timer);
			exitTimers.current.delete(id);
		}
		setClosing(current => {
			const next = new Map(current);
			for (const id of liveIds) next.delete(id);
			for (const tab of removed) {
				next.set(tab.id, { tab, index: previous.findIndex(candidate => candidate.id === tab.id) });
				exitTimers.current.set(
					tab.id,
					window.setTimeout(() => {
						exitTimers.current.delete(tab.id);
						setClosing(currentClosing => {
							const remaining = new Map(currentClosing);
							remaining.delete(tab.id);
							return remaining;
						});
					}, EXIT_MS),
				);
			}
			return next;
		});

		if (added.length > 0) {
			setEnteringIds(current => new Set([...current, ...added.map(tab => tab.id)]));
			for (const tab of added) {
				enterTimers.current.set(
					tab.id,
					window.setTimeout(() => {
						enterTimers.current.delete(tab.id);
						setEnteringIds(current => {
							const next = new Set(current);
							next.delete(tab.id);
							return next;
						});
					}, ENTER_MS),
				);
			}
		}
		previousRef.current = tabs;
	}, [tabs, reducedMotion]);

	useEffect(
		() => () => {
			for (const timer of enterTimers.current.values()) clearTimeout(timer);
			for (const timer of exitTimers.current.values()) clearTimeout(timer);
			enterTimers.current.clear();
			exitTimers.current.clear();
		},
		[],
	);

	const displayTabs = useMemo(() => {
		const merged = [...tabs];
		for (const { tab, index } of closing.values()) {
			if (!tabs.some(candidate => candidate.id === tab.id)) merged.splice(Math.min(index, merged.length), 0, tab);
		}
		return merged;
	}, [tabs, closing]);
	const closingIds = useMemo(() => new Set(closing.keys()), [closing]);
	return { tabs: displayTabs, enteringIds, closingIds };
}
