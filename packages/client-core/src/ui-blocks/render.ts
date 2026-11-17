/**
 * Declarative UI blocks for assistant replies.
 *
 * An assistant reply may carry a ```` ```ui ```` fence written in OpenUI Lang
 * (`root = Stack([...])`), parsed by `./catalog`. This module turns the parsed
 * tree into HTML for the markdown pipeline, which emits one HTML string per
 * message — the same constraint mermaid works under, and the reason the catalog
 * is display-only.
 *
 * Blocks are the middle of MusePi's three answer surfaces: data and structure
 * here, a canned interactive face in `widget` cards, free-form HTML in a
 * `widget` page.
 */

import { t } from "../i18n/index.js";
import { rememberBlockFailure } from "./answers.js";
import { parseUiBlock, type UiBlockTree } from "./catalog.js";
import { uiBlockIcon } from "./icons.js";

const TONES = ["neutral", "info", "success", "warning", "error"] as const;
type Tone = (typeof TONES)[number];

/** Fence languages that render as a block. `openui`/`openui-lang` are what
 *  models reach for by habit; all of them draw the same thing. */
export const UI_BLOCK_LANGUAGES = ["ui", "musepi-ui", "openui", "openui-lang"] as const;

export function isUiBlockLanguage(lang: string | undefined): boolean {
	const l = (lang ?? "").trim().toLowerCase();
	return (UI_BLOCK_LANGUAGES as readonly string[]).includes(l);
}

export interface UiBlockRender {
	html: string;
	/** Rendered node count; 0 means the fence showed nothing. */
	nodes: number;
	/** Reasons the block could not draw as written; empty when it drew whole. */
	errors: string[];
}

function esc(value: unknown): string {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function tone(value: unknown): Tone {
	return TONES.includes(value as Tone) ? (value as Tone) : "neutral";
}

/** Inline formatting for `Text`/`Callout`: bold and code only. */
function inline(text: string): string {
	return esc(text)
		.replace(/`([^`]+)`/g, '<code class="tr-ui-code">$1</code>')
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function paragraphs(text: string): string {
	return text
		.split(/\n{2,}/)
		.map(block => `<p>${inline(block.trim()).replace(/\n/g, "<br>")}</p>`)
		.join("");
}

function str(props: Record<string, unknown>, key: string): string {
	const value = props[key];
	return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function num(props: Record<string, unknown>, key: string): number | undefined {
	const value = props[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function list<T>(props: Record<string, unknown>, key: string): T[] {
	const value = props[key];
	return Array.isArray(value) ? (value as T[]) : [];
}

function kids(node: UiBlockTree, ctx: RenderContext = {}): string {
	return node.children
		.map(child => renderNode(child, ctx))
		.filter(Boolean)
		.join("");
}

/**
 * A chart's series. The parser hands back element nodes (`{typeName, props}`);
 * a bare `{name, values}` is accepted too, because both mean one thing and the
 * difference is not an error the user should have to read about.
 */
function seriesOf(props: Record<string, unknown>): { name: string; values: (number | null)[] }[] {
	return list<unknown>(props, "series")
		.map(item => {
			if (typeof item !== "object" || item === null) return null;
			const record = item as Record<string, unknown>;
			const source = "typeName" in record ? ((record.props ?? {}) as Record<string, unknown>) : record;
			const values = list<unknown>(source, "values").map(value =>
				typeof value === "number" && Number.isFinite(value) ? value : null,
			);
			return { name: typeof source.name === "string" ? source.name : "", values };
		})
		.filter((item): item is { name: string; values: (number | null)[] } => item !== null && item.values.length > 0);
}

function unitOf(props: Record<string, unknown>): string {
	const unit = str(props, "unit");
	return unit ? ` ${unit}` : "";
}

function barChart(props: Record<string, unknown>): string {
	const labels = list<unknown>(props, "labels").map(String);
	const series = seriesOf(props);
	if (labels.length === 0 || series.length === 0) return "";
	const values = series[0]?.values ?? [];
	const max = Math.max(1, ...values.map(value => value ?? 0));
	const whole = props.whole === true;
	const unit = unitOf(props);
	const total = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
	const rows = labels
		.map((label, index) => {
			const value = values[index];
			if (value === null || value === undefined) return "";
			const share = whole && total > 0 ? Math.round((value / total) * 100) : null;
			return (
				`<div class="tr-ui-bar-row">` +
				`<span class="tr-ui-bar-label">${esc(label)}</span>` +
				`<span class="tr-ui-bar-value">${esc(value)}${esc(unit)}${share === null ? "" : `<span class="tr-ui-bar-share">${share}%</span>`}</span>` +
				`<span class="tr-ui-bar"><span class="tr-ui-bar-fill" style="width:${Math.round((value / max) * 100)}%"></span></span>` +
				`</div>`
			);
		})
		.join("");
	const name = series.length === 1 ? series[0]?.name : undefined;
	const totalLine =
		whole && total > 0
			? `<p class="tr-ui-chart-total">${esc(t("transcript.uiBlockTotal", { value: String(total) }))}${esc(unit)}${name ? ` · ${esc(name)}` : ""}</p>`
			: "";
	return `<figure class="tr-ui-chart">${rows}${totalLine}</figure>`;
}

function lineChart(props: Record<string, unknown>): string {
	const labels = list<unknown>(props, "labels").map(String);
	const series = seriesOf(props);
	const flat = series.flatMap(item => item.values.filter((value): value is number => value !== null));
	if (labels.length < 2 || flat.length === 0) return "";
	const width = 320;
	const height = 96;
	const min = Math.min(...flat);
	const max = Math.max(...flat);
	const span = max - min || 1;
	const unit = unitOf(props);
	const pointFor = (value: number, index: number, count: number): string => {
		const x = count <= 1 ? 0 : (index / (count - 1)) * width;
		const y = height - ((value - min) / span) * (height - 8) - 4;
		return `${x.toFixed(1)},${y.toFixed(1)}`;
	};
	const lines = series
		.map((item, seriesIndex) => {
			const points = item.values
				.map((value, index) => (value === null ? null : pointFor(value, index, item.values.length)))
				.filter((point): point is string => point !== null);
			if (points.length === 0) return "";
			const stroke = `var(--chart-${(seriesIndex % 5) + 1})`;
			return `<polyline class="tr-ui-line" points="${points.join(" ")}" fill="none" stroke="${stroke}" stroke-width="1.75" vector-effect="non-scaling-stroke"></polyline>`;
		})
		.join("");
	const axis = `<span class="tr-ui-chart-axes"><span class="tr-ui-chart-axis">${esc(labels[0] ?? "")}</span><span class="tr-ui-chart-axis">${esc(labels.at(-1) ?? "")}</span></span>`;
	const legend =
		series.length > 1
			? `<span class="tr-ui-chart-legend">${series
					.map(
						(item, index) =>
							`<span class="tr-ui-chart-key"><span class="tr-ui-dot" style="background:var(--chart-${(index % 5) + 1})"></span>${esc(item.name)}</span>`,
					)
					.join("")}</span>`
			: "";
	return (
		`<figure class="tr-ui-chart tr-ui-chart--line">` +
		`<span class="tr-ui-chart-rangecol"><span class="tr-ui-chart-range">${esc(max)}${esc(unit)}</span><span class="tr-ui-chart-range">${esc(min)}${esc(unit)}</span></span>` +
		`<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${esc(series.map(item => item.name).join(", "))}">${lines}</svg>` +
		`<div class="tr-ui-chart-foot">${axis}${legend}</div>` +
		`</figure>`
	);
}

function steps(props: Record<string, unknown>): string {
	const items = list<unknown>(props, "items").filter(item => typeof item === "object" && item !== null);
	if (items.length === 0) return "";
	const direction = props.direction === "row" ? "row" : "column";
	const html = items
		.map(raw => {
			const item = raw as Record<string, unknown>;
			const status = ["done", "current", "todo", "blocked"].includes(String(item.status))
				? String(item.status)
				: "todo";
			const note =
				typeof item.markdown === "string" && item.markdown
					? `<span class="tr-ui-step-note">${inline(item.markdown)}</span>`
					: "";
			return `<li class="tr-ui-step" data-status="${status}"><span class="tr-ui-step-mark" aria-hidden></span><span class="tr-ui-step-body"><span class="tr-ui-step-title">${esc(item.title ?? "")}</span>${note}</span></li>`;
		})
		.join("");
	return `<ol class="tr-ui-steps" data-direction="${direction}">${html}</ol>`;
}

/**
 * A column reads as numeric only when every filled cell is a number. Decided
 * per column rather than per cell: a column that alternates `12` and `n/a`
 * must not zigzag its alignment down the table.
 */
function numericColumn(rows: readonly unknown[][], index: number): boolean {
	let seen = false;
	for (const row of rows) {
		const cell = row[index];
		if (cell === undefined || cell === null || cell === "") continue;
		seen = true;
		if (typeof cell !== "number" && !Number.isFinite(Number(cell))) return false;
	}
	return seen;
}

function table(props: Record<string, unknown>): string {
	const columns = list<unknown>(props, "columns").map(String);
	const rows = list<unknown>(props, "rows").filter(Array.isArray) as unknown[][];
	if (columns.length === 0) return "";
	// Numbers line up on their right edge, so a column of amounts is scannable;
	// the alignment is announced in the markup rather than left to CSS, because
	// only the renderer knows which cells are numbers.
	const align = columns.map((_column, index) => (numericColumn(rows, index) ? "right" : "left"));
	const cell = (index: number, content: string): string =>
		align[index] === "right" ? `<td data-align="right">${content}</td>` : `<td>${content}</td>`;
	const head = columns
		.map((column, index) =>
			align[index] === "right" ? `<th data-align="right">${inline(column)}</th>` : `<th>${inline(column)}</th>`,
		)
		.join("");
	const body = rows
		.map(row => `<tr>${columns.map((_column, index) => cell(index, inline(String(row[index] ?? "")))).join("")}</tr>`)
		.join("");
	return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function keyValue(props: Record<string, unknown>): string {
	const items = list<unknown>(props, "items").filter(item => typeof item === "object" && item !== null);
	if (items.length === 0) return "";
	// A dotted leader joins each label to its value, so the eye follows one row
	// across a wide reply instead of landing in the gap; the value wraps inside
	// its own column rather than widening the row.
	return `<dl class="tr-ui-kv">${items
		.map(raw => {
			const item = raw as Record<string, unknown>;
			return (
				`<div class="tr-ui-kv-row">` +
				`<dt>${inline(String(item.label ?? ""))}<span class="tr-ui-kv-leader" aria-hidden="true"></span></dt>` +
				`<dd>${inline(String(item.value ?? ""))}</dd>` +
				`</div>`
			);
		})
		.join("")}</dl>`;
}

function badge(props: Record<string, unknown>): string {
	return `<span class="tr-ui-badge" data-tone="${tone(props.tone)}">${inline(str(props, "label"))}</span>`;
}

function callout(props: Record<string, unknown>): string {
	const title = str(props, "title");
	return `<aside class="tr-ui-callout" data-tone="${tone(props.tone)}">${title ? `<strong class="tr-ui-callout-title">${inline(title)}</strong>` : ""}${paragraphs(str(props, "markdown"))}</aside>`;
}

function stat(props: Record<string, unknown>): string {
	const delta = str(props, "delta");
	return (
		`<div class="tr-ui-stat">` +
		`<span class="tr-ui-stat-label">${esc(str(props, "label"))}</span>` +
		`<strong class="tr-ui-stat-value">${esc(props.value ?? "")}</strong>` +
		(delta ? `<span class="tr-ui-badge" data-tone="${tone(props.tone)}">${esc(delta)}</span>` : "") +
		`</div>`
	);
}

/**
 * One value against a max.
 *
 * Three rules the bar alone cannot carry: the percentage never reads 100
 * before the work is done (29 of 40 must not round up to 100), the count is
 * spelled out whenever the max is not 100 (a bare "73%" of an unknown total
 * says nothing), and a finished bar turns success-green so a list of bars shows
 * which ones are closed.
 */
function progress(props: Record<string, unknown>): string {
	const value = num(props, "value") ?? 0;
	const max = num(props, "max") ?? 100;
	const share = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
	const done = share >= 1;
	// Multiply first, then divide: `(29 / 100) * 100` lands on 28.999… and floor
	// would print 28 for a round number.
	const percent = done ? 100 : Math.max(0, Math.min(99, Math.floor((value * 100) / (max || 1))));
	const count =
		max !== 100 ? `<span class="tr-ui-progress-count">${esc(String(value))} / ${esc(String(max))}</span>` : "";
	return (
		`<div class="tr-ui-progress"${done ? ' data-done="true"' : ""} role="progressbar" aria-valuenow="${esc(String(value))}" aria-valuemin="0" aria-valuemax="${esc(String(max))}" aria-label="${esc(str(props, "label"))}">` +
		`<span class="tr-ui-progress-label">${esc(str(props, "label"))}</span>` +
		`<span class="tr-ui-progress-value">${done ? '<span class="tr-ui-progress-tick" aria-hidden="true">✓</span>' : ""}${percent}%${count}</span>` +
		`<span class="tr-ui-progress-track"><span class="tr-ui-progress-fill" style="width:${(share * 100).toFixed(2)}%"></span></span>` +
		`</div>`
	);
}

function listBlock(props: Record<string, unknown>): string {
	const items = list<unknown>(props, "items")
		.map(item => String(item ?? ""))
		.filter(item => item !== "");
	if (items.length === 0) return "";
	const ordered = props.ordered === true;
	const tag = ordered ? "ol" : "ul";
	const body = items.map(item => `<li>${inline(item)}</li>`).join("");
	return `<${tag} class="tr-ui-list" data-ordered="${ordered ? "true" : "false"}">${body}</${tag}>`;
}

function quote(props: Record<string, unknown>): string {
	const body = paragraphs(str(props, "markdown"));
	if (!body) return "";
	const source = str(props, "source");
	return `<blockquote class="tr-ui-quote">${body}${source ? `<cite class="tr-ui-quote-source">${inline(source)}</cite>` : ""}</blockquote>`;
}

/** Only http(s) and mailto survive: a block is model-authored, so `javascript:`
 *  or a `data:` page must never become a clickable target. */
function safeHref(value: string): string {
	const href = value.trim();
	return /^(https?:|mailto:)/i.test(href) ? href : "";
}

function linkBlock(props: Record<string, unknown>): string {
	const href = safeHref(str(props, "href"));
	const label = str(props, "label") || href;
	if (!href) return `<span class="tr-ui-link tr-ui-link--blocked">${inline(label)}</span>`;
	const description = str(props, "description");
	const message = str(props, "message").trim();
	const body =
		`<span class="tr-ui-link-label">${inline(label)}</span>` +
		(description ? `<span class="tr-ui-link-note">${inline(description)}</span>` : "");
	// A link that also asks something is one gesture: open the page AND tell the
	// assistant, so the user is not made to copy the URL back into the composer.
	// It sends immediately — a navigation is not a pending decision to batch up.
	if (message) {
		return (
			`<button type="button" class="tr-ui-link tr-ui-link--send" data-ui-link-send data-ui-href="${esc(href)}" data-ui-message="${esc(message)}">` +
			body +
			`<span class="tr-ui-link-send-mark" aria-hidden="true">↗</span>` +
			`</button>`
		);
	}
	return `<a class="tr-ui-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${body}</a>`;
}

function iconBlock(props: Record<string, unknown>): string {
	const node = uiBlockIcon(str(props, "name"));
	if (!node) return "";
	const label = str(props, "label");
	const body = node
		.map(([tag, attrs]) => {
			const written = Object.entries(attrs ?? {})
				.map(([key, value]) => `${esc(key)}="${esc(value)}"`)
				.join(" ");
			return `<${tag}${written ? ` ${written}` : ""}/>`;
		})
		.join("");
	// No name means decoration: the surrounding label carries the meaning.
	const a11y = label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"';
	return `<svg class="tr-ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${a11y}>${body}</svg>`;
}

function divider(props: Record<string, unknown>): string {
	const label = str(props, "label");
	return label
		? `<div class="tr-ui-divider" role="separator"><span>${inline(label)}</span></div>`
		: `<hr class="tr-ui-divider" aria-hidden="true">`;
}

function codeBlock(props: Record<string, unknown>): string {
	const code = str(props, "code");
	if (!code.trim()) return "";
	const language = str(props, "language");
	const title = str(props, "title");
	return (
		`<figure class="tr-ui-code-block">` +
		(title || language
			? `<figcaption class="tr-ui-code-head">${title ? `<span class="tr-ui-code-title">${inline(title)}</span>` : ""}${language ? `<span class="tr-ui-code-lang">${esc(language)}</span>` : ""}</figcaption>`
			: "") +
		`<pre><code>${esc(code)}</code></pre></figure>`
	);
}

function details(node: UiBlockTree, ctx: RenderContext): string {
	const body = kids(node, ctx);
	if (!body) return "";
	return `<details class="tr-ui-details"><summary>${inline(str(node.props, "title"))}</summary>${body}</details>`;
}

/**
 * One page at a time, switched by delegated clicks rather than by script.
 *
 * A block is an HTML string the transcript regenerates on every commit, so the
 * open page cannot live in the DOM alone; each page carries its label, the
 * store keeps which label is open, and `applyAnswers` re-opens it after a
 * redraw. Only the pages are hidden — the tab strip always shows every label,
 * so the reader still sees what else is there.
 */
function tabs(node: UiBlockTree, ctx: RenderContext): string {
	const pages = node.children.filter(child => child.type === "Tab");
	if (pages.length === 0) return "";
	// The group is keyed by its labels: two Tabs groups on one block must not
	// share an open page, and the key has to survive a re-render unchanged.
	const group = pages.map(page => str(page.props, "label")).join("\u0001");
	const buttons: string[] = [];
	const panels: string[] = [];
	let first = "";
	for (const [index, page] of pages.entries()) {
		const label = str(page.props, "label") || `#${index + 1}`;
		if (!first) first = label;
		buttons.push(
			`<button type="button" class="tr-ui-tab" role="tab" data-ui-tab="${esc(group)}" data-ui-tab-page="${esc(label)}" aria-selected="${index === 0 ? "true" : "false"}" tabindex="${index === 0 ? "0" : "-1"}">${inline(label)}</button>`,
		);
		const body = kids(page, ctx);
		// The first page is open in the markup itself: a redraw must not flash an
		// empty frame between the HTML arriving and `applyAnswers` running.
		const isFirst = index === 0;
		panels.push(
			`<div class="tr-ui-tab-panel" role="tabpanel" data-ui-tab-page="${esc(label)}" data-open="${isFirst ? "true" : "false"}"${isFirst ? "" : " hidden"}>${body}</div>`,
		);
	}
	// `data-ui-open` names the page that reads as open before any click, so the
	// first draw matches the store instead of flashing an empty frame.
	return (
		`<div class="tr-ui-tabs" data-ui-tabs="${esc(group)}" data-ui-open="${esc(first)}">` +
		`<div class="tr-ui-tab-strip" role="tablist">${buttons.join("")}</div>` +
		panels.join("") +
		`</div>`
	);
}

/** Whether this subtree contains a control that answers a decision. */
function hasDecisions(node: UiBlockTree): boolean {
	if (node.type === "Choice" || node.type === "Button" || node.type === "Slider" || node.type === "DateInput")
		return true;
	return node.children.some(hasDecisions);
}

/** Per-type rendering. A type absent here draws nothing and is named in the note. */
const RENDERERS: Record<string, (node: UiBlockTree, ctx: RenderContext) => string> = {
	Stack: (node, ctx) => (kids(node, ctx) ? `<div class="tr-ui-stack">${kids(node, ctx)}</div>` : ""),
	Row: (node, ctx) => (kids(node, ctx) ? `<div class="tr-ui-row">${kids(node, ctx)}</div>` : ""),
	// Equal columns, capped at what still reads on a narrow reply: a grid of
	// six tiles on a phone is two tiles per line, not six 40px slivers.
	Grid: (node, ctx) => {
		const body = kids(node, ctx);
		if (!body) return "";
		const columns = Math.max(1, Math.min(4, Math.round(num(node.props, "columns") ?? 2)));
		return `<div class="tr-ui-grid" style="--tr-ui-grid-columns:${columns}">${body}</div>`;
	},
	// A titled card with nothing under it is still worth drawing: the title is
	// content. An untitled empty one is not.
	Card: (node, ctx) => {
		const title = str(node.props, "title");
		// A card of buttons is one decision, and its title names that decision.
		const body = kids(node, { ...ctx, card: title || ctx.card });
		if (!body && !title) return "";
		// A card that asks for a decision also accepts a condition on it: the
		// user picks the closest option and adds "with a regression test" to THAT
		// card, instead of one note that would attach to every card at once.
		const note =
			title && hasDecisions(node)
				? `<input class="tr-ui-input tr-ui-card-note" type="text" data-ui-name="card-note:${esc(title)}" data-ui-kind="card-note" data-ui-card="${esc(title)}" placeholder="${esc(t("transcript.uiBlockCardNote"))}">`
				: "";
		return `<section class="tr-ui-card"><h4 class="tr-ui-card-title">${inline(title)}</h4>${body}${note}</section>`;
	},
	Text: node => `<div class="tr-ui-text">${paragraphs(str(node.props, "markdown"))}</div>`,
	Badge: node => badge(node.props),
	Callout: node => callout(node.props),
	KeyValue: node => keyValue(node.props),
	Table: node => table(node.props),
	Steps: node => steps(node.props),
	Stat: node => stat(node.props),
	Progress: node => progress(node.props),
	BarChart: node => barChart(node.props),
	LineChart: node => lineChart(node.props),
	List: node => listBlock(node.props),
	Quote: node => quote(node.props),
	Link: node => linkBlock(node.props),
	Icon: node => iconBlock(node.props),
	Divider: node => divider(node.props),
	Code: node => codeBlock(node.props),
	Details: (node, ctx) => details(node, ctx),
	Tabs: (node, ctx) => tabs(node, ctx),
	Tab: () => "",
	Choice: (node, ctx) => choice(node, ctx),
	Input: (node, ctx) => input(node, ctx),
	DateInput: (node, ctx) => dateInput(node, ctx),
	Slider: (node, ctx) => slider(node, ctx),
	Button: (node, ctx) => button(node, ctx),
};

/** Stable per-block identity: answers and the DOM are keyed by it. */
function hashOf(source: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < source.length; index += 1) {
		hash ^= source.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36);
}

/** Where a control's answer lands: the card's title when it sits in one, so a
 *  card of buttons is ONE decision (four buttons, not four answers). */
interface RenderContext {
	card?: string;
}

function decisionOf(props: Record<string, unknown>, ctx: RenderContext, fallback: string): string {
	return ctx.card || str(props, "label") || fallback;
}

function fieldName(props: Record<string, unknown>, ctx: RenderContext): string {
	return ctx.card ? `card:${ctx.card}` : `field:${str(props, "name")}`;
}

/** A button outside a card is its own decision, so two buttons must not share
 *  one answer slot: `name` keys it, and a button left without one falls back to
 *  its own label rather than collapsing every button into the same `field:`. */
function buttonName(props: Record<string, unknown>, ctx: RenderContext): string {
	if (ctx.card) return `card:${ctx.card}`;
	return `${fieldName(props, ctx)}:${str(props, "value") || str(props, "label")}`;
}

function choice(node: UiBlockTree, ctx: RenderContext): string {
	const props = node.props;
	const name = fieldName(props, ctx);
	const decision = decisionOf(props, ctx, str(props, "name"));
	const label = str(props, "label");
	const multiple = props.multiple === true;
	const options = list<unknown>(props, "options")
		.map(option => {
			if (typeof option === "string") return { label: option, description: "" };
			if (typeof option !== "object" || option === null) return null;
			const record = option as Record<string, unknown>;
			return { label: str(record, "label"), description: str(record, "description") };
		})
		.filter((option): option is { label: string; description: string } => option !== null);
	if (options.length === 0) return "";
	const rows = options
		.map(
			option =>
				`<button type="button" class="tr-ui-option" data-ui-choice data-ui-name="${esc(name)}" data-ui-value="${esc(option.label)}" data-ui-decision="${esc(decision)}" data-ui-kind="${multiple ? "checkbox" : "radio"}" aria-pressed="false">` +
				`<span class="tr-ui-option-mark" aria-hidden></span>` +
				`<span class="tr-ui-option-body"><span class="tr-ui-option-label">${esc(option.label)}</span>${option.description ? `<span class="tr-ui-option-note">${inline(option.description)}</span>` : ""}</span>` +
				`</button>`,
		)
		.join("");
	// A row of pills is the same answers drawn compactly: two or three short
	// words are one glance, while three stacked rows would cost three lines of
	// reply. A description needs its own line, so it rules the row out.
	const shape = props.layout === "row" && !options.some(option => option.description) ? "row" : "list";
	return `<fieldset class="tr-ui-choice" data-ui-multiple="${multiple ? "true" : "false"}" data-layout="${shape}">${label ? `<legend class="tr-ui-choice-label">${inline(label)}</legend>` : ""}${rows}</fieldset>`;
}

function input(node: UiBlockTree, ctx: RenderContext): string {
	const props = node.props;
	const name = fieldName(props, ctx);
	const decision = decisionOf(props, ctx, str(props, "name"));
	const label = str(props, "label");
	const placeholder = str(props, "placeholder");
	const multiline = props.multiline === true;
	const attrs = `data-ui-name="${esc(name)}" data-ui-kind="input" data-ui-decision="${esc(decision)}" placeholder="${esc(placeholder)}"`;
	const field = multiline
		? `<textarea class="tr-ui-input" rows="3" ${attrs}></textarea>`
		: `<input class="tr-ui-input" type="text" ${attrs}>`;
	return `<label class="tr-ui-field">${label ? `<span class="tr-ui-field-label">${inline(label)}</span>` : ""}${field}</label>`;
}

function dateInput(node: UiBlockTree, ctx: RenderContext): string {
	const props = node.props;
	const name = fieldName(props, ctx);
	const decision = decisionOf(props, ctx, str(props, "name"));
	const label = str(props, "label");
	const withTime = props.time === true;
	const value = str(props, "value");
	const kind = withTime ? "datetime-local" : "date";
	return (
		`<label class="tr-ui-field">${label ? `<span class="tr-ui-field-label">${inline(label)}</span>` : ""}` +
		`<input class="tr-ui-input" type="${kind}" value="${esc(value)}" data-ui-name="${esc(name)}" data-ui-kind="input" data-ui-decision="${esc(decision)}">` +
		`</label>`
	);
}

function slider(node: UiBlockTree, ctx: RenderContext): string {
	const props = node.props;
	const name = fieldName(props, ctx);
	const decision = decisionOf(props, ctx, str(props, "name"));
	const label = str(props, "label");
	const unit = str(props, "unit");
	const min = num(props, "min") ?? 0;
	const max = num(props, "max") ?? 100;
	const step = num(props, "step") ?? 1;
	const value = num(props, "value") ?? min;
	return (
		`<label class="tr-ui-field">` +
		`<span class="tr-ui-field-label">${inline(label)}<span class="tr-ui-field-readout" data-ui-readout>${esc(value)}${esc(unit ? ` ${unit}` : "")}</span></span>` +
		`<input class="tr-ui-range" type="range" min="${min}" max="${max}" step="${step}" value="${value}"` +
		` data-ui-name="${esc(name)}" data-ui-kind="range" data-ui-decision="${esc(decision)}" data-ui-unit="${esc(unit)}">` +
		`</label>`
	);
}

function button(node: UiBlockTree, ctx: RenderContext): string {
	const props = node.props;
	const name = buttonName(props, ctx);
	const decision = decisionOf(props, ctx, str(props, "label"));
	const value = str(props, "value") || str(props, "label");
	const variant = props.variant === "primary" ? "primary" : "secondary";
	return `<button type="button" class="tr-ui-button" data-variant="${variant}" data-ui-choice data-ui-name="${esc(name)}" data-ui-value="${esc(value)}" data-ui-decision="${esc(decision)}" data-ui-kind="action" aria-pressed="false">${inline(str(props, "label"))}</button>`;
}

/** The note field and the send button a block with answers carries. */
function answerBar(source: string): string {
	const hash = hashOf(source);
	return (
		`<div class="tr-ui-answerbar" data-ui-hash="${esc(hash)}">` +
		`<input class="tr-ui-input tr-ui-note" type="text" data-ui-name="note" data-ui-kind="note" placeholder="${esc(t("transcript.uiBlockNote"))}">` +
		`<button type="button" class="tr-ui-send" data-ui-send>${esc(t("transcript.uiBlockSend"))}</button>` +
		`</div>`
	);
}

function hasAnswers(node: UiBlockTree): boolean {
	if (["Choice", "Input", "Button", "DateInput", "Slider"].includes(node.type)) return true;
	return node.children.some(hasAnswers);
}

/**
 * A node that drew nothing (an empty container, a chart missing its data)
 * returns nothing, so "did this block show anything?" is a question about the
 * output rather than about the tree.
 */
function renderNode(node: UiBlockTree, ctx: RenderContext = {}): string {
	// `Series` is a chart input, not a display node.
	if (node.type === "Series") return "";
	const renderer = RENDERERS[node.type];
	return renderer ? renderer(node, ctx) : "";
}

function countNodes(node: UiBlockTree): number {
	if (node.type === "Series" || !RENDERERS[node.type]) return 0;
	if (!renderNode(node)) return 0;
	return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);
}

/** Whether the block asks the user anything; picks whether it carries an
 *  answer bar at all. */
function parsedAsks(source: string): boolean {
	const parsed = parseUiBlock(source);
	return parsed.tree ? hasAnswers(parsed.tree) : false;
}

/** A container whose children all drew nothing is itself empty — otherwise an
 *  all-broken block would count as "shown" and lose its reasons. */

/** Render one block source. Diagnostics stay visible — see `renderUiBlockFence`. */
export function renderUiBlock(source: string): UiBlockRender {
	const parsed = parseUiBlock(source);
	if (!parsed.tree) return { html: "", nodes: 0, errors: parsed.errors };
	const html = renderNode(parsed.tree);
	if (!html) return { html: "", nodes: 0, errors: parsed.errors };
	return { html, nodes: countNodes(parsed.tree), errors: parsed.errors };
}

function sourceHtml(source: string): string {
	return `<details class="tr-ui-src"><summary>${esc(t("transcript.uiBlockSource"))}</summary><pre>${esc(source.trim())}</pre></details>`;
}

function errorsHtml(errors: readonly string[], source: string, hash: string): string {
	const reasons = errors.map(item => `<li>${esc(item)}</li>`).join("");
	return (
		`<div class="tr-ui-note">${esc(t("transcript.uiBlockPartial", { count: String(errors.length) }))}<ul>${reasons}</ul></div>` +
		`<button type="button" class="tr-ui-repair" data-ui-repair="${esc(hash)}">${esc(t("transcript.uiBlockRepair"))}</button>` +
		sourceHtml(source)
	);
}

/**
 * The ```` ```ui ```` fence a streaming reply has opened but not closed, with
 * the text before it. Drawing the partial block is what makes it grow with the
 * reply instead of appearing when the fence finally closes.
 */
export function splitOpenUiFence(text: string): { head: string; source: string } | null {
	const lines = text.split("\n");
	let openAt = -1;
	for (const [index, line] of lines.entries()) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("```")) continue;
		const lang = trimmed.slice(3).trim().toLowerCase();
		if (openAt === -1) {
			if (isUiBlockLanguage(lang)) openAt = index;
			continue;
		}
		openAt = -1;
	}
	if (openAt === -1) return null;
	return {
		head: lines.slice(0, openAt).join("\n"),
		source: lines.slice(openAt + 1).join("\n"),
	};
}

/**
 * Markdown-fence entry point: the whole block as HTML. A reply has no second
 * try, so a block that drew nothing falls back to its source and reasons rather
 * than vanishing.
 */
export function renderUiBlockFence(source: string, complete = true): string {
	const rendered = renderUiBlock(source);
	if (!complete) return rendered.nodes > 0 ? `<div class="tr-ui tr-ui--streaming">${rendered.html}</div>` : "";
	const hash = hashOf(source);
	// The repair button quotes this; keep it where the click can find it.
	rememberBlockFailure(hash, source, rendered.errors);
	if (rendered.nodes === 0) {
		return (
			`<div class="tr-ui tr-ui--empty" data-ui-block="${esc(hash)}">` +
			`<div class="tr-ui-note">${esc(t("transcript.uiBlockEmpty"))}</div>` +
			(rendered.errors.length
				? `<ul class="tr-ui-errors">${rendered.errors.map(e => `<li>${esc(e)}</li>`).join("")}</ul>`
				: "") +
			`<button type="button" class="tr-ui-repair" data-ui-repair="${esc(hash)}">${esc(t("transcript.uiBlockRepair"))}</button>` +
			sourceHtml(source) +
			`</div>`
		);
	}
	const note = rendered.errors.length > 0 ? errorsHtml(rendered.errors, source, hash) : "";
	const asking = parsedAsks(source);
	if (asking) {
		return (
			`<div class="tr-ui" data-ui-block="${esc(hash)}" data-ui-sent="false">` +
			`${rendered.html}${answerBar(source)}${note}` +
			`</div>`
		);
	}
	return `<div class="tr-ui">${rendered.html}${note}</div>`;
}
