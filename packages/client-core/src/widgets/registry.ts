import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { BlockCard, blockDefaults } from "./block";
import { HtmlCard, htmlDefaults } from "./html";

/**
 * Widget registry — the whitelist of board card types.
 *
 * Two entries, both generated: a `ui` block and a self-contained HTML page.
 * The canned faces (market tape, calculator, clock, …) were the board's first
 * design; they were a fixed catalog pretending to be generative UI, so they
 * are gone rather than kept as a compatibility layer. A board card is now
 * something the agent generated, and nothing else.
 */

/** One widget instance on a board. */
export interface BoardWidget {
	id: string;
	type: string;
	title: string;
	data: Record<string, unknown>;
	/** Pixel layout on the board canvas (absolute positioning, snapped to
	 *  the 8px grid — kimi-style pixel-precise resize). Legacy cell layout
	 *  is migrated on load. */
	pos: { x: number; y: number; w: number; h: number };
}

export interface WidgetField {
	key: string;
	label?: string;
	type: "number" | "string" | "boolean" | "select";
	options?: readonly string[];
	min?: number;
	max?: number;
	step?: number;
}

export type WidgetTone = "default" | "dark" | "light" | "blue";

export interface WidgetDef {
	type: string;
	/** i18n keys for the built-in add-widget picker. Plugin-contributed types
	 *  carry a plain `label`/`description` instead (they ship no host i18n key). */
	nameKey?: string;
	descKey?: string;
	label?: string;
	description?: string;
	/** Compiled renderer module for a plugin type (set by the extension loader).
	 *  Pin windows live in a separate renderer process, so they need the code
	 *  to register the type locally. Absent for built-in types. */
	code?: string;
	fields: WidgetField[];
	/** Card shell treatment (kimi hello-world boards mix dark/light/blue
	 *  cards, not one uniform theme surface). */
	tone?: WidgetTone;
	defaults(): Record<string, unknown>;
	/** Offered in the board's add-widget list. Canned faces are legacy: they
	 *  still draw where a board already holds one, but new work is a generated
	 *  block or page, so they are no longer offered. */
	palette?: boolean;
	Component(props: {
		data: Record<string, unknown>;
		update(patch: Record<string, unknown>): void;
		/** Static collection preview: disable live requests and animation work. */
		preview?: boolean;
		/** Push an intent back to the conversation (kimi sendPrompt parity):
		 *  inline chat widgets call this to hand results to the agent; the
		 *  board (no conversation) simply never passes it, and components
		 *  hide their send affordance when absent. */
		sendPrompt?(text: string): void;
		/** 统一标注:宿主把整张卡片 rasterize 成图(html 卡片用;桌面渲染器
		 *  提供,棋盘/导出等无 rasterizer 的宿主不传,标注入口随之隐藏)。 */
		annotateCapture?(): Promise<Blob | null>;
	}): ReactNode;
}

export const WIDGET_REGISTRY: readonly WidgetDef[] = [
	{
		type: "block",
		tone: "default",
		nameKey: "widget block",
		descKey: "widget block desc",
		fields: [{ key: "source", label: "source", type: "string" }],
		defaults: blockDefaults,
		Component: BlockCard,
	},
	{
		type: "html",
		tone: "default",
		nameKey: "widget html",
		descKey: "widget html desc",
		fields: [
			{ key: "html", label: "html", type: "string" },
			{ key: "data", label: "data", type: "string" },
		],
		defaults: htmlDefaults,
		Component: HtmlCard,
	},
];

/**
 * Widget types contributed by extensions (registerWidget), loaded at runtime
 * after `extensions.list` compiles their renderer modules.
 *
 * They live beside the built-ins rather than replacing the array: plugin types
 * are discovered asynchronously, while seeds, board lookup and the transcript
 * may ask for a type at any time. External entries win a type collision so a
 * plugin can override a built-in without forking the registry.
 */
let externalWidgets: WidgetDef[] = [];
let widgetVersion = 0;
const widgetListeners = new Set<() => void>();

/** Replace the external widget set (empty array clears it). */
export function registerExternalWidgets(defs: readonly WidgetDef[]): void {
	externalWidgets = [...defs];
	widgetVersion += 1;
	for (const listener of widgetListeners) listener();
}

/** Subscribe to registry changes (React's useSyncExternalStore contract). */
export function subscribeWidgets(listener: () => void): () => void {
	widgetListeners.add(listener);
	return () => widgetListeners.delete(listener);
}

/** Version snapshot; components subscribe to it so a late plugin load
 *  re-renders the picker and any inline card waiting for its type. */
export function useWidgetRegistryVersion(): number {
	return useSyncExternalStore(
		subscribeWidgets,
		() => widgetVersion,
		() => 0,
	);
}

/** Built-ins plus plugin-contributed types, external entries last-wins. */
/** Types the board's add-widget list offers: generated faces only. A canned
 *  face keeps `widgetDef()` so an existing board still draws it. */
export function paletteWidgetDefs(): WidgetDef[] {
	return widgetDefs().filter(def => def.palette !== false);
}

export function widgetDefs(): WidgetDef[] {
	if (externalWidgets.length === 0) return [...WIDGET_REGISTRY];
	const byType = new Map<string, WidgetDef>(WIDGET_REGISTRY.map(def => [def.type, def]));
	for (const def of externalWidgets) byType.set(def.type, def);
	return [...byType.values()];
}

export function widgetDef(type: string): WidgetDef | undefined {
	return externalWidgets.find(w => w.type === type) ?? WIDGET_REGISTRY.find(w => w.type === type);
}
