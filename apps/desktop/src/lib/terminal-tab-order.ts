export interface OrderedTab {
	key: number;
}

/** Move a tab to another tab's position (insert before it). Unknown or
 *  identical keys return a shallow copy with the order unchanged. */
export function moveTabBefore<T extends OrderedTab>(tabs: readonly T[], fromKey: number, toKey: number): T[] {
	if (fromKey === toKey) return [...tabs];
	const from = tabs.findIndex(tab => tab.key === fromKey);
	const to = tabs.findIndex(tab => tab.key === toKey);
	if (from < 0 || to < 0) return [...tabs];
	const next = [...tabs];
	const [moved] = next.splice(from, 1);
	if (!moved) return [...tabs];
	// The target shifts left when the source was before it.
	next.splice(from < to ? to - 1 : to, 0, moved);
	return next;
}
