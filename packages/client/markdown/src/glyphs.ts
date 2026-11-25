/**
 * Icon glyphs for the inline block controls (code fence, table, math, mermaid).
 *
 * `blockGlyph` serializes one to markup, for the toolbars the markdown renderer
 * still emits as HTML strings; `setBlockGlyph` swaps a glyph in place for the
 * two states a control has (copy → check, widen → restore). A React-owned
 * control uses `MorphIcon` with the same lucide data instead, so both spell the
 * same shapes.
 */

import {
	Check,
	Copy,
	Download,
	Ellipsis,
	FoldHorizontal,
	Maximize2,
	UnfoldHorizontal,
	X,
	ZoomIn,
	ZoomOut,
} from "lucide";

const BLOCK_GLYPH = {
	copy: Copy,
	check: Check,
	download: Download,
	more: Ellipsis,
	widen: UnfoldHorizontal,
	reset: FoldHorizontal,
	zoomIn: ZoomIn,
	zoomOut: ZoomOut,
	expand: Maximize2,
	close: X,
} as const;

export type BlockGlyphName = keyof typeof BLOCK_GLYPH;

/** Size of every inline block's action target, matching `.tr-code-btn`. */
export const BLOCK_GLYPH_SIZE = 14;

function blockGlyphSvg(name: BlockGlyphName, size: number): string {
	const parts = BLOCK_GLYPH[name].map(([tag, attrs]) => {
		const rendered = Object.entries(attrs)
			.map(([key, value]) => `${key}="${value}"`)
			.join(" ");
		return `<${tag} ${rendered}></${tag}>`;
	});
	// One template (not concatenated literals): the whole element reads as
	// markup, so the i18n gate sees no untranslated text nodes in it.
	return `<svg class="tr-code-glyph" data-glyph="${name}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${parts.join("")}</svg>`;
}

/** A toolbar icon as markup, for the renderers that build HTML strings. */
export function blockGlyph(name: BlockGlyphName, size = BLOCK_GLYPH_SIZE): string {
	return blockGlyphSvg(name, size);
}

/** Swap an already-rendered toolbar glyph in place. */
export function setBlockGlyph(button: HTMLElement, name: BlockGlyphName, size = BLOCK_GLYPH_SIZE): void {
	const glyph = button.querySelector<SVGElement>("svg[data-glyph]");
	if (!glyph || glyph.dataset.glyph === name) return;
	const host = document.createElement("div");
	host.innerHTML = blockGlyphSvg(name, size);
	const next = host.firstElementChild;
	if (next) glyph.replaceWith(next);
}
