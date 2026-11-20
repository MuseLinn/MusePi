/**
 * Board model: pure widget-board state operations for BoardPage —
 * placement, collision avoidance, persistence, seed data. Zero React;
 * the only DOM touch is `localStorage` in {@link loadBoards}.
 */
import { t } from "@musepi/client-core";
import { type BoardWidget, widgetDef } from "@musepi/client-core/src/widgets/registry";

export const BOARDS_KEY = "musepi-gui-board:boards";
export const ACTIVE_KEY = "musepi-gui-board:active";
/** Pixel snap — resize/drag adjustments land on multiples of 8 (fine
 *  enough for "a few pixels" while keeping cards grid-aligned). */
export const SNAP = 8;
/** Board canvas base width: 12 columns × 92px grid, minus one 12px
 *  gutter = 1092px (kimi's measured canvas: 2×540+12 or 3×356+2×12 both
 *  land exactly on 1092). Cards position on the 92px grid; the surface
 *  scales to the window. */
export const BASE_W = 1092;
/** Resize steps: width 92px per column, height 44px per row (kimi's
 *  measured steps: 1092→540 wide, 472→76 tall), with a 12px gutter. */
export const SNAP_W = 92;
export const SNAP_H = 44;
export const GAP = 12;
/** kimi size bounds: min 2 cols × 2 rows (172×76 = 2×92−12 / 2×44−12),
 *  max full canvas 12 cols × 33 rows (1092×1440). */
export const MIN_W = 2 * SNAP_W - GAP;
export const MIN_H = 2 * SNAP_H - GAP;
export const MAX_H = 33 * SNAP_H - GAP;
/** Default card size for new widgets. */
export const DEF_W = 340;
export const DEF_H = 200;

export interface BoardData {
	id: string;
	title: string;
	widgets: BoardWidget[];
	/** Seed examples: protected (agents can't save, GUI can't delete). */
	builtin?: boolean;
}

export interface Ghost {
	id: string;
	rect: { x: number; y: number; w: number; h: number };
}

let boardSeq = 0;
export function nextId(prefix: string): string {
	boardSeq += 1;
	return `${prefix}${Date.now().toString(36)}-${boardSeq}`;
}

export function makeWidget(type: string, title?: string, w = DEF_W, h = DEF_H): BoardWidget {
	const def = widgetDef(type);
	return {
		id: nextId("w"),
		type,
		title: title ?? def?.label ?? t((def?.nameKey ?? "widget unknown") as never),
		data: def ? def.defaults() : {},
		pos: { x: 0, y: 0, w, h },
	};
}

/** Place a widget below the tallest card (left-aligned), with a
 *  left-to-right scan that reuses horizontal gaps when possible. */
export function placeWidget(
	widgets: BoardWidget[],
	w: number,
	h: number,
): { x: number; y: number; w: number; h: number } {
	if (widgets.length === 0) return { x: 0, y: 0, w, h };
	const maxY = Math.max(...widgets.map(wg => wg.pos.y + wg.pos.h));
	const maxX = Math.max(...widgets.map(wg => wg.pos.x + wg.pos.w));
	// First pass: scan rows (in 8px steps) for a free horizontal span at
	// the left edge; fall back to the bottom. The scan NEVER places a card
	// beyond the canvas width (BASE_W) — cards must stay on-canvas.
	const xLimit = Math.min(maxX, BASE_W - w);
	for (let y = 0; y <= maxY; y += SNAP) {
		for (let x = 0; x <= xLimit; x += SNAP) {
			let free = true;
			for (const wg of widgets) {
				if (x < wg.pos.x + wg.pos.w && x + w > wg.pos.x && y < wg.pos.y + wg.pos.h && y + h > wg.pos.y) {
					free = false;
					break;
				}
			}
			if (free) return { x, y, w, h };
		}
	}
	return { x: 0, y: maxY + GAP, w, h };
}

export function makeAndPlace(widgets: BoardWidget[], type: string, title?: string, w = DEF_W, h = DEF_H): BoardWidget {
	const wgt = makeWidget(type, title, w, h);
	return { ...wgt, pos: placeWidget(widgets, w, h) };
}

/** Seed placement: exact row/column on the BASE_W canvas so the example
 *  boards tile the full width (placeWidget is for dynamic adds). */
function at(
	_widgets: BoardWidget[],
	type: string,
	title: string,
	x: number,
	y: number,
	w: number,
	h: number,
	data: Record<string, unknown> = {},
): BoardWidget {
	const wgt = makeWidget(type, title, w, h);
	return { ...wgt, data: { ...wgt.data, ...data }, pos: { x, y, w, h } };
}

/** Derive a ticker card data patch from a normalized widget.data FX rate
 *  (open.er-api quotes 1 CNY = X EUR; the card displays CNY per EUR). */
export function tickerFxPatch(data: Record<string, unknown>, cnyPerEur: number): Record<string, unknown> {
	const old = typeof data.value === "string" ? Number(data.value) : NaN;
	const base = Number.isFinite(old) && old > 0 ? old : 7.7945;
	// Small jitter keeps the quote visibly moving (kimi ticker parity); the
	// underlying rate barely drifts over a 60s refresh window.
	const value = cnyPerEur + (Math.random() * 0.004 - 0.002);
	const delta = value - base;
	const step = Math.max(0.004, Math.abs(delta) * 2);
	const spark: number[] = [];
	let v = value - delta * 2;
	for (let i = 0; i < 7; i++) {
		v += (Math.random() - 0.5) * step;
		spark.push(Number(v.toFixed(4)));
	}
	spark.push(Number(value.toFixed(4)));
	return { value: value.toFixed(4), delta: Number(delta.toFixed(4)), spark };
}

/**
 * Sample faces and the migration path they establish.
 *
 * Migration policy (deliberate, not incidental):
 * - Builtin boards restore `seedBoards()` on every load, so their static
 *   examples become the live faces in one step at startup. Builtin edits were
 *   already session-only by design, so nothing user-owned is overwritten.
 * - A card on a user board is never rewritten on load. A factory static card
 *   is recognised by its seed title plus the old page shell, shows the sample
 *   note, and only a click runs `upgradeSampleWidget`; that keeps the old HTML
 *   and title under `data.previousSample`.
 * - A retired canned type renders through `legacyWidgetData` at render time
 *   and keeps its stored type and data untouched, so a plugin that registers
 *   the type later still takes precedence (and the board does not go blank in
 *   the meantime).
 */

/**
 * One card page's shell. A sample card is an `html` widget, and every control
 * inside it runs in the page: the sandbox has a null origin and no network or
 * storage, so the timer, the checks, the quote jitter and the range tabs all
 * live in the face. `data.data` initializes what the page starts from (it
 * reaches the frame as `window.__WIDGET_DATA__` before the page script runs).
 *
 * The canned card types (pomodoro / todo / clock / ticker …) were retired with
 * the visual migration, so a seed that still named one rendered as an empty
 * card: the sample boards opened to a blank canvas while still reporting "8 个
 * 组件". These faces use the app's theme tokens, so they follow light/dark like
 * every other page card, and `seedPage` is the single wrapper every face uses.
 */
function seedPage(body: string, script: string): string {
	return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{height:100%;overflow:hidden;margin:0;background:transparent;color:var(--fg);font:13px/1.5 var(--font-sans,system-ui,sans-serif)}
.wrap{height:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:10px;padding:14px 16px}
h3{margin:0;font-size:11.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-muted)}
.big{font-size:34px;font-weight:650;letter-spacing:-.02em;line-height:1.1}
.muted{color:var(--fg-muted);font-size:12px}
.row{display:flex;justify-content:space-between;gap:10px;align-items:baseline}
.up{color:var(--color-success,#2f9e63)} .down{color:var(--color-danger,#d24b45)}
table{width:100%;border-collapse:collapse;font-size:12.5px}
td{padding:5px 0;border-top:1px solid var(--border);vertical-align:baseline}
td:nth-child(3){padding-left:16px}
td:last-child{padding-right:2px}
.num{font-family:var(--font-mono,ui-monospace,monospace);text-align:right;font-variant-numeric:tabular-nums}
tr.is-on td{background:var(--bg-inset,rgba(0,0,0,.06))}
.bar{height:8px;border-radius:99px;background:var(--bg-inset,rgba(0,0,0,.06));overflow:hidden}
.bar i{display:block;height:100%;border-radius:inherit;background:var(--accent);transition:width .2s ease}
.heat{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.heat button{display:flex;flex-direction:column;gap:2px;padding:9px 8px;border:0;border-radius:8px;color:var(--fg);font:inherit;font-size:11.5px;text-align:left;cursor:pointer}
.heat button.is-on{box-shadow:inset 0 0 0 1.5px var(--accent)}
.spark{width:100%;height:54px;display:block;flex:none}
.spark--grow{flex:1;height:auto;min-height:120px}
.chips{display:flex;gap:6px;flex-wrap:wrap}
.chip{padding:2px 8px;border-radius:99px;border:1px solid var(--border);color:var(--fg-muted);font-size:11.5px}
.check{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:9px;font-size:13px}
.check li{display:flex;gap:8px;align-items:flex-start}
.check li b{font-weight:400;flex:1;min-width:0;overflow-wrap:anywhere}
.check button{flex:none;width:18px;height:18px;margin-top:1px;display:flex;align-items:center;justify-content:center;border:1px solid var(--border);border-radius:5px;background:transparent;color:transparent;font-size:11px;cursor:pointer}
.check li.done button{background:var(--accent);border-color:var(--accent);color:#fff}
.check li.done b{color:var(--fg-muted);text-decoration:line-through}
.poster{position:relative;flex:1;border-radius:12px;background:linear-gradient(160deg,#1b2440,#3d2b52 55%,#7a4a3d);display:flex;align-items:flex-end;padding:18px;cursor:pointer}
.play{position:absolute;inset:0;margin:auto;width:56px;height:56px;border-radius:99px;border:1.5px solid rgba(255,255,255,.7);display:flex;align-items:center;justify-content:center;color:#fff;font-size:20px;cursor:pointer;transition:background .15s ease}
.poster.is-playing .play{background:rgba(255,255,255,.16)}
.poster-progress{position:absolute;left:0;right:0;bottom:0;height:4px;background:rgba(255,255,255,.18)}
.poster-progress i{display:block;height:100%;width:0;background:var(--accent);transition:width .25s linear}
.tracks{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;min-height:0;overflow:hidden}
.track{display:flex;align-items:center;gap:10px;width:100%;padding:5px 6px;border:0;border-radius:8px;background:transparent;color:var(--fg);font:inherit;text-align:left;cursor:pointer}
.track:hover{background:var(--bg-inset,rgba(0,0,0,.05))}
.track.is-on{background:var(--bg-inset,rgba(0,0,0,.08))}
.cover{width:34px;height:34px;border-radius:8px;flex:none}
.progress{height:6px;border-radius:99px;background:var(--bg-inset,rgba(0,0,0,.06));overflow:hidden}
.progress i{display:block;height:100%;width:0;background:var(--accent);transition:width .2s linear}
.actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.btn{padding:3px 10px;border:1px solid var(--border);border-radius:99px;background:transparent;color:var(--fg);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.btn:hover{background:var(--bg-inset,rgba(0,0,0,.06))}
.btn.is-on{border-color:var(--accent);color:var(--accent);background:color-mix(in oklab,var(--accent) 10%,transparent)}
.btn--primary{background:var(--accent);border-color:var(--accent);color:#fff}
.field{min-width:0;flex:1;padding:4px 8px;border:1px solid var(--border);border-radius:8px;background:var(--bg-inset,rgba(0,0,0,.04));color:var(--fg);font:inherit;font-size:12px;outline:none}
.field:focus{border-color:var(--accent)}
input[type=range]{width:100%;margin:0;accent-color:var(--accent)}
.week{display:flex;align-items:flex-end;gap:5px;height:88px}
.week button{flex:1;height:100%;display:flex;flex-direction:column;justify-content:flex-end;gap:4px;padding:2px;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer}
.week button:hover{background:var(--bg-inset,rgba(0,0,0,.05))}
.week button i{display:block;width:100%;min-height:4px;border-radius:4px 4px 2px 2px;background:color-mix(in oklab,var(--accent) 32%,transparent)}
.week button.is-on i{background:var(--accent)}
.week button span{font-size:10.5px;color:var(--fg-muted);text-align:center}
.history-list{display:flex;flex-direction:column;gap:12px;min-height:0}
.history-item{display:flex;gap:12px;font-size:13px;line-height:1.5}
.history-item b{flex:none;width:48px;color:var(--fg-muted);font-weight:500;font-variant-numeric:tabular-nums}
</style></head><body><div class="wrap">${body}</div><script>${script}</script></body></html>`;
}

interface FaceDef {
	/** Stable sample id; also what `data.sample.id` stores. */
	id: string;
	/** What the face starts from; reaches the page as `window.__WIDGET_DATA__`. */
	initial: Record<string, unknown>;
	/** Full srcdoc. The face reads its state from the injected data. */
	page(): string;
}

function cloneInitial(value: Record<string, unknown>): Record<string, unknown> {
	return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function focusPage(): string {
	return seedPage(
		`<h3>专注</h3>
		<div class="big" id="time">25:00</div>
		<div class="muted" id="phase">番茄钟 · 第 1 轮 · 待开始</div>
		<div class="bar"><i id="fill" style="width:0%"></i></div>
		<div class="actions"><button type="button" class="btn btn--primary" id="toggle">开始</button><button type="button" class="btn" id="skip">跳过</button></div>`,
		`(function(){
  var D = window.__WIDGET_DATA__ || {};
  var focusMin = Number(D.focusMin) || 25;
  var breakMin = Number(D.breakMin) || 5;
  var round = Math.max(1, Number(D.round) || 1);
  var phase = "focus";
  var total = focusMin * 60;
  var left = total;
  var running = false;
  var timer = null;
  var time = document.getElementById("time");
  var fill = document.getElementById("fill");
  var state = document.getElementById("phase");
  var toggle = document.getElementById("toggle");
  function fmt(seconds){
    var m = Math.floor(seconds / 60);
    var s = seconds % 60;
    return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
  }
  function paint(){
    time.textContent = fmt(left);
    fill.style.width = Math.round((1 - left / total) * 100) + "%";
    state.textContent = "番茄钟 · 第 " + round + " 轮 · " + (running ? "进行中" : (phase === "focus" ? "待开始" : "休息中"));
    toggle.textContent = running ? "暂停" : "开始";
  }
  function stop(){
    running = false;
    if (timer) { clearInterval(timer); timer = null; }
    paint();
  }
  function advance(){
    if (phase === "focus") { phase = "break"; round += 1; total = breakMin * 60; }
    else { phase = "focus"; total = focusMin * 60; }
    left = total;
  }
  function tick(){
    if (!running) return;
    left -= 1;
    if (left <= 0) advance();
    paint();
  }
  function start(){
    if (running) { stop(); return; }
    running = true;
    if (timer) clearInterval(timer);
    timer = setInterval(tick, 1000);
    paint();
  }
  toggle.addEventListener("click", start);
  document.getElementById("skip").addEventListener("click", function(){ stop(); advance(); paint(); });
  paint();
})();`,
	);
}

function todayPage(): string {
	return seedPage(
		`<div class="row"><h3>今天</h3><span class="muted" id="count"></span></div>
		<ul class="check" id="list"></ul>
		<div class="actions"><input class="field" id="draft" placeholder="加一件…" aria-label="新待办"><button type="button" class="btn" id="add">添加</button></div>`,
		`(function(){
  var D = window.__WIDGET_DATA__ || {};
  var items = Array.isArray(D.items) ? D.items.map(function(item, index){
    return { id: index, text: String(item && item.text != null ? item.text : item), done: !!(item && item.done) };
  }) : [];
  var list = document.getElementById("list");
  var count = document.getElementById("count");
  var draft = document.getElementById("draft");
  function render(){
    list.innerHTML = "";
    items.forEach(function(item){
      var li = document.createElement("li");
      if (item.done) li.className = "done";
      var check = document.createElement("button");
      check.type = "button";
      check.textContent = item.done ? "✓" : "";
      check.setAttribute("aria-label", "切换完成");
      check.addEventListener("click", function(){ item.done = !item.done; render(); });
      var text = document.createElement("b");
      text.textContent = item.text;
      li.appendChild(check);
      li.appendChild(text);
      list.appendChild(li);
    });
    count.textContent = items.filter(function(item){ return item.done; }).length + " / " + items.length + " 已完成";
  }
  function add(){
    var value = (draft.value || "").trim();
    if (!value) return;
    items.push({ id: Date.now(), text: value, done: false });
    draft.value = "";
    render();
  }
  document.getElementById("add").addEventListener("click", add);
  draft.addEventListener("keydown", function(event){
    if (event.key === "Enter") { event.preventDefault(); add(); }
  });
  render();
})();`,
	);
}

function clockPage(): string {
	return seedPage(
		`<h3>市场时钟</h3>
		<div class="big" id="sh">--:--</div>
		<div class="muted" id="shst">上海</div>
		<table>
			<tr><td>东京</td><td class="num" id="tk">--:--</td><td class="muted" id="tkst"></td></tr>
			<tr><td>伦敦</td><td class="num" id="ld">--:--</td><td class="muted" id="ldst"></td></tr>
			<tr><td>纽约</td><td class="num" id="ny">--:--</td><td class="muted" id="nyst"></td></tr>
		</table>
		<div class="actions"><button type="button" class="btn" id="sync">刷新</button><span class="muted" id="hint"></span></div>`,
		`(function(){
  var zones = [
    { id: "sh", name: "上海", zone: "Asia/Shanghai", sessions: [[570, 690], [780, 900]] },
    { id: "tk", name: "东京", zone: "Asia/Tokyo", sessions: [[540, 690], [750, 900]] },
    { id: "ld", name: "伦敦", zone: "Europe/London", sessions: [[480, 990]] },
    { id: "ny", name: "纽约", zone: "America/New_York", sessions: [[570, 960]] }
  ];
  function read(zone){
    var parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone.zone, hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short" }).formatToParts(new Date());
    var value = {};
    parts.forEach(function(part){ value[part.type] = part.value; });
    return { hour: Number(value.hour) % 24, minute: Number(value.minute), weekday: value.weekday };
  }
  function stateOf(zone){
    var now = read(zone);
    if (now.weekday === "Sat" || now.weekday === "Sun") return "周末";
    var minutes = now.hour * 60 + now.minute;
    for (var i = 0; i < zone.sessions.length; i++){
      var session = zone.sessions[i];
      if (minutes >= session[0] && minutes < session[1]) return "交易中";
      if (minutes < session[0]) return i === 0 ? "未开" : "午休";
    }
    return "收盘";
  }
  function clock(zone){ var now = read(zone); return (now.hour < 10 ? "0" : "") + now.hour + ":" + (now.minute < 10 ? "0" : "") + now.minute; }
  function paint(){
    var sh = read(zones[0]);
    document.getElementById("sh").textContent = (sh.hour < 10 ? "0" : "") + sh.hour + ":" + (sh.minute < 10 ? "0" : "") + sh.minute;
    document.getElementById("shst").textContent = "上海 · " + stateOf(zones[0]) + " · " + (sh.weekday === "Sat" || sh.weekday === "Sun" ? "周末" : "工作日");
    zones.slice(1).forEach(function(zone){
      document.getElementById(zone.id).textContent = clock(zone);
      document.getElementById(zone.id + "st").textContent = stateOf(zone);
    });
    document.getElementById("hint").textContent = "本地时区换算";
  }
  document.getElementById("sync").addEventListener("click", function(){
    paint();
    document.getElementById("hint").textContent = "刚刚校对";
  });
  paint();
  setInterval(paint, 1000);
})();`,
	);
}

function fxPage(): string {
	return seedPage(
		`<h3>FX · CNY</h3>
		<div class="big" id="base">7.0921</div>
		<div class="muted">美元 / 人民币 · <span id="delta"></span></div>
		<table id="rows"></table>
		<div class="actions"><button type="button" class="btn" id="refresh">刷新报价</button><span class="muted" id="at">示例数据</span></div>`,
		`(function(){
  var D = window.__WIDGET_DATA__ || {};
  var base = Number(D.base) || 7.0921;
  var baseDelta = Number(D.baseDelta) || -0.12;
  var rows = Array.isArray(D.rows) ? D.rows.map(function(row){ return { label: String(row.label || ""), value: Number(row.value) || 0, delta: Number(row.delta) || 0 }; }) : [];
  function pct(value){
    return (value >= 0 ? "+" : "−") + Math.abs(value).toFixed(2) + "%";
  }
  function tone(value){ return value >= 0 ? "up" : "down"; }
  function paint(){
    document.getElementById("base").textContent = base.toFixed(4);
    var delta = document.getElementById("delta");
    delta.textContent = pct(baseDelta);
    delta.className = tone(baseDelta);
    var body = document.getElementById("rows");
    body.innerHTML = "";
    rows.forEach(function(row){
      var tr = document.createElement("tr");
      var name = document.createElement("td");
      name.textContent = row.label;
      var num = document.createElement("td");
      num.className = "num";
      num.textContent = row.value.toFixed(4) + " ";
      var move = document.createElement("span");
      move.className = tone(row.delta);
      move.textContent = pct(row.delta);
      num.appendChild(move);
      tr.appendChild(name);
      tr.appendChild(num);
      body.appendChild(tr);
    });
    document.getElementById("at").textContent = "示例报价 · " + new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  document.getElementById("refresh").addEventListener("click", function(){
    base = Math.max(0.1, base + (Math.random() * 0.03 - 0.015));
    baseDelta = Number((Math.random() * 0.3 - 0.15).toFixed(2));
    rows = rows.map(function(row){
      var value = row.value * (1 + (Math.random() * 0.0006 - 0.0003));
      return { label: row.label, value: value, delta: Number((row.delta + Math.random() * 0.12 - 0.06).toFixed(2)) };
    });
    paint();
  });
  paint();
})();`,
	);
}

function stocksPage(): string {
	return seedPage(
		`<h3>A-SHARES</h3>
		<table id="rows"></table>
		<div class="actions"><button type="button" class="btn" id="refresh">刷新</button><span class="muted" id="note">点一行看详情</span></div>`,
		`(function(){
  var D = window.__WIDGET_DATA__ || {};
  var rows = Array.isArray(D.rows) ? D.rows.map(function(row){ return { name: String(row.name || ""), code: String(row.code || ""), value: Number(row.value) || 0, delta: Number(row.delta) || 0 }; }) : [];
  var selected = -1;
  function pct(value){ return (value >= 0 ? "+" : "−") + Math.abs(value).toFixed(2) + "%"; }
  function paint(){
    var body = document.getElementById("rows");
    body.innerHTML = "";
    rows.forEach(function(row, index){
      var tr = document.createElement("tr");
      if (index === selected) tr.className = "is-on";
      tr.style.cursor = "pointer";
      var name = document.createElement("td");
      name.textContent = row.name + " ";
      var code = document.createElement("span");
      code.className = "muted";
      code.textContent = row.code;
      name.appendChild(code);
      var num = document.createElement("td");
      num.className = "num";
      num.textContent = row.value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " ";
      var move = document.createElement("span");
      move.className = row.delta >= 0 ? "up" : "down";
      move.textContent = pct(row.delta);
      num.appendChild(move);
      tr.appendChild(name);
      tr.appendChild(num);
      tr.addEventListener("click", function(){
        selected = selected === index ? -1 : index;
        document.getElementById("note").textContent = selected < 0 ? "点一行看详情" : row.name + " · 成交 " + (120 + index * 37) + " 万手";
        paint();
      });
      body.appendChild(tr);
    });
  }
  document.getElementById("refresh").addEventListener("click", function(){
    rows = rows.map(function(row){
      var delta = Number((row.delta + Math.random() * 0.6 - 0.3).toFixed(2));
      return { name: row.name, code: row.code, value: row.value * (1 + delta / 1000), delta: delta };
    });
    document.getElementById("note").textContent = "刚刚刷新 · 本地模拟";
    paint();
  });
  paint();
})();`,
	);
}

function hs300Page(): string {
	return seedPage(
		`<div class="row"><h3>沪深300</h3><span class="muted" id="range-label">1D</span></div>
		<div class="row"><div class="big" id="value">3,940.84</div><div class="up" id="delta">+1.02%</div></div>
		<svg class="spark spark--grow" id="chart" viewBox="0 0 600 120" preserveAspectRatio="none">
			<polygon id="area" fill="var(--accent)" opacity="0.12" points=""></polygon>
			<polyline id="line" fill="none" stroke="var(--accent)" stroke-width="2" points=""></polyline>
		</svg>
		<table id="stats"></table>
		<div class="actions" id="tabs">
			<button type="button" class="btn is-on" data-range="1D">1 日</button>
			<button type="button" class="btn" data-range="1W">1 周</button>
			<button type="button" class="btn" data-range="1M">1 月</button>
		</div>`,
		`(function(){
  var D = window.__WIDGET_DATA__ || {};
  var series = D.series || {};
  var stats = D.stats || {};
  var labels = { "1D": "1D", "1W": "1W", "1M": "1M" };
  var current = "1D";
  function draw(){
    var values = Array.isArray(series[current]) ? series[current] : [];
    if (!values.length) return;
    var max = Math.max.apply(null, values);
    var min = Math.min.apply(null, values);
    var span = max - min || 1;
    var points = values.map(function(value, index){
      var x = 600 * index / (values.length - 1);
      var y = 110 - (value - min) / span * 100;
      return x.toFixed(1) + "," + y.toFixed(1);
    }).join(" ");
    document.getElementById("line").setAttribute("points", points);
    document.getElementById("area").setAttribute("points", "0,120 " + points + " 600,120");
    var first = values[0];
    var last = values[values.length - 1];
    var delta = (last - first) / first * 100;
    document.getElementById("value").textContent = last.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    var move = document.getElementById("delta");
    move.textContent = (delta >= 0 ? "+" : "−") + Math.abs(delta).toFixed(2) + "%";
    move.className = delta >= 0 ? "up" : "down";
    document.getElementById("range-label").textContent = labels[current];
    var body = document.getElementById("stats");
    body.innerHTML = "";
    (Array.isArray(stats[current]) ? stats[current] : []).forEach(function(pair){
      var tr = document.createElement("tr");
      var label = document.createElement("td");
      label.textContent = pair[0];
      var value = document.createElement("td");
      value.className = "num";
      value.textContent = pair[1];
      tr.appendChild(label);
      tr.appendChild(value);
      body.appendChild(tr);
    });
    Array.prototype.forEach.call(document.querySelectorAll("#tabs button"), function(button){
      button.classList.toggle("is-on", button.getAttribute("data-range") === current);
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll("#tabs button"), function(button){
    button.addEventListener("click", function(){
      current = button.getAttribute("data-range") || "1D";
      draw();
    });
  });
  draw();
})();`,
	);
}

function tempPage(): string {
	return seedPage(
		`<h3>A股市场温度</h3>
		<div class="big" id="value">68</div>
		<div class="bar"><i id="fill" style="width:68%"></i></div>
		<div class="row"><span class="muted" id="label">偏暖 · 沪强深弱</span><span class="up" id="change">+6</span></div>
		<div class="chips" id="chips"></div>
		<input type="range" id="range" min="0" max="100" value="68" aria-label="市场温度">`,
		`(function(){
  var D = window.__WIDGET_DATA__ || {};
  var value = Math.max(0, Math.min(100, Number(D.value) || 68));
  var range = document.getElementById("range");
  function labelOf(score){
    if (score < 20) return "冰点 · 全面缩量";
    if (score < 40) return "偏冷 · 防守为主";
    if (score < 60) return "中性 · 多空拉锯";
    if (score < 80) return "偏暖 · 沪强深弱";
    return "过热 · 注意回撤";
  }
  function paint(){
    document.getElementById("value").textContent = String(value);
    document.getElementById("fill").style.width = value + "%";
    document.getElementById("label").textContent = labelOf(value);
    var change = document.getElementById("change");
    var diff = value - 62;
    change.textContent = (diff >= 0 ? "+" : "−") + Math.abs(diff);
    change.className = diff >= 0 ? "up" : "down";
    var chips = document.getElementById("chips");
    chips.innerHTML = "";
    [["上涨", Math.round(1600 + value * 24)], ["下跌", Math.round(3400 - value * 24)], ["涨停", Math.round(value * 0.9)]].forEach(function(pair){
      var chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = pair[0] + " " + pair[1].toLocaleString("zh-CN");
      chips.appendChild(chip);
    });
    range.value = String(value);
  }
  range.addEventListener("input", function(){ value = Number(range.value); paint(); });
  paint();
})();`,
	);
}

function portfolioPage(): string {
	return seedPage(
		`<h3>组合日收益</h3>
		<div class="big" id="value">+1.82%</div>
		<div class="muted">较昨日 <span class="up" id="delta">+0.40%</span></div>
		<svg class="spark" id="chart" viewBox="0 0 300 80" preserveAspectRatio="none">
			<polyline id="line" fill="none" stroke="var(--accent)" stroke-width="2" points=""></polyline>
		</svg>
		<div class="actions" id="tabs">
			<button type="button" class="btn is-on" data-range="1D">日</button>
			<button type="button" class="btn" data-range="1W">周</button>
			<button type="button" class="btn" data-range="1M">月</button>
		</div>`,
		`(function(){
  var D = window.__WIDGET_DATA__ || {};
  var series = D.series || {};
  var current = "1D";
  function paint(){
    var values = Array.isArray(series[current]) ? series[current] : [];
    var max = values.length ? Math.max.apply(null, values) : 1;
    var min = values.length ? Math.min.apply(null, values) : 0;
    var span = max - min || 1;
    var points = values.map(function(value, index){
      var x = 300 * index / Math.max(1, values.length - 1);
      var y = 70 - (value - min) / span * 58;
      return x.toFixed(1) + "," + y.toFixed(1);
    }).join(" ");
    document.getElementById("line").setAttribute("points", points);
    var total = values.length ? values[values.length - 1] : 0;
    document.getElementById("value").textContent = (total >= 0 ? "+" : "−") + Math.abs(total).toFixed(2) + "%";
    var delta = Number(D.delta && D.delta[current]) || 0;
    var move = document.getElementById("delta");
    move.textContent = (delta >= 0 ? "+" : "−") + Math.abs(delta).toFixed(2) + "%";
    move.className = delta >= 0 ? "up" : "down";
    Array.prototype.forEach.call(document.querySelectorAll("#tabs button"), function(button){
      button.classList.toggle("is-on", button.getAttribute("data-range") === current);
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll("#tabs button"), function(button){
    button.addEventListener("click", function(){ current = button.getAttribute("data-range") || "1D"; paint(); });
  });
  paint();
})();`,
	);
}

function heatwallPage(): string {
	return seedPage(
		`<h3>涨跌热力</h3>
		<div class="heat" id="grid"></div>
		<div class="actions"><button type="button" class="btn" id="refresh">刷新</button><span class="muted" id="note">点一个板块看详情</span></div>`,
		`(function(){
  var D = window.__WIDGET_DATA__ || {};
  var tiles = Array.isArray(D.tiles) ? D.tiles.map(function(tile){ return { name: String(tile.name || ""), delta: Number(tile.delta) || 0 }; }) : [];
  var selected = -1;
  function paint(){
    var grid = document.getElementById("grid");
    grid.innerHTML = "";
    tiles.forEach(function(tile, index){
      var button = document.createElement("button");
      button.type = "button";
      button.className = index === selected ? "is-on" : "";
      var tone = tile.delta >= 0 ? "var(--color-success,#2f9e63)" : "var(--color-danger,#d24b45)";
      var weight = 12 + Math.min(36, Math.abs(tile.delta) * 10);
      button.style.background = "color-mix(in oklab," + tone + " " + weight + "%, transparent)";
      var name = document.createElement("span");
      name.textContent = tile.name;
      var move = document.createElement("b");
      move.className = tile.delta >= 0 ? "up" : "down";
      move.textContent = (tile.delta >= 0 ? "+" : "−") + Math.abs(tile.delta).toFixed(2) + "%";
      button.appendChild(name);
      button.appendChild(move);
      button.addEventListener("click", function(){
        selected = selected === index ? -1 : index;
        document.getElementById("note").textContent = selected < 0 ? "点一个板块看详情" : tile.name + " · " + move.textContent + " · 按昨日成交额加权";
        paint();
      });
      grid.appendChild(button);
    });
  }
  document.getElementById("refresh").addEventListener("click", function(){
    tiles = tiles.map(function(tile){ return { name: tile.name, delta: Number((tile.delta + Math.random() * 0.8 - 0.4).toFixed(2)) }; });
    document.getElementById("note").textContent = "刚刚刷新 · 示例数据";
    paint();
  });
  paint();
})();`,
	);
}

function indextapePage(): string {
	return seedPage(
		`<div class="actions" id="tabs"></div>
		<div class="row"><div class="big" id="value">3,214.62</div><div class="up" id="delta">+0.88%</div></div>
		<svg class="spark" id="chart" viewBox="0 0 500 90" preserveAspectRatio="none">
			<polyline id="line" fill="none" stroke="var(--accent)" stroke-width="2" points=""></polyline>
		</svg>
		<table id="stats"></table>`,
		`(function(){
  var D = window.__WIDGET_DATA__ || {};
  var symbols = Array.isArray(D.symbols) ? D.symbols : [];
  var current = 0;
  function paint(){
    var tabs = document.getElementById("tabs");
    tabs.innerHTML = "";
    symbols.forEach(function(symbol, index){
      var button = document.createElement("button");
      button.type = "button";
      button.className = "btn" + (index === current ? " is-on" : "");
      button.textContent = symbol.name;
      button.addEventListener("click", function(){ current = index; paint(); });
      tabs.appendChild(button);
    });
    var symbol = symbols[current];
    if (!symbol) return;
    document.getElementById("value").textContent = symbol.value;
    var move = document.getElementById("delta");
    move.textContent = (symbol.delta >= 0 ? "+" : "−") + Math.abs(symbol.delta).toFixed(2) + "%";
    move.className = symbol.delta >= 0 ? "up" : "down";
    var values = Array.isArray(symbol.series) ? symbol.series : [];
    var max = values.length ? Math.max.apply(null, values) : 1;
    var min = values.length ? Math.min.apply(null, values) : 0;
    var span = max - min || 1;
    var points = values.map(function(value, index){
      var x = 500 * index / Math.max(1, values.length - 1);
      var y = 80 - (value - min) / span * 66;
      return x.toFixed(1) + "," + y.toFixed(1);
    }).join(" ");
    document.getElementById("line").setAttribute("points", points);
    var stats = document.getElementById("stats");
    stats.innerHTML = "";
    [["今开", symbol.open], ["昨收", symbol.prev], ["最高", symbol.high], ["最低", symbol.low], ["成交", symbol.amount]].forEach(function(pair){
      var tr = document.createElement("tr");
      var label = document.createElement("td");
      label.textContent = pair[0];
      var value = document.createElement("td");
      value.className = "num";
      value.textContent = pair[1] || "—";
      tr.appendChild(label);
      tr.appendChild(value);
      stats.appendChild(tr);
    });
  }
  paint();
})();`,
	);
}

function taxPage(): string {
	return seedPage(
		`<h3>劳务费个税</h3>
		<div class="big" id="hand">1,760.00</div>
		<div class="muted" id="meta">收入 1,760 · 预扣 0%</div>
		<div class="row"><span class="muted">到手</span><span id="net">1,760.00</span></div>
		<div class="actions"><input class="field" id="income" type="number" min="0" step="10" value="1760" aria-label="劳务收入"><button type="button" class="btn" id="calc">计算</button></div>`,
		`(function(){
  var D = window.__WIDGET_DATA__ || {};
  var input = document.getElementById("income");
  input.value = String(Number(D.income) || 1760);
  function money(value){ return value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function compute(){
    var income = Math.max(0, Number(input.value) || 0);
    var taxable = income <= 800 ? 0 : income <= 4000 ? income - 800 : income * 0.8;
    var tax = taxable <= 20000 ? taxable * 0.2 : taxable <= 50000 ? taxable * 0.3 - 2000 : taxable * 0.4 - 7000;
    var hand = income - tax;
    document.getElementById("hand").textContent = money(hand);
    document.getElementById("net").textContent = money(hand);
    var rate = income > 0 ? tax / income * 100 : 0;
    document.getElementById("meta").textContent = "收入 " + money(income) + " · 预扣 " + rate.toFixed(rate === 0 ? 0 : 1) + "%";
  }
  document.getElementById("calc").addEventListener("click", compute);
  input.addEventListener("input", compute);
  compute();
})();`,
	);
}

function weeklyPage(): string {
	return seedPage(
		`<h3>本周专注</h3>
		<div class="big" id="total">760 <span class="muted">分钟</span></div>
		<div class="week" id="bars"></div>
		<div class="muted" id="detail">点一根柱子看当天</div>`,
		`(function(){
  var D = window.__WIDGET_DATA__ || {};
  var days = Array.isArray(D.days) ? D.days.map(function(day){ return { label: String(day.label || ""), min: Number(day.min) || 0 }; }) : [];
  var selected = -1;
  function paint(){
    var total = days.reduce(function(sum, day){ return sum + day.min; }, 0);
    document.getElementById("total").innerHTML = total + ' <span class="muted">分钟</span>';
    var max = Math.max.apply(null, days.map(function(day){ return day.min; }).concat([60]));
    var bars = document.getElementById("bars");
    bars.innerHTML = "";
    days.forEach(function(day, index){
      var button = document.createElement("button");
      button.type = "button";
      button.className = index === selected ? "is-on" : "";
      button.setAttribute("aria-label", day.label + " " + day.min + " 分钟");
      var fill = document.createElement("i");
      fill.style.height = Math.max(4, Math.round(day.min / max * 76)) + "px";
      var label = document.createElement("span");
      label.textContent = day.label;
      button.appendChild(fill);
      button.appendChild(label);
      button.addEventListener("click", function(){
        selected = selected === index ? -1 : index;
        document.getElementById("detail").textContent = selected < 0 ? "点一根柱子看当天" : "星期" + day.label + " · " + day.min + " 分钟";
        paint();
      });
      bars.appendChild(button);
    });
    if (selected >= 0 && days[selected]) document.getElementById("detail").textContent = "星期" + days[selected].label + " · " + days[selected].min + " 分钟";
  }
  paint();
})();`,
	);
}

function posterPage(): string {
	return seedPage(
		`<h3>BILIBILI · 年番</h3>
		<div class="poster" id="poster">
			<span class="play" id="play">▶</span>
			<div><div style="font-size:22px;font-weight:650;color:#fff">凡人修仙传</div>
			<div style="color:rgba(255,255,255,.72);font-size:12.5px" id="episode">第 132 集 · 星海飞驰</div></div>
			<div class="poster-progress"><i id="bar"></i></div>
		</div>`,
		`(function(){
  var D = window.__WIDGET_DATA__ || {};
  var poster = document.getElementById("poster");
  var play = document.getElementById("play");
  var bar = document.getElementById("bar");
  var episode = document.getElementById("episode");
  if (typeof D.episode === "string") episode.textContent = D.episode;
  var running = false;
  var progress = 0;
  var timer = null;
  function paint(){
    poster.classList.toggle("is-playing", running);
    play.textContent = running ? "❚❚" : "▶";
    bar.style.width = progress + "%";
  }
  function toggle(){
    running = !running;
    if (running) {
      timer = setInterval(function(){
        progress += 0.8;
        if (progress >= 100) { progress = 0; running = false; clearInterval(timer); timer = null; }
        paint();
      }, 400);
    } else if (timer) {
      clearInterval(timer);
      timer = null;
    }
    paint();
  }
  poster.addEventListener("click", toggle);
  play.addEventListener("click", function(event){ event.stopPropagation(); toggle(); });
  paint();
})();`,
	);
}

function historyPage(): string {
	return seedPage(
		`<div class="row"><h3>HISTORY</h3><span class="muted" id="date">今天</span></div>
		<div class="history-list" id="list"></div>
		<div class="actions"><button type="button" class="btn" id="next">换一批</button></div>`,
		`(function(){
  var D = window.__WIDGET_DATA__ || {};
  var events = Array.isArray(D.events) ? D.events.map(function(item){ return { year: String(item.year || ""), text: String(item.text || "") }; }) : [];
  var start = 0;
  function paint(){
    var list = document.getElementById("list");
    list.innerHTML = "";
    for (var i = 0; i < Math.min(3, events.length); i++){
      var item = events[(start + i) % events.length];
      var row = document.createElement("div");
      row.className = "history-item";
      var year = document.createElement("b");
      year.textContent = item.year;
      var text = document.createElement("span");
      text.textContent = item.text;
      row.appendChild(year);
      row.appendChild(text);
      list.appendChild(row);
    }
    document.getElementById("date").textContent = "今天 · " + new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
  }
  document.getElementById("next").addEventListener("click", function(){
    start = (start + 3) % Math.max(1, events.length);
    paint();
  });
  paint();
})();`,
	);
}

function vinylPage(): string {
	return seedPage(
		`<h3>今日歌单</h3>
		<div class="tracks" id="list"></div>
		<div class="progress"><i id="bar"></i></div>
		<div class="muted" id="now">选一首开始 · 示例音频</div>`,
		`(function(){
  var D = window.__WIDGET_DATA__ || {};
  var tracks = Array.isArray(D.tracks) ? D.tracks : [];
  var selected = 0;
  var progress = 0;
  var running = false;
  var timer = null;
  function paint(){
    var list = document.getElementById("list");
    list.innerHTML = "";
    tracks.forEach(function(track, index){
      var button = document.createElement("button");
      button.type = "button";
      button.className = "track" + (index === selected ? " is-on" : "");
      var cover = document.createElement("span");
      cover.className = "cover";
      cover.style.background = String(track.colors || "linear-gradient(135deg,#8a5a2b,#d9a441)");
      var name = document.createElement("b");
      name.style.flex = "1";
      name.style.fontWeight = "400";
      name.textContent = String(track.name || "");
      var time = document.createElement("span");
      time.className = "muted";
      time.textContent = String(track.time || "");
      button.appendChild(cover);
      button.appendChild(name);
      button.appendChild(time);
      button.addEventListener("click", function(){ select(index); });
      list.appendChild(button);
    });
    document.getElementById("bar").style.width = progress + "%";
    var active = tracks[selected];
    document.getElementById("now").textContent = active ? (running ? "正在播放 · " : "已选 · ") + active.name : "选一首开始 · 示例音频";
  }
  function select(index){
    selected = index;
    progress = 0;
    running = true;
    if (timer) clearInterval(timer);
    timer = setInterval(function(){
      progress += 1.4;
      if (progress >= 100) { progress = 0; running = false; clearInterval(timer); timer = null; }
      paint();
    }, 400);
    paint();
  }
  paint();
})();`,
	);
}

function metricPage(): string {
	return seedPage(
		`<h3 id="label">指标</h3>
		<div class="big" id="value">0</div>
		<div class="muted" id="delta"></div>
		<div class="actions"><button type="button" class="btn" id="refresh">刷新</button></div>`,
		`(function(){
  var D = window.__WIDGET_DATA__ || {};
  var label = typeof D.label === "string" ? D.label : "指标";
  var value = Number(D.value) || 0;
  var unit = typeof D.unit === "string" ? D.unit : "";
  function paint(){
    document.getElementById("label").textContent = label;
    document.getElementById("value").textContent = value.toLocaleString("zh-CN", { maximumFractionDigits: 1 }) + unit;
    document.getElementById("delta").textContent = "示例读数 · 可刷新";
  }
  document.getElementById("refresh").addEventListener("click", function(){
    value = Number((value + Math.random() * 2 - 1).toFixed(1));
    paint();
  });
  paint();
})();`,
	);
}

const FACES: Record<string, FaceDef> = {
	focus: { id: "focus", initial: { round: 1, focusMin: 25, breakMin: 5 }, page: focusPage },
	today: {
		id: "today",
		initial: {
			items: [
				{ text: "梳理本周发布范围", done: true },
				{ text: "跑通一次桌面端冒烟", done: true },
				{ text: "把看板示例换成真实数据", done: false },
				{ text: "整理插件能力缝文档", done: false },
			],
		},
		page: todayPage,
	},
	clock: { id: "clock", initial: {}, page: clockPage },
	fx: {
		id: "fx",
		initial: {
			base: 7.0921,
			baseDelta: -0.12,
			rows: [
				{ label: "1 欧元", value: 7.743, delta: 0.08 },
				{ label: "100 日元", value: 4.712, delta: -0.05 },
				{ label: "1 英镑", value: 9.0412, delta: 0.21 },
			],
		},
		page: fxPage,
	},
	stocks: {
		id: "stocks",
		initial: {
			rows: [
				{ name: "贵州茅台", code: "600519", value: 1682.4, delta: 0.85 },
				{ name: "宁德时代", code: "300750", value: 254.1, delta: 2.14 },
				{ name: "比亚迪", code: "002594", value: 268.66, delta: 0.66 },
				{ name: "中芯国际", code: "688981", value: 96.3, delta: 3.5 },
				{ name: "招商银行", code: "600036", value: 42.18, delta: -0.44 },
			],
		},
		page: stocksPage,
	},
	hs300: {
		id: "hs300",
		initial: {
			series: {
				"1D": [3902, 3910, 3906, 3924, 3918, 3936, 3930, 3948, 3942, 3956, 3950, 3964, 3958, 3968, 3962, 3941],
				"1W": [3850, 3862, 3858, 3876, 3870, 3892, 3886, 3904, 3898, 3920, 3914, 3936, 3930, 3950, 3944, 3941],
				"1M": [3700, 3728, 3716, 3750, 3742, 3784, 3770, 3812, 3804, 3846, 3834, 3878, 3866, 3910, 3898, 3941],
			},
			stats: {
				"1D": [
					["今开", "3,902.10"],
					["昨收", "3,901.06"],
					["最高", "3,964.20"],
					["最低", "3,886.44"],
					["成交额", "4,182 亿"],
					["换手", "1.24%"],
				],
				"1W": [
					["周开", "3,850.00"],
					["上周收", "3,812.40"],
					["最高", "3,968.00"],
					["最低", "3,844.20"],
					["成交额", "1.86 万亿"],
					["换手", "5.42%"],
				],
				"1M": [
					["月开", "3,700.00"],
					["上月收", "3,658.20"],
					["最高", "3,968.00"],
					["最低", "3,692.10"],
					["成交额", "7.94 万亿"],
					["换手", "21.6%"],
				],
			},
		},
		page: hs300Page,
	},
	temp: { id: "temp", initial: { value: 68 }, page: tempPage },
	portfolio: {
		id: "portfolio",
		initial: {
			series: {
				"1D": [0.6, 0.8, 0.7, 1.0, 0.9, 1.2, 1.1, 1.4, 1.3, 1.6, 1.5, 1.82],
				"1W": [0.2, 0.6, 0.4, 0.9, 0.7, 1.3, 1.1, 1.5, 1.4, 1.9, 1.7, 2.4],
				"1M": [0.1, 0.3, 0.2, 0.6, 0.5, 1.0, 0.8, 1.4, 1.2, 1.9, 1.7, 2.6],
			},
			delta: { "1D": 0.4, "1W": 0.9, "1M": 1.4 },
		},
		page: portfolioPage,
	},
	heatwall: {
		id: "heatwall",
		initial: {
			tiles: [
				{ name: "贵州茅台", delta: 0.85 },
				{ name: "宁德时代", delta: 2.14 },
				{ name: "比亚迪", delta: 0.66 },
				{ name: "中芯国际", delta: 3.5 },
				{ name: "招商银行", delta: -0.44 },
				{ name: "中国平安", delta: -0.22 },
				{ name: "紫金矿业", delta: 1.88 },
				{ name: "长江电力", delta: 0 },
			],
		},
		page: heatwallPage,
	},
	indextape: {
		id: "indextape",
		initial: {
			symbols: [
				{
					name: "上证",
					value: "3,214.62",
					delta: 0.88,
					series: [3170, 3182, 3176, 3192, 3186, 3202, 3196, 3210, 3204, 3218, 3212, 3215],
					open: "3,186.10",
					prev: "3,186.56",
					high: "3,226.40",
					low: "3,178.20",
					amount: "4,182 亿",
				},
				{
					name: "深证",
					value: "10,482.10",
					delta: 1.24,
					series: [10280, 10310, 10300, 10340, 10330, 10380, 10370, 10420, 10410, 10460, 10450, 10482],
					open: "10,312.40",
					prev: "10,353.80",
					high: "10,498.60",
					low: "10,286.20",
					amount: "5,306 亿",
				},
				{
					name: "创业板",
					value: "2,186.44",
					delta: 1.62,
					series: [2130, 2140, 2136, 2150, 2146, 2160, 2156, 2170, 2166, 2180, 2176, 2186],
					open: "2,140.80",
					prev: "2,151.62",
					high: "2,192.10",
					low: "2,132.40",
					amount: "2,044 亿",
				},
			],
		},
		page: indextapePage,
	},
	tax: { id: "tax", initial: { income: 1760 }, page: taxPage },
	weekly: {
		id: "weekly",
		initial: {
			days: [
				{ label: "一", min: 96 },
				{ label: "二", min: 128 },
				{ label: "三", min: 64 },
				{ label: "四", min: 152 },
				{ label: "五", min: 120 },
				{ label: "六", min: 80 },
				{ label: "日", min: 120 },
			],
		},
		page: weeklyPage,
	},
	poster: {
		id: "poster",
		initial: { episode: "第 132 集 · 星海飞驰" },
		page: posterPage,
	},
	history: {
		id: "history",
		initial: {
			events: [
				{ year: "2008", text: "北京奥运会闭幕，中国以 51 枚金牌居金牌榜首位。" },
				{ year: "1887", text: "李享亭出生，中国消化病学奠基人之一。" },
				{ year: "1980", text: "罗杰·费德勒出生，瑞士男子职业网球运动员。" },
				{ year: "1969", text: "阿波罗 11 号登月舱在月球着陆。" },
				{ year: "1998", text: "国际空间站首个模块发射升空。" },
				{ year: "1946", text: "第一台通用电子计算机 ENIAC 正式启用。" },
			],
		},
		page: historyPage,
	},
	vinyl: {
		id: "vinyl",
		initial: {
			tracks: [
				{ name: "夜航西飞", time: "4:12", colors: "linear-gradient(135deg,#8a5a2b,#d9a441)" },
				{ name: "雨落长街", time: "3:48", colors: "linear-gradient(135deg,#2b4a8a,#5aa1d9)" },
				{ name: "纸飞机", time: "4:05", colors: "linear-gradient(135deg,#4a2b8a,#a15ad9)" },
				{ name: "春分", time: "3:32", colors: "linear-gradient(135deg,#2b8a63,#5ad9a1)" },
				{ name: "远方来信", time: "5:01", colors: "linear-gradient(135deg,#8a2b45,#d95a7a)" },
			],
		},
		page: vinylPage,
	},
	metric: { id: "metric", initial: { label: "指标", value: 72, delta: 1.2 }, page: metricPage },
};

/** Card types the registry no longer knows, mapped to the face that keeps an
 *  old board readable. The mapping runs at render time (never rewrites the
 *  stored type), so a plugin that registers one of these later still wins. */
const RETIRED_FACE_BY_TYPE: Record<string, string> = {
	pomodoro: "focus",
	todo: "today",
	clock: "clock",
	metric: "metric",
	ticker: "fx",
	fx: "fx",
	stocks: "stocks",
	kline: "hs300",
	heatwall: "heatwall",
	indextape: "indextape",
	gauge: "temp",
	slider: "temp",
	calc: "tax",
	video: "poster",
	gallery: "poster",
	music: "vinyl",
	history: "history",
};

/** Old seed titles → sample id, for the cards the static seed HTML left on a
 *  user board. Titles are the only stable key an untouched seed kept; a card
 *  whose title was edited is left alone rather than guessed at. */
const LEGACY_SEED_TITLES: Record<string, string> = {
	今天: "today",
	专注: "focus",
	市场时钟: "clock",
	人民币汇率: "fx",
	A股盯盘: "stocks",
	沪深300: "hs300",
	市场温度: "temp",
	组合日收益: "portfolio",
	涨跌热力: "heatwall",
	指数磁带: "indextape",
	劳务费个税: "tax",
	本周专注: "weekly",
	凡人修仙传: "poster",
	历史上的今天: "history",
	黑胶唱片: "vinyl",
};

/** A card's sample marker: the face id plus whether the card is already
 *  interactive. */
export interface SampleTag {
	id: string;
	interactive: boolean;
}

function faceWidgetData(faceId: string, initial: Record<string, unknown>): Record<string, unknown> {
	const face = FACES[faceId];
	return {
		html: face.page(),
		data: initial,
		sample: { id: faceId, interactive: true },
	};
}

function legacyInitialFor(faceId: string, data: Record<string, unknown>): Record<string, unknown> {
	const face = FACES[faceId];
	const initial = cloneInitial(face.initial);
	if (faceId === "today") {
		let raw = data.items;
		if (typeof raw === "string") {
			try {
				raw = JSON.parse(raw);
			} catch {
				raw = [];
			}
		}
		if (Array.isArray(raw) && raw.length > 0) {
			initial.items = raw.map(item => {
				const value = item as { text?: unknown; done?: unknown } | string | null;
				return {
					text: String(typeof value === "string" ? value : (value?.text ?? "")),
					done: typeof value === "object" && value !== null && value.done === true,
				};
			});
		}
	}
	if (faceId === "focus") {
		const rounds = typeof data.rounds === "number" ? data.rounds : 0;
		initial.round = rounds + 1;
	}
	if (faceId === "fx") {
		const value = Number(data.value);
		if (Number.isFinite(value) && value > 0) initial.base = value;
	}
	if (faceId === "temp") {
		const value = Number(data.value);
		if (Number.isFinite(value)) initial.value = Math.max(0, Math.min(100, Math.round(value)));
	}
	if (faceId === "tax") {
		const amount = Number(data.amount);
		if (Number.isFinite(amount) && amount >= 0) initial.income = amount;
	}
	if (faceId === "metric") {
		if (typeof data.label === "string") initial.label = data.label;
		const value = Number(data.value);
		if (Number.isFinite(value)) initial.value = value;
	}
	return initial;
}

const legacyFaceCache = new Map<string, Record<string, unknown>>();

/**
 * Data a retired-type card renders through the `html` face. Returns null when
 * the type is registered (built-in or a loaded plugin), so the fallback never
 * shadows a real renderer. Cached by type + data so a re-render hands the same
 * object to `HtmlCard` and does not rebuild the frame.
 */
export function legacyWidgetData(w: BoardWidget): Record<string, unknown> | null {
	if (widgetDef(w.type)) return null;
	const faceId = RETIRED_FACE_BY_TYPE[w.type];
	if (!faceId) return null;
	let key: string;
	try {
		key = `${w.type}\u0000${JSON.stringify(w.data)}`;
	} catch {
		return faceWidgetData(faceId, legacyInitialFor(faceId, w.data));
	}
	const cached = legacyFaceCache.get(key);
	if (cached) return cached;
	const next = faceWidgetData(faceId, legacyInitialFor(faceId, w.data));
	if (legacyFaceCache.size >= 64) legacyFaceCache.clear();
	legacyFaceCache.set(key, next);
	return next;
}

function legacyStaticFaceId(w: BoardWidget): string | null {
	if (w.type !== "html" || w.data.sample !== undefined) return null;
	const raw = w.data.html;
	if (typeof raw !== "string") return null;
	if (!raw.includes('<div class="wrap">') || !raw.includes("html,body{height:100%;overflow:hidden;")) return null;
	return LEGACY_SEED_TITLES[w.title.trim()] ?? null;
}

export function sampleTag(w: BoardWidget): SampleTag | null {
	const raw = w.data.sample as { id?: unknown; interactive?: unknown } | undefined;
	if (raw && typeof raw.id === "string") return { id: raw.id, interactive: raw.interactive !== false };
	const legacy = legacyStaticFaceId(w);
	return legacy ? { id: legacy, interactive: false } : null;
}

/**
 * Lazy upgrade for a card that still shows the factory's static sample page.
 * The old HTML and title stay in `data.previousSample`, so a user who had
 * edited the page can get it back from the card data; everything else on the
 * widget (id, title, position, task fields) is untouched.
 */
export function upgradeSampleWidget(w: BoardWidget): BoardWidget | null {
	const tag = sampleTag(w);
	if (!tag || tag.interactive) return null;
	const face = FACES[tag.id];
	if (!face) return null;
	const previous = typeof w.data.html === "string" ? { html: w.data.html, title: w.title, at: Date.now() } : null;
	return {
		...w,
		type: "html",
		data: {
			...w.data,
			html: face.page(),
			data: cloneInitial(face.initial),
			sample: { id: face.id, interactive: true },
			...(previous ? { previousSample: previous } : {}),
		},
	};
}

interface SeedCardSpec {
	face: string;
	title: string;
	x: number;
	y: number;
	w: number;
	h: number;
}

function seedCard(board: BoardWidget[], spec: SeedCardSpec): void {
	const face = FACES[spec.face];
	board.push(
		at(
			board,
			"html",
			spec.title,
			spec.x,
			spec.y,
			spec.w,
			spec.h,
			faceWidgetData(spec.face, cloneInitial(face.initial)),
		),
	);
}

const FINANCE_SEEDS: SeedCardSpec[] = [
	{ face: "clock", title: "市场时钟", x: 0, y: 0, w: 356, h: 296 },
	{ face: "fx", title: "人民币汇率", x: 368, y: 0, w: 356, h: 296 },
	{ face: "stocks", title: "A股盯盘", x: 736, y: 0, w: 356, h: 296 },
	{ face: "hs300", title: "沪深300", x: 0, y: 308, w: 724, h: 604 },
	{ face: "temp", title: "市场温度", x: 736, y: 308, w: 356, h: 296 },
	{ face: "portfolio", title: "组合日收益", x: 736, y: 616, w: 356, h: 296 },
	{ face: "heatwall", title: "涨跌热力", x: 0, y: 924, w: 540, h: 428 },
	{ face: "indextape", title: "指数磁带", x: 552, y: 924, w: 540, h: 428 },
];

const HELLO_SEEDS: SeedCardSpec[] = [
	{ face: "today", title: "今天", x: 0, y: 0, w: 540, h: 516 },
	{ face: "focus", title: "专注", x: 552, y: 0, w: 264, h: 252 },
	{ face: "clock", title: "市场时钟", x: 828, y: 0, w: 264, h: 252 },
	{ face: "tax", title: "劳务费个税", x: 552, y: 264, w: 264, h: 252 },
	{ face: "weekly", title: "本周专注", x: 828, y: 264, w: 264, h: 252 },
	{ face: "poster", title: "凡人修仙传", x: 0, y: 528, w: 540, h: 560 },
	{ face: "history", title: "历史上的今天", x: 552, y: 528, w: 540, h: 560 },
	{ face: "vinyl", title: "黑胶唱片", x: 0, y: 1100, w: 1092, h: 604 },
];

/** Seed boards (first run): 每日财经 + 工作台. Every card is a live face: the
 *  clock ticks, the timer runs, the checklist toggles, the charts switch range
 *  and the quote lists refresh — an example is something to use, not a
 *  screenshot to click through and delete. */
export function seedBoards(): BoardData[] {
	const f: BoardWidget[] = [];
	for (const spec of FINANCE_SEEDS) seedCard(f, spec);
	const h: BoardWidget[] = [];
	for (const spec of HELLO_SEEDS) seedCard(h, spec);
	return [
		{ id: "finance", title: t("settings.boardFinanceTitle"), widgets: f, builtin: true },
		{ id: "hello", title: t("settings.boardHelloTitle"), widgets: h, builtin: true },
	];
}

/** Legacy cell layout (12-col grid, 150px rows) → pixels. Column width is
 *  estimated at 96px (a 1152px canvas) since load runs before the canvas
 *  is measured; cards keep their proportions. */
export function migrateCellPos(w: BoardWidget): BoardWidget {
	const p = w.pos as unknown as { c?: number; r?: number; w?: number; h?: number };
	if (p.c === undefined || p.r === undefined) return w;
	const colW = 96;
	return {
		...w,
		pos: {
			x: (p.c ?? 0) * colW,
			y: (p.r ?? 0) * 150,
			w: (p.w ?? 4) * colW,
			h: (p.h ?? 1) * 150,
		},
	};
}

/** Builtin examples restore their pristine seed layout on load — drag /
 *  resize / task-run changes are session-only ephemeral, the boards come
 *  back factory-fresh after a relaunch. */
export function restoreBuiltinBoards(boards: BoardData[]): BoardData[] {
	const seeds = seedBoards();
	return boards.map(b => {
		if (b.builtin !== true) return b;
		const seed = seeds.find(s => s.id === b.id);
		return seed ? { ...seed } : b;
	});
}

/** Seed boards are protected: agents may not modify them (board tool
 *  rejects) and the GUI hides delete for them (builtin flag). Legacy
 *  stored seeds are re-flagged by id. */
export function markBuiltin(b: BoardData): BoardData {
	if (b.builtin === true || b.id === "finance" || b.id === "hello") return { ...b, builtin: true };
	return b;
}

export function sanitizeBoard(b: BoardData): BoardData {
	const dirty = b.widgets.some(w => [w.pos.x, w.pos.y, w.pos.w, w.pos.h].some(v => v % 1 !== 0));
	if (!dirty) return markBuiltin(b);
	return markBuiltin({
		...b,
		widgets: b.widgets.map(w => ({
			...w,
			pos: {
				x: Math.round(w.pos.x),
				y: Math.round(w.pos.y),
				w: Math.round(w.pos.w),
				h: Math.round(w.pos.h),
			},
		})),
	});
}

/** Builtin examples are protected (the GUI hides their delete), so their
 *  absence in a non-empty store means an external full-list overwrite
 *  dropped them — re-inject the seeds. An EMPTY store is respected
 *  (user deleted everything). */
export function ensureBuiltinSeeds(boards: BoardData[]): BoardData[] {
	if (boards.length === 0) return boards;
	const seeds = seedBoards();
	const have = new Set(boards.map(b => b.id));
	const missing = seeds.filter(s => !have.has(s.id));
	return missing.length > 0 ? [...boards, ...missing] : boards;
}

/** External-board merge for periodic refresh (TUI/GUI distribution):
 *  the local view is authoritative for boards the user is looking at, but
 *  boards the agent created on the daemon (ids unknown locally) must not
 *  be clobbered by a stale local snapshot — append them. Deletion stays
 *  local: a removed board is absent here and the daemon save has already
 *  flushed it, so it never comes back; builtin seeds are re-injected by
 *  {@link ensureBuiltinSeeds}. */
export function mergeDaemonBoards(local: BoardData[], daemon: BoardData[]): BoardData[] {
	const localIds = new Set(local.map(b => b.id));
	const fresh = daemon.filter(b => !localIds.has(b.id) && b.builtin !== true);
	if (fresh.length === 0) return local;
	return [...local, ...fresh.map(markBuiltin)];
}

export function loadBoards(): BoardData[] {
	try {
		const raw = localStorage.getItem(BOARDS_KEY);
		if (raw) {
			const parsed = JSON.parse(raw) as BoardData[];
			if (Array.isArray(parsed)) {
				// An empty array is LEGAL (the user deleted every board) —
				// only a missing key reseeds the examples.
				if (parsed.length === 0) return [];
				let migrated = false;
				const next = parsed.map(b => {
					if (b.widgets.some(w => (w.pos as { c?: number }).c !== undefined)) {
						migrated = true;
						return { ...b, widgets: b.widgets.map(migrateCellPos) };
					}
					// Whole-pixel guarantee: round any fractional leftovers
					// from older resize clamps.
					const san = sanitizeBoard(b);
					if (san !== b) migrated = true;
					return san;
				});
				if (migrated) {
					try {
						localStorage.setItem(BOARDS_KEY, JSON.stringify(next));
					} catch {
						// keep in-memory
					}
				}
				// Builtin boards always restore their seed layout; missing
				// seeds (external overwrite) are re-injected.
				return ensureBuiltinSeeds(restoreBuiltinBoards(next));
			}
		}
	} catch {
		// corrupt — reseed
	}
	const seeded = seedBoards();
	try {
		localStorage.setItem(BOARDS_KEY, JSON.stringify(seeded));
	} catch {
		// storage unavailable
	}
	return seeded;
}

/** True when two pixel rects overlap (with a small gutter so adjacent
 *  cards with the 14px gap never count as colliding). */
export function overlaps(
	a: { x: number; y: number; w: number; h: number },
	b: { x: number; y: number; w: number; h: number },
): boolean {
	const g = GAP - 4;
	return a.x < b.x + b.w - g && a.x + a.w - g > b.x && a.y < b.y + b.h - g && a.y + a.h - g > b.y;
}

/** Push colliding widgets down until every rect is clear — kimi-style
 *  greedy avoidance. Chain: a pushed widget becomes a collision source
 *  itself (it may land on its neighbors), so pushes cascade instead of
 *  leaving the pushed card overlapping its siblings. Mutates a copy. */
export function resolveCollisions(widgets: BoardWidget[], moved: BoardWidget, excludeId: string): BoardWidget[] {
	const next = widgets.map(w => ({ ...w, pos: { ...w.pos } }));
	const seen = new Set<string>([excludeId]);
	const stack: { id: string; pos: BoardWidget["pos"] }[] = [{ id: excludeId, pos: moved.pos }];
	let guard = 0;
	while (stack.length > 0 && guard++ < 400) {
		const cur = stack.shift();
		if (!cur) break;
		for (const w of next) {
			if (w.id === excludeId || w.id === cur.id || seen.has(w.id)) continue;
			if (overlaps(w.pos, cur.pos)) {
				const ny = cur.pos.y + cur.pos.h + GAP;
				w.pos = { ...w.pos, y: ny };
				seen.add(w.id);
				stack.push({ id: w.id, pos: w.pos });
			}
		}
	}
	return next;
}

/** Snap a dimension to the fine pixel grid. */
export function snap(v: number): number {
	return Math.round(v / SNAP) * SNAP;
}
