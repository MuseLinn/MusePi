/**
 * Process-level index of widget types declared through `registerWidget`.
 *
 * The session tools get the same metadata through `ctx.getRegisteredWidgets()`
 * (their plugin runs from its own copied tree, so it cannot share a module
 * instance with the daemon). Session-less RPCs have no tool context, so
 * `board.save` / `widget.schema` read this index instead — it is written by
 * the loader's `registerWidget` implementation, which always runs in the
 * daemon process.
 *
 * Keyed by type with last registration winning; an extension reload replaces
 * its entry. Removing on unload is best-effort: another extension can have
 * registered the same type since, so the map is only cleared by type.
 */
import type { ExtensionWidget } from "../extensibility/extensions/types";

const registered = new Map<string, ExtensionWidget>();

/** Remember one plugin-declared widget type. */
export function rememberRegisteredWidget(widget: ExtensionWidget): void {
	registered.set(widget.type, widget);
}

/** Drop one type when its declaring extension unloads. */
export function forgetRegisteredWidget(type: string): void {
	registered.delete(type);
}

/** Every live plugin widget type (registration order within a process). */
export function getRegisteredWidgets(): ExtensionWidget[] {
	return [...registered.values()];
}

/** Test helper: clear the process index. */
export function resetRegisteredWidgets(): void {
	registered.clear();
}
