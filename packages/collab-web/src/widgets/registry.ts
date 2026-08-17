import type { ReactNode } from "react";
import { CalcCard } from "./calc";
import { calcDefaults } from "./calc-defaults";
import { ClockCard } from "./clock";
import { clockDefaults } from "./clock-defaults";
import { MetricCard } from "./metric";
import { metricDefaults } from "./metric-defaults";
import { PomodoroCard } from "./pomodoro";
import { pomodoroDefaults } from "./pomodoro-defaults";
import { SliderCard } from "./slider";
import { sliderDefaults } from "./slider-defaults";
import { TickerCard } from "./ticker";
import { tickerDefaults } from "./ticker-defaults";
import { TodoCard } from "./todo";
import { todoDefaults } from "./todo-defaults";
import { GaugeCard, HeatwallCard, IndextapeCard, KlineCard, heatwallDefaults, indextapeDefaults, klineDefaults } from "./finance";
import { gaugeDefaults } from "./gauge-defaults";
import { GalleryCard } from "./gallery";
import { galleryDefaults } from "./gallery-defaults";
import { HtmlCard, htmlDefaults } from "./html";
import { VideoCard, videoDefaults } from "./video";
import { MusicCard, musicDefaults } from "./music";
import { HistoryCard, historyDefaults } from "./history";
import { FxCard, fxDefaults } from "./fx";
import { StocksCard, stocksDefaults } from "./stocks";

/**
 * Widget registry — the whitelist of board/inline widget types (see
 * docs/board-dashboard.md + docs/widget-design-system.md). Each entry
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
	label: string;
	type: "number" | "string" | "boolean" | "select";
	options?: string[];
	min?: number;
	max?: number;
	step?: number;
}

export type WidgetTone = "default" | "dark" | "light" | "blue";

export interface WidgetDef {
	type: string;
	/** i18n keys for the add-widget picker. */
	nameKey: string;
	descKey: string;
	fields: WidgetField[];
	/** Card shell treatment (kimi hello-world boards mix dark/light/blue
	 *  cards, not one uniform theme surface). */
	tone?: WidgetTone;
	defaults(): Record<string, unknown>;
	Component(props: {
		data: Record<string, unknown>;
		update(patch: Record<string, unknown>): void;
		/** Push an intent back to the conversation (kimi sendPrompt parity):
		 *  inline chat widgets call this to hand results to the agent; the
		 *  board (no conversation) simply never passes it, and components
		 *  hide their send affordance when absent. */
		sendPrompt?(text: string): void;
	}): ReactNode;
}

export const WIDGET_REGISTRY: readonly WidgetDef[] = [
	{
		type: "clock",
		tone: "dark",
		nameKey: "widget clock",
		descKey: "widget clock desc",
		fields: [{ key: "market", label: "market", type: "select", options: ["cn", "us", "eu"] }],
		defaults: clockDefaults,
		Component: ClockCard,
	},
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
		type: "metric",
		tone: "default",
		nameKey: "widget metric",
		descKey: "widget metric desc",
		fields: [
			{ key: "label", label: "label", type: "string" },
			{ key: "value", label: "value", type: "number" },
			{ key: "delta", label: "delta", type: "number" },
		],
		defaults: metricDefaults,
		Component: MetricCard,
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

export function widgetDef(type: string): WidgetDef | undefined {
	return WIDGET_REGISTRY.find(w => w.type === type);
}
