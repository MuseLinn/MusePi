/**
 * Ordered array settings (schema `ui.ordered: true`, e.g.
 * providers.webSearchOrder): membership AND position are meaningful. The TUI
 * ordered-multiselect lets the user reshuffle; these helpers give the GUI
 * chip editor the same semantics.
 */

/** Swap one selected option one position earlier (-1) or later (+1). */
export function moveOrderedOption(current: readonly string[], value: string, delta: -1 | 1): string[] {
	const index = current.indexOf(value);
	const target = index + delta;
	if (index < 0 || target < 0 || target >= current.length) return [...current];
	const next = [...current];
	next[index] = next[target] as string;
	next[target] = value;
	return next;
}

/**
 * Display order for the chip editor: selected options in stored order first
 * (position = priority), then unselected options in declared order. A stable
 * sort keeps the declared order among equally-ranked (unselected) options.
 */
export function sortOrderedOptions<T extends { value: string }>(
	options: readonly T[],
	current: readonly string[],
): T[] {
	const rank = (value: string): number => {
		const index = current.indexOf(value);
		return index === -1 ? current.length : index;
	};
	return [...options].sort((a, b) => rank(a.value) - rank(b.value));
}
