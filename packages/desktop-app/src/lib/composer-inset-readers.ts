/**
 * Publishes the floating composer's geometry onto the elements that read it.
 *
 * The naive version — set `--chat-composer-inset` on the chat column and let
 * it inherit — restyles the whole transcript on every value change. The column
 * is an ancestor of every virtualized row, so a custom property written there
 * invalidates style for all of them; the reference implementation measured
 * 60-90ms per new composer line on a long session (~50,000 elements).
 *
 * The readers are leaves: one tail spacer, one end-fade band. So the values are
 * written **onto the readers** instead. A reader registers when it mounts and
 * immediately receives the column's current value (or nothing, falling back to
 * the CSS defaults); the column's observer then updates only the registered
 * readers inside it.
 *
 */

interface ComposerInsets {
	/** The composer slot's height, px — the end fade's band. */
	readonly inset: number;
	/** The band the list footer reserves, px — resting height plus the gap. */
	readonly tailInset: number;
}

type Release = () => void;

function setPx(element: HTMLElement, property: string, px: number | null): void {
	if (px === null) {
		element.style.removeProperty(property);
		return;
	}
	const value = `${px}px`;
	if (element.style.getPropertyValue(property) !== value) element.style.setProperty(property, value);
}

/**
 * One published value per column, plus the readers it lands on.
 *
 * The column carries `attribute` while it publishes, so a reader that mounts
 * later finds the value it falls under without waiting for the next resize.
 */
function createReaderChannel<TValue>(
	attribute: string,
	apply: (reader: HTMLElement, value: TValue | null) => void,
): {
	register(reader: HTMLElement): Release;
	publish(column: HTMLElement, value: TValue): void;
	withdraw(column: HTMLElement): void;
} {
	const readers = new Set<HTMLElement>();
	const publishedByColumn = new WeakMap<HTMLElement, TValue>();
	const applyInside = (column: HTMLElement, value: TValue | null): void => {
		for (const reader of readers) {
			if (column.contains(reader)) apply(reader, value);
		}
	};
	return {
		register(reader: HTMLElement): Release {
			readers.add(reader);
			const column = reader.closest<HTMLElement>(`[${attribute}]`);
			apply(reader, column ? (publishedByColumn.get(column) ?? null) : null);
			return () => {
				readers.delete(reader);
			};
		},
		publish(column: HTMLElement, value: TValue): void {
			column.setAttribute(attribute, "");
			publishedByColumn.set(column, value);
			applyInside(column, value);
		},
		withdraw(column: HTMLElement): void {
			column.removeAttribute(attribute);
			publishedByColumn.delete(column);
			applyInside(column, null);
		},
	};
}

const composerInsets = createReaderChannel<ComposerInsets>("data-composer-inset-column", (reader, insets) => {
	setPx(reader, "--chat-composer-inset", insets?.inset ?? null);
	setPx(reader, "--chat-composer-tail-inset", insets?.tailInset ?? null);
});

/**
 * Panels that float ABOVE the composer (the ask card) are absolutely
 * anchored, so their height never lands in the wrap measurement. They
 * publish their own height + gap as this clearance; the tail spacer and the
 * end fade add it so a docked panel never covers the last rows.
 */
const floatingPanelClearance = createReaderChannel<number>("data-floating-panel-clearance-column", (reader, px) => {
	setPx(reader, "--chat-floating-panel-clearance", px);
});

/**
 * Registers an element that reads the composer insets AND the floating
 * panel clearance (the tail spacer and the end-fade band; use as a ref
 * callback). Until its column publishes, the reader keeps its CSS fallbacks.
 */
export function registerComposerInsetReader(reader: HTMLElement | null): Release | undefined {
	if (!reader) return undefined;
	const releaseInsets = composerInsets.register(reader);
	const releaseClearance = floatingPanelClearance.register(reader);
	return () => {
		releaseInsets();
		releaseClearance();
	};
}

/** The column's composer measured these insets; its readers take them. */
export function publishComposerInsets(column: HTMLElement, insets: ComposerInsets): void {
	composerInsets.publish(column, insets);
}

/** The column's composer stopped floating: its readers fall back to CSS. */
export function withdrawComposerInsets(column: HTMLElement): void {
	composerInsets.withdraw(column);
}

/** A panel floating above the column's composer measured this clearance, px. */
export function publishFloatingPanelClearance(column: HTMLElement, clearance: number): void {
	floatingPanelClearance.publish(column, clearance);
}

/** No panel is floating above the column's composer any more. */
export function withdrawFloatingPanelClearance(column: HTMLElement): void {
	floatingPanelClearance.withdraw(column);
}
