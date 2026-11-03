import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { CalcCard } from "./calc";
import { calcDefaults } from "./calc-defaults";
import {
	GaugeCard,
	HeatwallCard,
	heatwallDefaults,
	IndextapeCard,
	indextapeDefaults,
	KlineCard,
	klineDefaults,
} from "./finance";
import { FxCard, fxDefaults } from "./fx";
import { GalleryCard } from "./gallery";
import { galleryDefaults } from "./gallery-defaults";
import { gaugeDefaults } from "./gauge-defaults";
import { HistoryCard, historyDefaults } from "./history";
import { HtmlCard, htmlDefaults } from "./html";
import { MusicCard, musicDefaults } from "./music";
import { PomodoroCard } from "./pomodoro";
import { pomodoroDefaults } from "./pomodoro-defaults";
import { SliderCard } from "./slider";
import { sliderDefaults } from "./slider-defaults";
import { StocksCard, stocksDefaults } from "./stocks";
import { TickerCard } from "./ticker";
import { tickerDefaults } from "./ticker-defaults";
import { TodoCard } from "./todo";
import { todoDefaults } from "./todo-defaults";
import { VideoCard, videoDefaults } from "./video";

/**
 * Widget registry — the whitelist of board/inline widget types (see
 * docs/archive/board-dashboard.md + docs/archive/widget-design-system.md). Each entry
 * declares its data schema (fields drive agent autocomplete via
 * widget.schema in a later milestone) and its renderer. M1: six
 * self-built interactive components; reactbits visual components
 * (CountUp/ShinyText/SpotlightCard) join as decoration layers.
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
		type: "slider",
		tone: "light",
		nameKey: "widget slider",
		descKey: "widget slider desc",
		fields: [
			{ key: "noise", label: "noise", type: "number", min: 0, max: 1, step: 0.01 },
			{ key: "jitter", label: "jitter", type: "number", min: 0, max: 1, step: 0.01 },
			{ key: "freq", label: "freq", type: "number", min: 0.5, max: 6, step: 0.1 },
			{ key: "amp", label: "amp", type: "number", min: 0.1, max: 2, step: 0.05 },
		],
		defaults: sliderDefaults,
		Component: SliderCard,
	},
	{
		type: "calc",
		tone: "light",
		nameKey: "widget calc",
		descKey: "widget calc desc",
		fields: [
			{ key: "mode", label: "mode", type: "select", options: ["pre", "post"] },
			{ key: "amount", label: "amount", type: "number", min: 0, step: 1 },
		],
		defaults: calcDefaults,
		Component: CalcCard,
	},
	{
		type: "ticker",
		tone: "dark",
		nameKey: "widget ticker",
		descKey: "widget ticker desc",
		fields: [
			{ key: "label", label: "label", type: "string" },
			{ key: "value", label: "value", type: "string" },
			{ key: "delta", label: "delta", type: "number" },
		],
		defaults: tickerDefaults,
		Component: TickerCard,
	},
	{
		type: "todo",
		tone: "default",
		nameKey: "widget todo",
		descKey: "widget todo desc",
		fields: [{ key: "items", label: "items", type: "string" }],
		defaults: todoDefaults,
		Component: TodoCard,
	},
	{
		type: "pomodoro",
		tone: "blue",
		nameKey: "widget pomodoro",
		descKey: "widget pomodoro desc",
		fields: [
			{ key: "mode", label: "mode", type: "select", options: ["focus", "short", "long"] },
			{ key: "rounds", label: "rounds", type: "number", min: 0, step: 1 },
		],
		defaults: pomodoroDefaults,
		Component: PomodoroCard,
	},
	{
		type: "video",
		nameKey: "widget video",
		descKey: "widget video desc",
		tone: "dark",
		fields: [{ key: "url", label: "url", type: "string" }],
		defaults: videoDefaults,
		Component: VideoCard,
	},
	{
		type: "gallery",
		nameKey: "widget gallery",
		descKey: "widget gallery desc",
		tone: "default",
		fields: [{ key: "items", label: "items", type: "string" }],
		defaults: galleryDefaults,
		Component: GalleryCard,
	},
	{
		type: "gauge",
		nameKey: "widget gauge",
		descKey: "widget gauge desc",
		tone: "dark",
		fields: [
			{ key: "value", label: "value", type: "number", min: 0, max: 100 },
			{ key: "status", label: "status", type: "string" },
		],
		defaults: gaugeDefaults,
		Component: GaugeCard,
	},
	{
		type: "kline",
		nameKey: "widget kline",
		descKey: "widget kline desc",
		tone: "dark",
		fields: [{ key: "candles", label: "candles", type: "string" }],
		defaults: klineDefaults,
		Component: KlineCard,
	},
	{
		type: "heatwall",
		nameKey: "widget heatwall",
		descKey: "widget heatwall desc",
		tone: "dark",
		fields: [{ key: "tiles", label: "tiles", type: "string" }],
		defaults: heatwallDefaults,
		Component: HeatwallCard,
	},
	{
		type: "indextape",
		nameKey: "widget indextape",
		descKey: "widget indextape desc",
		tone: "dark",
		fields: [{ key: "indices", label: "indices", type: "string" }],
		defaults: indextapeDefaults,
		Component: IndextapeCard,
	},
	{
		type: "music",
		nameKey: "widget music",
		descKey: "widget music desc",
		tone: "dark",
		fields: [
			{ key: "brand", label: "brand", type: "string" },
			{ key: "mode", label: "mode", type: "string" },
		],
		defaults: musicDefaults,
		Component: MusicCard,
	},
	{
		type: "history",
		nameKey: "widget history",
		descKey: "widget history desc",
		tone: "default",
		fields: [
			{ key: "header", label: "header", type: "string" },
			{ key: "date", label: "date", type: "string" },
		],
		defaults: historyDefaults,
		Component: HistoryCard,
	},
	{
		type: "fx",
		nameKey: "widget fx",
		descKey: "widget fx desc",
		tone: "dark",
		fields: [
			{ key: "chip", label: "chip", type: "string" },
			{ key: "title", label: "title", type: "string" },
		],
		defaults: fxDefaults,
		Component: FxCard,
	},
	{
		type: "stocks",
		nameKey: "widget stocks",
		descKey: "widget stocks desc",
		tone: "dark",
		fields: [
			{ key: "chip", label: "chip", type: "string" },
			{ key: "title", label: "title", type: "string" },
		],
		defaults: stocksDefaults,
		Component: StocksCard,
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
export function widgetDefs(): WidgetDef[] {
	if (externalWidgets.length === 0) return [...WIDGET_REGISTRY];
	const byType = new Map<string, WidgetDef>(WIDGET_REGISTRY.map(def => [def.type, def]));
	for (const def of externalWidgets) byType.set(def.type, def);
	return [...byType.values()];
}

export function widgetDef(type: string): WidgetDef | undefined {
	return externalWidgets.find(w => w.type === type) ?? WIDGET_REGISTRY.find(w => w.type === type);
}
