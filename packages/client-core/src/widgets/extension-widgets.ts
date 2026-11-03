/**
 * Load `registerWidget` renderers into the shared widget registry.
 *
 * The daemon compiles each card module into self-contained ESM; every host
 * (desktop slot host, guest/mobile web bundle) imports that blob against its
 * own React instance. Keeping the import + metadata assembly here means the
 * desktop and guest paths cannot drift on module shape or failure handling.
 *
 * The caller must have published `window.MusePiReact` (client-core's entry and
 * the desktop slot host both do). A module that fails to import is skipped —
 * one broken plugin card must not take the board down.
 */
import type { WidgetDef, WidgetField, WidgetTone } from "./registry";

/** One compiled widget entry as served by `extensions.list`. */
export interface ExtensionWidgetArtifact {
	type: string;
	label: string;
	description?: string;
	fields: WidgetField[];
	defaults: Record<string, unknown>;
	tone?: WidgetTone;
	/** Self-contained ESM exporting the card component. */
	code: string;
	error?: string;
}

/** Import every artifact and return the defs that produced a component. */
export async function loadExtensionWidgets(items: readonly ExtensionWidgetArtifact[]): Promise<WidgetDef[]> {
	const defs: WidgetDef[] = [];
	for (const item of items) {
		if (item.error || !item.code) continue;
		const url = URL.createObjectURL(new Blob([item.code], { type: "text/javascript" }));
		try {
			const mod = (await import(url)) as { default?: unknown };
			const exported = mod.default;
			const Component =
				typeof exported === "function"
					? exported
					: exported &&
							typeof exported === "object" &&
							typeof (exported as { Component?: unknown }).Component === "function"
						? (exported as { Component: unknown }).Component
						: null;
			if (Component === null) {
				console.warn(`widget "${item.type}" missing default component export`);
				continue;
			}
			defs.push({
				type: item.type,
				label: item.label,
				...(item.description ? { description: item.description } : {}),
				fields: item.fields,
				defaults: () => ({ ...item.defaults }),
				...(item.tone ? { tone: item.tone } : {}),
				Component: Component as WidgetDef["Component"],
			});
		} catch (error) {
			console.warn(`widget "${item.type}" load failed`, error);
		} finally {
			// Settle, then release: revoking while the import is in flight fails it.
			URL.revokeObjectURL(url);
		}
	}
	return defs;
}
