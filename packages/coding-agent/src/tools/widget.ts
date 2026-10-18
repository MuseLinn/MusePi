/**
 * `widget` tool — render an inline interactive widget in the transcript
 * (kimi inline-widget parity). Validates the type against the widget
 * registry schema (the same registry the board uses), merges defaults
 * into `data`, and returns a details payload the GUI's tool-render
 * pipeline renders as a living card. Text stays in the response; the
 * visual goes in the widget.
 */
import { type } from "@musepi/musepi-type";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@musepi/pi-agent-core";
import type { ToolExample } from "@musepi/pi-ai";
import { MAX_WIDGET_HTML } from "@musepi/pi-utils";
import widgetDescription from "../prompts/tools/widget.md" with { type: "text" };

// The widget registry lives in guest-client (shared with the GUI board);
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

export const WIDGET_TYPES: Record<
	string,
	{ fields: Array<{ key: string; type: string }>; defaults: Record<string, unknown> }
> = {
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
	calc: {
		fields: [
			{ key: "mode", type: "string" },
			{ key: "amount", type: "number" },
		],
		defaults: { mode: "post", amount: 1760 },
	},
	ticker: {
		fields: [
			{ key: "label", type: "string" },
			{ key: "value", type: "string" },
			{ key: "delta", type: "number" },
		],
		defaults: {
			label: "EUR / CNY",
			value: "7.7945",
			delta: 0.0046,
			spark: [7.7, 7.72, 7.69, 7.74, 7.76, 7.75, 7.79, 7.78, 7.8],
		},
	},
	metric: {
		fields: [
			{ key: "label", type: "string" },
			{ key: "value", type: "number" },
			{ key: "delta", type: "number" },
		],
		defaults: { label: "metric", value: 4200, delta: 0.12, history: [3, 4, 3.5, 5, 4.5, 6, 5.5, 7, 6.5, 8, 7.5, 9] },
	},
	todo: { fields: [{ key: "items", type: "array" }], defaults: { items: [] } },
	pomodoro: {
		fields: [
			{ key: "mode", type: "string" },
			{ key: "rounds", type: "number" },
		],
		defaults: { mode: "focus", rounds: 0, minutes: 0, day: "" },
	},
	video: {
		fields: [{ key: "url", type: "string" }],
		defaults: { url: "", bvid: "BV1vT411d7QE", title: "凡人修仙传", subtitle: "BILIBILI · 年番" },
	},
	gallery: {
		fields: [{ key: "items", type: "array" }],
		defaults: {
			items: [
				{ title: "MusePi 桌面" },
				{ title: "MusePi 看板" },
				{ title: "MusePi 桌宠" },
				{ title: "MusePi 引导" },
			],
		},
	},
	gauge: {
		fields: [
			{ key: "value", type: "number" },
			{ key: "status", type: "string" },
		],
		defaults: { label: "A股市场温度", value: 70, status: "活跃 · 沪深创" },
	},
	kline: {
		fields: [{ key: "candles", type: "array" }],
		defaults: {
			symbol: "腾讯控股",
			price: 478.8,
			delta: -0.08,
			candles: [],
			stocks: ["腾讯控股", "阿里巴巴", "贵州茅台", "宁德时代"],
		},
	},
	heatwall: {
		fields: [{ key: "tiles", type: "array" }],
		defaults: {
			tiles: [
				{ name: "工商银行", delta: -0.53 },
				{ name: "中国石油", delta: 0.84 },
				{ name: "宁德时代", delta: 0.02 },
				{ name: "贵州茅台", delta: 0.05 },
				{ name: "中芯国际", delta: 3.5 },
				{ name: "招商银行", delta: -0.44 },
				{ name: "中国平安", delta: -0.22 },
				{ name: "紫金矿业", delta: 1.88 },
				{ name: "比亚迪", delta: 0.66 },
				{ name: "长江电力", delta: 0 },
				{ name: "美的集团", delta: -2.13 },
				{ name: "中国石化", delta: 0.39 },
				{ name: "立讯精密", delta: 0.1 },
				{ name: "中信证券", delta: 0.2 },
				{ name: "兴业银行", delta: -0.12 },
				{ name: "恒瑞医药", delta: 0.05 },
				{ name: "京东方A", delta: 1.84 },
				{ name: "平安银行", delta: 0.08 },
			],
		},
	},
	indextape: {
		fields: [{ key: "indices", type: "array" }],
		defaults: {
			indices: ["上证", "深证", "恒生"],
			value: 3940.84,
			delta: 1.02,
			series: [3800, 3850, 3830, 3900, 3920, 3880, 3940, 3930, 3955, 3940],
		},
	},
	html: {
		fields: [
			{ key: "html", type: "string" },
			{ key: "data", type: "object" },
		],
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
/**
 * A rendered page's HTML travels in the tool call's input, which the daemon
 * stores with the message and streams to every client. Shared with the
 * renderer so the two cannot drift: a page over it renders as an "oversize"
 * notice instead of a face, so accepting more here would only defer the
 * failure to the client. Everything else a page needs — the null-origin
 * sandbox, `musepiSubmit` answer handback, theme injection, `.musepi-options`
 * styling, height reporting — is the existing `html` widget's, which is why
 * `page` is an action of this tool rather than a second implementation.
 */
const MAX_PAGE_HTML = MAX_WIDGET_HTML;
/** A page's title is a heading, not a sentence. */
const MAX_PAGE_TITLE = 120;

/**
 * When a page beats prose, and when it does not.
 *
 * Both the tool description and the line every session carries state it.
 * Stated only in the tool description it went unread: asked for a breakdown of
 * lines of code per package, an agent answered with a list and drew the chart
 * only when asked. Interface mockups are named on their own — listed only as
 * data, the cases read to a literal model as "charts only", while a proposed
 * UI change is where a page helps most. The limits matter as much as the
 * cases: a page for two numbers is worse than a sentence.
 */
export const RENDER_PAGE_WHEN =
	"Use it when the answer is mostly data or structure the user would otherwise have to picture:" +
	" numbers compared across several items (sizes, counts, timings, costs, test or benchmark results)," +
	" a breakdown or share of a whole, a trend over time, options compared on several criteria," +
	" a timeline of events, or how components connect." +
	" Use it too when the answer is about how something looks: a proposed interface change shown as it would appear," +
	" before and after side by side, or layout options to choose between." +
	" Do not use it for a few numbers or a short list that reads fine as text, for code, or when the user asked for plain text." +
	" At most one page per answer.";

/**
 * Local image paths a page names, in order, at most 12.
 *
 * A sandboxed page cannot read the filesystem, so the chat swaps each path for
 * the file's contents before drawing it. Matches both a quoted src/CSS value
 * (which may contain spaces — macOS screenshots do) and an unquoted url(...).
 */
const LOCAL_IMAGE_RE =
	/(["'`])((?:file:\/\/|\/(?!\/)|[A-Za-z]:[\\/])[^"'`<>\n]*?\.(?:png|jpe?g|gif|webp))\1|url\(\s*((?:file:\/\/|\/(?!\/)|[A-Za-z]:[\\/])[^"'`<>()\s]*?\.(?:png|jpe?g|gif|webp))\s*\)/gi;
export const RENDER_PAGE_MAX_LOCAL_IMAGES = 12;

export function renderPageImageSources(html: string): string[] {
	const sources = new Set<string>();
	for (const match of html.matchAll(LOCAL_IMAGE_RE)) {
		sources.add(match[2] ?? match[3] ?? "");
		if (sources.size === RENDER_PAGE_MAX_LOCAL_IMAGES) break;
	}
	return [...sources];
}

const widgetSchema = type({
	"action?": type('"card" | "page"').describe(
		'What to render: "card" (a structured widget type — the default) or "page" (one self-contained HTML page shown inline in the chat)',
	),
	"type?": type("string").describe(`Widget type (action=card): ${Object.keys(WIDGET_TYPES).join(" / ")}`),
	"data?": type("object").describe("Widget data fields per type (defaults fill the rest)"),
	"title?": type("string").describe("Optional card title (defaults to the widget name)"),
	"html?": type("string").describe("The page's HTML, complete document with inline CSS (action=page)"),
});

export interface WidgetToolDetails {
	/** `card` = a structured widget type; `page` = one free HTML page. */
	action: "card" | "page";
	type: string;
	data: Record<string, unknown>;
	title?: string;
	/** The page's HTML (action=page only). */
	html?: string;
	/** Local image paths the page names; the chat swaps them for file contents
	 *  (a sandboxed page cannot read the filesystem itself). */
	images?: string[];
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
			call: { action: "card", type: "calc", data: { mode: "post", amount: 1760 } },
		},
		{
			caption: "Render a ticker quote",
			call: { action: "card", type: "ticker", data: { label: "EUR / CNY", value: "7.7945", delta: 0.0046 } },
		},
		{
			caption: "Render a comparison page with a choice",
			call: {
				action: "page",
				title: "Compare two plans",
				html: "<!doctype html><html><body><h1>Compare two plans</h1><button onclick=\"window.musepiSubmit('Plan A',{plan:'a'})\">Pick A</button></body></html>",
			},
		},
	];

	async execute(
		_toolCallId: string,
		params: typeof widgetSchema.infer,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<WidgetToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<WidgetToolDetails>> {
		const action = params.action === "page" ? "page" : "card";

		if (action === "page") {
			const html = typeof params.html === "string" ? params.html : "";
			if (!html.trim()) {
				return {
					content: [{ type: "text", text: "widget (page): html is required and must not be empty" }],
					isError: true,
				};
			}
			if (html.length > MAX_PAGE_HTML) {
				return {
					content: [
						{
							type: "text",
							text: `widget (page): html exceeds ${MAX_PAGE_HTML} characters — trim styles, comments and inline scripts`,
						},
					],
					isError: true,
				};
			}
			const title = typeof params.title === "string" ? params.title.trim() : "";
			if (title.length > MAX_PAGE_TITLE) {
				return {
					content: [{ type: "text", text: `widget (page): title exceeds ${MAX_PAGE_TITLE} characters` }],
					isError: true,
				};
			}
			const details: WidgetToolDetails = {
				action,
				// A page IS the `html` widget's face: same sandbox, same
				// `musepiSubmit` handback, same theme tokens. Reusing the type is
				// what keeps one implementation instead of two.
				type: "html",
				data: { html },
				html,
				images: renderPageImageSources(html),
			};
			if (title) details.title = title;
			return {
				content: [
					{
						type: "text",
						text:
							`Rendered page${title ? ` "${title}"` : ""} (${html.length} characters). ` +
							"Shown to the user in the chat above your reply. Don't announce, describe or restate the page; reply with only what it doesn't already say." +
							(details.images?.length
								? ` The page references ${details.images.length} local image(s), which the chat inlines for it.`
								: ""),
					},
				],
				details,
			};
		}

		const typeName = typeof params.type === "string" ? params.type : "";
		const spec = WIDGET_TYPES[typeName];
		if (!spec) {
			return {
				content: [
					{
						type: "text",
						text: `widget: unknown type "${typeName}" — available: ${Object.keys(WIDGET_TYPES).join(", ")}`,
					},
				],
				isError: true,
			};
		}
		const rawData =
			params.data !== undefined && typeof params.data === "object" && params.data !== null
				? (params.data as Record<string, unknown>)
				: {};
		if (rawData && JSON.stringify(rawData).length > MAX_DATA_JSON) {
			return {
				content: [
					{ type: "text", text: `widget: data payload exceeds ${MAX_DATA_JSON} bytes — trim the data fields` },
				],
				isError: true,
			};
		}
		const details: WidgetToolDetails = { action: "card", type: typeName, data: { ...spec.defaults, ...rawData } };
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
