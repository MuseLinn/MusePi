/** Drag-axis locks for dnd-kit sortable strips.
 *
 * A horizontal strip that is free to translate on Y drifts off its own row
 * while the pointer travels toward a different drop target — dragging a tab
 * down to split the panel made the strip itself slide vertically. The same
 * happens sideways for the vertical rail. Locking the unused axis keeps the
 * chip on its track; collision detection still reads the real pointer
 * coordinates, so drop targets outside the strip keep working. */
import type { Modifier } from "@dnd-kit/core";

export const restrictToXAxis: Modifier = ({ transform }) => ({ ...transform, y: 0 });

export const restrictToYAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });
