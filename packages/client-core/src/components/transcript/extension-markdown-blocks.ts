/**
 * Load extension-contributed markdown block renderers into the shared registry.
 *
 * Same delivery as widget cards (`widgets/extension-widgets.ts`): the daemon
 * compiles each block module into self-contained ESM, and every host imports
 * that blob against its own React instance. A module that fails to import is
 * skipped — one broken plugin block must not take the whole transcript down,
 * and the kind falls back to whatever the built-in registry has (or to the
 * renderer's own HTML when nothing claims it).
 *
 * The caller must have published `window.MusePiReact`, as for widget modules.
 */

import type { MarkdownBlockDef } from "@musepi/client-markdown";
import { registerMarkdownBlocks } from "@musepi/client-markdown";

/** One compiled block entry as served by `extensions.list`. */
export interface ExtensionMarkdownBlockArtifact {
	kind: string;
	label: string;
	description?: string;
	/** Self-contained ESM exporting the block component. */
	code: string;
	error?: string;
}

/** A module may export the component directly or as `{ Component }`. */
function componentOf(exported: unknown): MarkdownBlockDef["Component"] | null {
	if (typeof exported === "function") return exported as MarkdownBlockDef["Component"];
	if (exported && typeof exported === "object") {
		const candidate = (exported as { Component?: unknown }).Component;
		if (typeof candidate === "function") return candidate as MarkdownBlockDef["Component"];
	}
	return null;
}

/** Import every artifact and register the ones that produced a component. */
export async function loadExtensionMarkdownBlocks(
	items: readonly ExtensionMarkdownBlockArtifact[],
): Promise<MarkdownBlockDef[]> {
	const defs: MarkdownBlockDef[] = [];
	for (const item of items) {
		if (item.error || !item.code) continue;
		const url = URL.createObjectURL(new Blob([item.code], { type: "text/javascript" }));
		try {
			// A runtime blob URL, never a build input: Vite cannot analyze it, and
			// must not try.
			const mod = (await import(/* @vite-ignore */ url)) as { default?: unknown };
			const Component = componentOf(mod.default ?? mod);
			if (!Component) {
				console.warn(`markdown block "${item.kind}" missing component export`);
				continue;
			}
			defs.push({ kind: item.kind, Component });
		} catch (error) {
			// The kind keeps its built-in renderer (or the HTML fallback): a failed
			// plugin block is a missing enhancement, not a broken message.
			console.warn(`markdown block "${item.kind}" load failed`, error);
		} finally {
			// Settle, then release: revoking while the import is in flight fails it.
			URL.revokeObjectURL(url);
		}
	}
	if (defs.length > 0) registerMarkdownBlocks(defs);
	return defs;
}
