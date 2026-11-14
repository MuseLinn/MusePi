/**
 * Ordered array settings (schema `ui.ordered: true`, e.g.
 * providers.webSearchOrder): membership AND position are meaningful. The TUI
 * ordered-multiselect lets the user reshuffle; the GUI editor keeps the same
 * semantics over the stored array order.
 */

/**
 * Display order for the priority editor: selected options in stored order
 * first (position = priority), then unselected options in declared order. A
 * stable sort keeps the declared order among equally-ranked (unselected)
 * options.
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
