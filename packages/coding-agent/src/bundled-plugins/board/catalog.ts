/**
 * The board's card catalog — the types a card on a canvas may be.
 *
 * This lives in the board plugin because the board is what needs it: a card
 * persists with its type, and the board validator plus the `widget.schema` RPC
 * read this table. The session's visual surface (`bundled-plugins/visuals`)
 * owns blocks and pages and knows nothing about it; the board depends on that
 * plugin for the rendered result, not the other way round.
 */
import type { ExtensionWidget } from "../../extensibility/extensions/widget-types";

/** Card shell tones (mirrors the GUI registry's WidgetDef.tone so
 *  agents know the visual style of each type). */
export const WIDGET_TONES: Record<string, "default" | "dark" | "light" | "blue"> = {
	block: "default",
	html: "default",
};

export const WIDGET_TYPES: Record<
	string,
	{ fields: Array<{ key: string; type: string }>; defaults: Record<string, unknown> }
> = {
	block: {
		fields: [{ key: "source", type: "string" }],
		defaults: { source: 'root = Stack([Card("一块看板", [Text("把回复里的 ui 块放到这里。")])])' },
	},
	html: {
		fields: [
			{ key: "html", type: "string" },
			{ key: "data", type: "object" },
		],
		defaults: { html: "", data: {} },
	},
};

/**
 * Plugin-contributed widget types fold into the daemon-facing table.
 *
 * `registerWidget` owns the GUI renderer + metadata; this table stays the one
 * place a card type is validated — including session-less board RPCs, which run
 * before any renderer module is compiled.
 */

/**
 * The type table a call validates against: the static first-party table plus
 * any types loaded extensions declared at runtime. A plugin type never enters
 * `WIDGET_TYPES` itself (the plugin runs from its own copied tree), so the
 * caller passes `ctx.getRegisteredWidgets()` and gets one merged view.
 */
export function widgetTypesWith(
	extra: readonly ExtensionWidget[],
): Record<string, { fields: Array<{ key: string; type: string }>; defaults: Record<string, unknown> }> {
	if (extra.length === 0) return WIDGET_TYPES;
	const merged = { ...WIDGET_TYPES };
	for (const widget of extra) {
		merged[widget.type] = {
			fields: widget.fields.map(field => ({ key: field.key, type: field.type })),
			defaults: widget.defaults(),
		};
	}
	return merged;
}

/** Tones for the same merged view (board schema + editor). */
export function widgetTonesWith(extra: readonly ExtensionWidget[]): Record<string, string> {
	if (extra.length === 0) return WIDGET_TONES;
	const merged: Record<string, string> = { ...WIDGET_TONES };
	for (const widget of extra) merged[widget.type] = widget.tone ?? "default";
	return merged;
}
