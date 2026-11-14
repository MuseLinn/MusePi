import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";

/** Subscribe a React component to an external store (GuiSessionStore etc.). */
export function useStore<T>(subscribe: (cb: () => void) => () => void, get: () => T): T {
	return useSyncExternalStore(subscribe, get, get);
}

/** Shallow equality for selector results whose fields are primitives. */
function shallowEqual<T>(a: T, b: T): boolean {
	if (Object.is(a, b)) return true;
	if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
	const aKeys = Object.keys(a as Record<string, unknown>);
	const bKeys = Object.keys(b as Record<string, unknown>);
	if (aKeys.length !== bKeys.length) return false;
	for (const key of aKeys) {
		if (!Object.hasOwn(b, key)) return false;
		if (!Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
	}
	return true;
}

/**
 * Subscribe to ONE derived slice of an external store.
 *
 * `useStore` hands `getSnapshot()` straight to `useSyncExternalStore`, which
 * re-renders whenever that value's reference changes. A store that rebuilds its
 * snapshot per flush (GuiSessionStore does) therefore re-renders every
 * subscriber on every flush — even one that reads two booleans. This selector
 * variant keeps the PREVIOUS selected value when the new one is equal, so
 * React's `Object.is` check bails out and the component only re-renders when
 * something it reads actually changed.
 *
 * `isEqual` defaults to {@link shallowEqual}; pass `Object.is` for a single
 * primitive, or a custom comparator for a nested slice.
 */
export function useStoreSelector<T, S>(
	subscribe: (cb: () => void) => () => void,
	get: () => T,
	select: (state: T) => S,
	isEqual: (a: S, b: S) => boolean = shallowEqual,
): S {
	// React's official `useSyncExternalStoreWithSelector` shape: the memoized
	// selector caches (source, selection) so a re-render with the same source
	// reference is free and an equal selection keeps its old identity.
	const getSelection = useMemo(() => {
		let hasMemo = false;
		let memoizedSource: T;
		let memoizedSelection: S;
		const memoizedSelector = (nextSource: T): S => {
			if (!hasMemo) {
				hasMemo = true;
				memoizedSource = nextSource;
				memoizedSelection = select(nextSource);
				return memoizedSelection;
			}
			if (Object.is(memoizedSource, nextSource)) return memoizedSelection;
			const nextSelection = select(nextSource);
			memoizedSource = nextSource;
			if (isEqual(memoizedSelection, nextSelection)) return memoizedSelection;
			memoizedSelection = nextSelection;
			return nextSelection;
		};
		return (): S => memoizedSelector(get());
	}, [get, select, isEqual]);
	// A new `getSelection` must not keep answering from a disposed store.
	const latest = useRef(getSelection);
	latest.current = getSelection;
	const stableGet = useCallback(() => latest.current(), []);
	return useSyncExternalStore(subscribe, stableGet, stableGet);
}
