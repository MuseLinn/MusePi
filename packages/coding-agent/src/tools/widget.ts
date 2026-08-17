/**
 * `widget` tool — render an inline interactive widget in the transcript
 * (kimi inline-widget parity). Validates the type against the widget
 * registry schema (the same registry the board uses), merges defaults
 * into `data`, and returns a details payload the GUI's tool-render
 * pipeline renders as a living card. Text stays in the response; the
 * visual goes in the widget.
 */
import { type } from "@musepi/omptype";
import widgetDescription from "../prompts/tools/widget.md" with { type: "text" };
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@musepi/pi-agent-core";
import type { ToolExample } from "@musepi/pi-ai";

// The widget registry lives in collab-web (shared with the GUI board);
// the daemon keeps the type/field table in sync here for schema-driven
// validation and model-facing descriptions.
// WIDGET_TYPES: the agent-facing widget schema (also served over the
// widget.schema daemon RPC). `data.task` (optional) attaches a runnable
// task to a card — it MUST describe the card's own content (e.g. a ticker
// card's task refreshes rates); unrelated jobs are not allowed on
// display cards.
/** Card shell tones (mirrors the GUI registry's WidgetDef.tone so
 *  agents know the visual style of each type). */
export const WIDGET_TONES: Record<string, "default" | "dark" | "light" | "blue"> = {
	clock: "dark",
	slider: "light",
	calc: "light",
	ticker: "dark",
	metric: "default",
	todo: "default",
	pomodoro: "blue",
	video: "dark",
	gallery: "default",
	gauge: "dark",
	kline: "dark",
	heatwall: "dark",
	indextape: "dark",
	music: "dark",
	history: "default",
	html: "default",
	fx: "dark",
	stocks: "dark",
};

export const WIDGET_TYPES: Record<string, { fields: Array<{ key: string; type: string }>; defaults: Record<string, unknown> }> = {
	clock: { fields: [{ key: "market", type: "string" }], defaults: { market: "cn" } },
	slider: {
		fields: [
			{ key: "noise", type: "number" },
			{ key: "jitter", type: "number" },
			{ key: "freq", type: "number" },
			{ key: "amp", type: "number" },
		],
		defaults: { noise: 0.2, jitter: 0.1, freq: 2, amp: 1 },
	},
	calc: { fields: [{ key: "mode", type: "string" }, { key: "amount", type: "number" }], defaults: { mode: "post", amount: 1760 } },
	ticker: {
		fields: [{ key: "label", type: "string" }, { key: "value", type: "string" }, { key: "delta", type: "number" }],
		defaults: { label: "EUR / CNY", value: "7.7945", delta: 0.0046, spark: [7.7, 7.72, 7.69, 7.74, 7.76, 7.75, 7.79, 7.78, 7.8] },
	},
	metric: {
		fields: [{ key: "label", type: "string" }, { key: "value", type: "number" }, { key: "delta", type: "number" }],
		defaults: { label: "metric", value: 4200, delta: 0.12, history: [3, 4, 3.5, 5, 4.5, 6, 5.5, 7, 6.5, 8, 7.5, 9] },
	},
	todo: { fields: [{ key: "items", type: "array" }], defaults: { items: [] } },
	pomodoro: { fields: [{ key: "mode", type: "string" }, { key: "rounds", type: "number" }], defaults: { mode: "focus", rounds: 0, minutes: 0, day: "" } },
	video: { fields: [{ key: "url", type: "string" }], defaults: { url: "", bvid: "BV1vT411d7QE", title: "凡人修仙传", subtitle: "BILIBILI · 年番" } },
	gallery: {
		fields: [{ key: "items", type: "array" }],
		defaults: { items: [{ title: "Kimi K3" }, { title: "PerceptionBench" }, { title: "Agent Swarm" }, { title: "WorldVQA" }] },
	},
	gauge: { fields: [{ key: "value", type: "number" }, { key: "status", type: "string" }], defaults: { label: "A股市场温度", value: 70, status: "活跃 · 沪深创" } },
	kline: { fields: [{ key: "candles", type: "array" }], defaults: { symbol: "腾讯控股", price: 478.8, delta: -0.08, candles: [], stocks: ["腾讯控股", "阿里巴巴", "贵州茅台", "宁德时代"] } },
	heatwall: { fields: [{ key: "tiles", type: "array" }], defaults: { tiles: [			{ name: "工商银行", delta: -0.53 },			{ name: "中国石油", delta: 0.84 },			{ name: "宁德时代", delta: 0.02 },			{ name: "贵州茅台", delta: 0.05 },			{ name: "中芯国际", delta: 3.5 },			{ name: "招商银行", delta: -0.44 },			{ name: "中国平安", delta: -0.22 },			{ name: "紫金矿业", delta: 1.88 },			{ name: "比亚迪", delta: 0.66 },			{ name: "长江电力", delta: 0 },			{ name: "美的集团", delta: -2.13 },			{ name: "中国石化", delta: 0.39 },			{ name: "立讯精密", delta: 0.1 },			{ name: "中信证券", delta: 0.2 },			{ name: "兴业银行", delta: -0.12 },			{ name: "恒瑞医药", delta: 0.05 },			{ name: "京东方A", delta: 1.84 },			{ name: "平安银行", delta: 0.08 },		] } },
	indextape: { fields: [{ key: "indices", type: "array" }], defaults: { indices: ["上证", "深证", "恒生"], value: 3940.84, delta: 1.02, series: [3800, 3850, 3830, 3900, 3920, 3880, 3940, 3930, 3955, 3940] } },
	html: {
		fields: [{ key: "html", type: "string" }, { key: "data", type: "object" }],
		defaults: { html: "", data: {} },
	},
	music: {
		fields: [
			{ key: "brand", type: "string" },
			{ key: "mode", type: "string" },
		],
		defaults: {
			brand: "GT78_ANLZR",
			mode: "78RPM",
			volume: 0.8,
			queue: [
				{
					id: "78_valse-in-d-flat-major_sergei-rachmaninoff-chopin_gbia0012582a",
					year: "1921",
					title: "Valse in D Flat Major",
					artist: "Sergei Rachmaninoff · Chopin",
					file: "Valse in D Flat Major - Sergei Rachmaninoff-restored.mp3",
				},
				{
					id: "78_valse-in-a-flat-op-42_sergei-rachmaninoff-chopin_gbia0307222a",
					year: "1919",
					title: "Valse in A Flat, Op. 42",
					artist: "Sergei Rachmaninoff · Chopin",
					file: "Valse in A Flat Op. 42 - SERGEI RACHMANINOFF.mp3",
				},
				{
					id: "78_mazurka-in-c-sharp-minor_sergei-rachmaninoff-chopin_gbia0015772a",
					year: "1923",
					title: "Mazurka in C Sharp Minor",
					artist: "Sergei Rachmaninoff · Chopin",
					file: "Mazurka (in C Sharp Minor) - Sergei Rachmaninoff-restored.mp3",
				},
			],
		},
	},
	fx: {
		fields: [
			{ key: "chip", type: "string" },
			{ key: "title", type: "string" },
		],
		defaults: {
			chip: "FX · 1 MIN",
			title: "汇率",
			pairs: [
				{ code: "EUR", unit: 1, note: "1 欧元" },
				{ code: "USD", unit: 1, note: "1 美元" },
				{ code: "JPY", unit: 100, note: "100 日元" },
				{ code: "KRW", unit: 100, note: "100 韩元" },
			],
			refresh: 60,
		},
	},
	stocks: {
		fields: [
			{ key: "chip", type: "string" },
			{ key: "title", type: "string" },
		],
		defaults: {
			chip: "A-SHARES",
			title: "A股盯盘",
			rows: [
				{ code: "sh600519", label: "600519", badge: "沪", name: "贵州茅台" },
				{ code: "sz300750", label: "300750", badge: "深", name: "宁德时代" },
				{ code: "sz002594", label: "002594", badge: "深", name: "比亚迪" },
			],
		},
	},
	history: {
		fields: [
			{ key: "header", type: "string" },
			{ key: "date", type: "string" },
		],
		defaults: {
			header: "HISTORY",
			date: "历史上的今天",
			events: [
				{
					year: "2008",
					text: "北京承办的奥运会为世界奉献了一场精彩的体育盛宴，共创造43项新世界纪录及132项新奥运纪录，中国以51枚金牌居金牌榜首位。",
				},
				{ year: "1887", text: "李享亭（1897～1987），内科专家、医学教育家、中国消化病学的奠基人。" },
				{ year: "1980", text: "罗杰·费德勒（Roger Federer, 1981年8月8日—），瑞士男子职业网球运动员。" },
			],
		},
	},
};

// Upper bound for widget data (agents sometimes pass verbose payloads);
// oversized data is rejected instead of bloating the transcript.
const MAX_DATA_JSON = 12_000;

const widgetSchema = type({
	type: type("string").describe("Widget type: " + Object.keys(WIDGET_TYPES).join(" / ")),
	"data?": type("object").describe("Widget data fields per type (defaults fill the rest)"),
	"title?": type("string").describe("Optional card title (defaults to the widget name)"),
});

export interface WidgetToolDetails {
	type: string;
	data: Record<string, unknown>;
	title?: string;
}

export class WidgetTool implements AgentTool<typeof widgetSchema, WidgetToolDetails> {
	readonly name = "widget";
	readonly label = "Widget";
	readonly strict = true;
	readonly approval = "read" as const;
	readonly description = widgetDescription;
	readonly parameters = widgetSchema;
	readonly examples: readonly ToolExample<typeof widgetSchema.infer>[] = [
		{
			caption: "Render a labor-fee calculator",
			call: { type: "calc", data: { mode: "post", amount: 1760 } },
		},
		{
			caption: "Render a ticker quote",
			call: { type: "ticker", data: { label: "EUR / CNY", value: "7.7945", delta: 0.0046 } },
		},
	];

	async execute(
		_toolCallId: string,
		params: typeof widgetSchema.infer,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<WidgetToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<WidgetToolDetails>> {
		const typeName = typeof params.type === "string" ? params.type : "";
		const spec = WIDGET_TYPES[typeName];
		if (!spec) {
			return {
				content: [{ type: "text", text: `widget: unknown type "${typeName}" — available: ${Object.keys(WIDGET_TYPES).join(", ")}` }],
				isError: true,
			};
		}
		const rawData =
			params.data !== undefined && typeof params.data === "object" && params.data !== null
				? (params.data as Record<string, unknown>)
				: {};
		if (rawData && JSON.stringify(rawData).length > MAX_DATA_JSON) {
			return {
				content: [{ type: "text", text: `widget: data payload exceeds ${MAX_DATA_JSON} bytes — trim the data fields` }],
				isError: true,
			};
		}
		const details: WidgetToolDetails = { type: typeName, data: { ...spec.defaults, ...rawData } };
		if (typeof params.title === "string" && params.title.length > 0) details.title = params.title;
		return {
			content: [
				{
					type: "text",
					text: `Rendered ${typeName} widget${details.title ? ` "${details.title}"` : ""} (${Object.keys(details.data).length} data fields).`,
				},
			],
			details,
		};
	}
}
