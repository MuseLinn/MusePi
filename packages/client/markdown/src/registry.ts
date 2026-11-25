/**
 * The markdown block seam.
 *
 * A message's markdown is rendered block by block. Each block kind is owned by
 * one component from this registry, and a kind with no entry falls back to the
 * renderer's HTML path — so a new block can be adopted one kind at a time
 * instead of requiring the whole pipeline to change at once.
 *
 * Contributions arrive the same way widget types do (`widgets/registry.ts`):
 * built-ins live here, extension-provided entries are registered later and win
 * a kind collision, and hosts subscribe so a late plugin load re-renders what
 * is already on screen.
 */

import type { ComponentType } from "react";

/** A table's parsed payload: the cells' source text and their inline tokens. */
export interface MarkdownTablePayload {
	align: ReadonlyArray<"center" | "left" | "right" | null>;
	header: ReadonlyArray<MarkdownTableCellPayload>;
	rows: ReadonlyArray<ReadonlyArray<MarkdownTableCellPayload>>;
}

export interface MarkdownTableCellPayload {
	/** The cell's inline tokens, rendered to HTML by the pipeline. */
	tokens: readonly unknown[];
	/** Plain text, for CSV / clipboard output. */
	text: string;
}

/**
 * Labels a block draws. The host resolves them (the package carries no locale
 * dictionary), which is the same contract `AnnotationOverlayLabels` uses.
 */
export interface MarkdownBlockLabels {
	readonly copied: string;
	readonly copy: string;
	readonly download: string;
	readonly expand: string;
	readonly moreFormats: string;
	readonly quoteRegion: string;
	readonly resetWidth: string;
	readonly widen: string;
}

export interface MarkdownBlockProps {
	/** The block's source markdown. */
	readonly source: string;
	/** Rendered HTML for the block, when the renderer produced one. */
	readonly html: string | null;
	/** Present for `table`. */
	readonly table?: MarkdownTablePayload;
	/** Renders inline tokens (emphasis, code spans, math…) to HTML. */
	renderInline(tokens: readonly unknown[]): string;
	/** Whether the reply that holds this block is still streaming. */
	readonly streaming: boolean;
	readonly labels: MarkdownBlockLabels;
	/** Quote text into the composer (same channel as a quoted paragraph). */
	quoteText?(text: string): void;
}

export interface MarkdownBlockDef {
	readonly kind: string;
	readonly Component: ComponentType<MarkdownBlockProps>;
}

/** Kinds the pipeline routes to a component. A kind absent here keeps the
 *  renderer's HTML output. */
const BUILTIN_BLOCKS: readonly MarkdownBlockDef[] = [];

let externalBlocks: MarkdownBlockDef[] = [];
const listeners = new Set<() => void>();

export function registerMarkdownBlocks(defs: readonly MarkdownBlockDef[]): void {
	externalBlocks = [...defs];
	for (const listener of listeners) listener();
}

export function markdownBlockDefs(): readonly MarkdownBlockDef[] {
	if (externalBlocks.length === 0) return BUILTIN_BLOCKS;
	const byKind = new Map(BUILTIN_BLOCKS.map(def => [def.kind, def]));
	// External entries win a collision, so a plugin can replace a built-in block
	// without forking the registry.
	for (const def of externalBlocks) byKind.set(def.kind, def);
	return [...byKind.values()];
}

export function markdownBlockDef(kind: string): MarkdownBlockDef | undefined {
	return externalBlocks.find(def => def.kind === kind) ?? BUILTIN_BLOCKS.find(def => def.kind === kind);
}

export function subscribeMarkdownBlocks(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
