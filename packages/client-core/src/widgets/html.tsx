// Sub-path imports, NOT the barrel: `@musepi/pi-utils` re-exports Bun-only
// modules (frontmatter/glob/process-name/stderr-guard) and this file ships in a
// browser bundle, where those fail to build.
import { ensureReadableColor } from "@musepi/pi-utils/color";
import { MAX_WIDGET_HTML } from "@musepi/pi-utils/widget-html-limit";
import { Pencil as PencilIconData, X as XIconData } from "lucide";
import { MorphIcon } from "morphicons/react";
import type { ReactNode } from "react";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
	ANNOTATION_TEARDOWN_SCRIPT,
	type AnnotationOverlayLabels,
	type AnnotationOverlayTheme,
	buildAnnotationOverlayScript,
	dispatchAnnotationResult,
	isAnnotationPayload,
	renderAnnotationScreenshotFromBlob,
	resolveAnnotationOverlayTheme,
} from "../annotation/index.js";
import { t } from "../i18n/index.js";
import { WidgetHeadActionsSlot } from "./chrome.js";
import { PAGE_KIT_CSS } from "./page-kit.js";

/**
 * Custom HTML widget face (kimi blueprint-widget parity) — the agent
 * supplies arbitrary HTML (inline CSS/JS) that runs inside an opaque-
 * origin sandbox iframe:
 *
 * - `sandbox="allow-scripts"` WITHOUT allow-same-origin → null origin:
 *   no localStorage/cookies, and third-party fetches are blocked by
 *   null-origin CORS (kimi's documented widget-network rule — retrieve
 *   data outside the face and inject it). A direct `<img src>` to a
 *   public URL still works (no response bytes are read).
 * - `data` is injected as `window.__WIDGET_DATA__` before the face runs,
 *   and every data change is pushed via postMessage (`musepi-widget-data`)
 *   so a widget refreshed by a task re-renders without reloading.
 * - `window.DaimonCanvas = { canvasId, mountId }` mirrors kimi's host
 *   globals for faces that want to know where they live.
 * - **Theme adaptation (深浅色热切换)**: the host's resolved scheme is
 *   injected as `window.__WIDGET_THEME__` ("dark" | "light") and mirrored
 *   on the sandbox root as `class="musepi-theme-dark|light"`, so faces can
 *   provide two palettes via `html.musepi-theme-light body { … }` or JS.
 *   A MutationObserver on the host `<html data-theme>` rebuilds the
 *   srcdoc when the scheme flips, so the face follows the GUI's live
 *   light/dark toggle (widget.md's 铁律: faces must adapt, never ship a
 *   single fixed palette that loses contrast on the other scheme).
 *
 * - **Injected page kit**: the shared `.musepi-*` stylesheet in `page-kit.ts`
 *   (boxes, tables, badges, bars, steps, form controls, option cards and
 *   buttons) plus the host's own `--bg` / `--fg` / `--accent` / `--border` /
 *   `--radius-*` / `--chart-*` values, so a face does not have to hand-write a
 *   component or invent a palette. The sandbox is a null origin, so these are
 *   resolved host-side and shipped in; a face that uses `var(--bg)` without
 *   them gets nothing.
 * - **Answer channel**: the face hands a choice back to the conversation
 *   with `musepiSubmit(text, data)` - the host turns it into a user
 *   prompt, the same path every other interactive widget uses.
 *   Non-blocking by design: the agent's turn is over by the time the
 *   user clicks, and the answer arrives as the next user message. A
 *   question that must *hold* the turn open is the `ask` tool's job.
 *   This is a prompt-injection surface - model-authored JS can now put
 *   text into the agent's context - so the host bounds it: the message
 *   source must be this card's own frame, and the text is capped.
 * - **Answer readback**: after the host accepts an answer the face is told
 *   which one, via `window.musepiWidgetAnswer` (`{text, data}`,
 *   also `__MUSEPI_ANSWER__`), the `musepi-widget-answered` DOM event
 *   (`detail` carries the same object) and `data-musepi-answered` on
 *   `<html>`. Without it a click just dimmed the card and the face had no
 *   way to show "you picked A" - it could not even tell WHY it was dimmed.
 *   The answer survives a frame rebuild (theme flip rewrites the srcdoc):
 *   the host replays it on load.
 *
 * The card is interactive by default (buttons/sliders inside the face);
 * the board canvas disables iframe pointer-events while in edit mode so
 * cards stay draggable (kimi's draft-mode behavior).
 */

/** Ceiling on one face's HTML. Model-authored markup that can answer is
 * context-injection surface, so it gets a real bound rather than a decorative
 * constant: over it the card degrades to an empty notice rather than silently
 * rendering nothing. Shared with the tool side so the two cannot drift. */
const MAX_HTML = MAX_WIDGET_HTML;
/** Ceiling on what one face may say into the conversation. */
const MAX_SUBMIT_TEXT = 8_000;
/** Ceiling on the answer's structured payload. It is echoed back to the face
 *  only (never into the conversation), so the bound is about not copying an
 *  unbounded object through postMessage twice per answer. */
const MAX_SUBMIT_DATA = 8_000;

/** How long the frame gets to report that the overlay started before the host
 *  treats the click as failed and says so. */
const ANNOTATION_START_TIMEOUT_MS = 1500;

/** Frame height bounds: a short page keeps a minimal block, and a runaway page
 *  stops at a readable cap instead of growing the transcript without end. */
const MIN_FRAME_HEIGHT = 48;
const MAX_FRAME_HEIGHT = 20_000;

/** Last measured height per page face, keyed by its own bytes. A virtualized
 *  transcript unmounts off-screen rows; without this the iframe restarts at
 *  the inline floor and grows again under the reader's scroll. Bounded so a
 *  long session cannot pin every page it has ever shown. */
const rememberedFrameHeights = new Map<string, number>();
const MAX_REMEMBERED_FRAME_HEIGHTS = 500;

function rememberFrameHeight(key: string, height: number): void {
	// Re-insert to keep the map in least-recently-used order.
	rememberedFrameHeights.delete(key);
	rememberedFrameHeights.set(key, height);
	if (rememberedFrameHeights.size > MAX_REMEMBERED_FRAME_HEIGHTS) {
		const oldest = rememberedFrameHeights.keys().next().value;
		if (oldest !== undefined) rememberedFrameHeights.delete(oldest);
	}
}

/** 32-bit FNV-1a: a stable, cheap key for one page's bytes. No crypto import in
 *  a browser bundle, and a collision only restores a wrong height once. */
function fnv1a(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36);
}

/** One card answers at most once. Without this a double-click — or a face
 * that re-posts on every render — sends a second identical user message, and
 * the agent then sees the user "choosing" the same option twice. */
export function createAnswerGate(): { claim(text: string): string | null; readonly answered: boolean } {
	let answered = false;
	return {
		claim(text: string): string | null {
			if (answered) return null;
			answered = true;
			return text;
		},
		get answered(): boolean {
			return answered;
		},
	};
}

/** Host tokens a face cannot read for itself: the sandbox is a null origin,
 *  so `var(--bg)` inside the face resolves against the frame's own document,
 *  where the app's custom properties do not exist. The host resolves them and
 *  ships the computed values. Only names that actually resolve are sent, so a
 *  theme that drops one leaves the face with that var unset rather than with
 *  the literal string "". */
const FACE_TOKENS = [
	"--bg",
	"--bg-raised",
	"--fg",
	"--fg-muted",
	"--fg-faint",
	"--border",
	"--border-strong",
	"--accent",
	"--accent-fg",
	"--accent-hover",
	"--accent-bd",
	"--color-success",
	"--color-warning",
	"--color-info",
	"--color-danger",
	"--font-sans",
	"--font-mono",
	"--radius-sm",
	"--radius-md",
	"--radius-lg",
] as const;

/** The subset of {@link FACE_TOKENS} that must stay legible on the face's
 *  surface. Backgrounds are the reference and radii are lengths, so only text
 *  and border colors are corrected. */
const READABLE_FACE_TOKENS = [
	"--fg",
	"--fg-muted",
	"--fg-faint",
	"--border-strong",
	"--color-success",
	"--color-danger",
] as const;

/**
 * Read the host tokens a face needs, correcting any that would be unreadable.
 *
 * A token that reads fine on the app surface can vanish on the face's own
 * surface: an author ships one blue accent, and the face paints it on a tinted
 * card. The face cannot fix this itself — the sandbox is a null origin, so it
 * has no access to the theme to check against. The host measures before sending
 * and nudges whatever fails toward black or white (keeping the author's hue).
 *
 * Unparseable values pass through untouched: a token the host cannot measure is
 * one it must not silently rewrite, and `color-mix()`/`oklch()` declarations
 * resolve to their computed value here, so the unmeasured case is rare.
 */
export function readFaceTokens(): Record<string, string> {
	if (typeof document === "undefined") return {};
	const computed = getComputedStyle(document.documentElement);
	const resolved: Record<string, string> = {};
	for (const name of FACE_TOKENS) {
		const value = computed.getPropertyValue(name).trim();
		if (value) resolved[name] = value;
	}
	// The sandbox root font size is the chat's body text size, so a page sized
	// in rem/em follows the user's interface size setting instead of freezing
	// at whatever px the model wrote.
	const bodyFont = getComputedStyle(document.body).fontSize;
	if (bodyFont) resolved["--page-rem"] = String(bodyFont);
	// The face's own canvas is what text is read against; `--bg-raised` is the
	// surface a face typically paints a panel on.
	const surface = resolved["--bg-raised"] ?? resolved["--bg"] ?? "";
	if (!surface) return resolved;
	// Text and border tokens are the ones that can fail contrast; backgrounds
	// are the reference, and radii are not colors.
	const corrected: Record<string, string> = { ...resolved };
	for (const name of READABLE_FACE_TOKENS) {
		const value = resolved[name];
		if (value) corrected[name] = ensureReadableColor(value, surface, 4.5);
	}
	return corrected;
}

/** What a sandbox face is allowed to ask the host for. */
export type WidgetFaceMessage = { kind: "resize"; height: number } | { kind: "submit"; text: string; data?: unknown };

/**
 * Route one postMessage from a sandbox face.
 *
 * `expected` is the card's own `contentWindow`. Everything else on the page
 * can post the same shapes, so an unmatched source yields null instead of
 * acting: without that a neighbouring iframe can resize this card, and -
 * now that faces can answer - can put arbitrary text into the conversation.
 */
export function readWidgetFaceMessage(
	source: MessageEventSource | null,
	expected: MessageEventSource | null,
	raw: unknown,
): WidgetFaceMessage | null {
	if (expected === null || source !== expected) return null;
	const d = raw as { type?: string; height?: number; text?: string; data?: unknown } | null;
	if (!d || typeof d !== "object") return null;
	if (d.type === "musepi-widget-resize" && typeof d.height === "number") {
		return { kind: "resize", height: d.height };
	}
	if (d.type === "musepi-widget-submit" && typeof d.text === "string" && d.text.length > 0) {
		const data = readAnswerData(d.data);
		return { kind: "submit", text: d.text.slice(0, MAX_SUBMIT_TEXT), ...(data !== undefined ? { data } : {}) };
	}
	return null;
}

/** Keep the answer payload only when it is small, serializable JSON. The face
 *  gets it back verbatim, so an unserializable value would also be impossible
 *  to echo — dropping it is the honest choice over a lossy copy. */
function readAnswerData(value: unknown): unknown {
	if (value === undefined || value === null) return undefined;
	let json: string;
	try {
		json = JSON.stringify(value);
	} catch {
		return undefined;
	}
	return json.length <= MAX_SUBMIT_DATA ? value : undefined;
}

export function htmlDefaults(): Record<string, unknown> {
	return { html: "", data: {} };
}

/** Host scheme: `<html data-color-scheme>` (v2) else `data-theme` (legacy),
 *  defaulting to dark (the GUI's default). */
export function widgetHostTheme(): "dark" | "light" {
	if (typeof document === "undefined") return "dark";
	const root = document.documentElement;
	const scheme = root.dataset.colorScheme ?? root.dataset.theme;
	return scheme === "light" ? "light" : "dark";
}

/**
 * 统一标注的整套文案 —— 内置浏览器 (`ManagedBrowserPane`) 与会话内 HTML 卡片
 * 共用这一份,而不是各自拼。
 *
 * 缺 `panel` 时 overlay 退回旧的紧凑输入条,只有评论框;结构化元素卡需要它。
 * 两个宿主各写一份就会出现一边卡片、一边输入条,同一个 overlay 的选区阅读
 * 方式因此不同。
 */
export function annotationOverlayLabels(): AnnotationOverlayLabels {
	return {
		select: t("annotation.tool.element"),
		marquee: t("annotation.tool.region"),
		draw: t("annotation.tool.draw"),
		commentPlaceholder: t("annotation.commentPlaceholder"),
		submit: t("annotation.submit"),
		panel: {
			title: t("annotation.panelTitle"),
			close: t("annotation.panelClose"),
			sectionGeometry: t("annotation.panelGeometry"),
			sectionSemantics: t("annotation.panelSemantics"),
			sectionData: t("annotation.panelData"),
			sectionPage: t("annotation.panelPage"),
			selector: t("annotation.panelSelector"),
			path: t("annotation.panelPath"),
			bounds: t("annotation.panelBounds"),
			size: t("annotation.panelSize"),
			center: t("annotation.panelCenter"),
			text: t("annotation.panelText"),
			styles: t("annotation.panelStyles"),
			page: t("annotation.panelPageTitle"),
			url: t("annotation.panelUrl"),
			viewport: t("annotation.panelViewport"),
			dpr: t("annotation.panelDpr"),
			screenshot: t("annotation.panelScreenshot"),
			cancel: t("annotation.panelCancel"),
			add: t("annotation.panelAdd"),
		},
	};
}

function bootScript(
	canvasId: string,
	mountId: string,
	theme: "dark" | "light",
	tokens: Record<string, string>,
	baseFontPx: number,
): string {
	const root = Object.entries(tokens)
		.map(([k, v]) => `document.documentElement.style.setProperty(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
		.join("\n");
	return `<script>
document.documentElement.className = "musepi-theme-${theme} omp-theme-${theme}";
window.__WIDGET_THEME__ = ${JSON.stringify(theme)};
window.__WIDGET_DATA__ = window.__WIDGET_DATA__ || {};
// The payload script runs before this one, so alias it rather than
// starting a second object - the two globals must not diverge.
window.musepiWidgetData = window.__WIDGET_DATA__;
// Host-resolved design tokens (the sandbox is a null origin and cannot
// read the app's custom properties itself).
${root}
// The page inherits the chat's body size, so agent markup in rem/em follows
// the interface size setting instead of the browser's 16px default. Set after
// the token dump: tokens may carry their own --page-rem.
document.documentElement.style.fontSize = ${JSON.stringify(`${baseFontPx}px`)};
document.documentElement.style.setProperty("--page-rem", ${JSON.stringify(`${baseFontPx}px`)});
window.musepiWidgetTokens = ${JSON.stringify(tokens)};
window.DaimonCanvas = window.DaimonCanvas || { canvasId: ${JSON.stringify(canvasId)}, mountId: ${JSON.stringify(mountId)} };
// Page height probe for the widget frame. The root
// box is at least the frame's viewport, so its scrollHeight can never shrink
// below it; prefer body content (which can shrink), grow the frame for
// scrollers pinned to the bottom edge (the chat scrolls, not the card), and
// give the page its own scrollbar only when the host caps the frame.
var ompMeasure = { dirty: 1, positioned: [], scrollers: [], scrollerMemo: new WeakMap(), lastHeight: 0, lastOverflow: false, scheduled: 0 };
function ompInsideClipper(el) {
  for (var a = el.parentElement; a && a !== document.body; a = a.parentElement) {
    var o = getComputedStyle(a);
    if (o.overflowX !== "visible" || o.overflowY !== "visible") return true;
  }
  return false;
}
function ompScan() {
  ompMeasure.dirty = 0;
  ompMeasure.positioned = [];
  ompMeasure.scrollers = [];
  var all = document.body ? document.body.getElementsByTagName("*") : [];
  for (var i = 0; i < all.length && i < 5000; i++) {
    var el = all[i];
    var style = getComputedStyle(el);
    var pos = style.position;
    if ((pos === "absolute" || pos === "fixed") && !ompInsideClipper(el)) ompMeasure.positioned.push(el);
    if (/^(?:scroll|auto)$/.test(style.overflowY)) ompMeasure.scrollers.push(el);
  }
}
function ompBodyBoxHeight(d) {
  var b = d.getBoundingClientRect();
  return b.top + window.scrollY + (d.clientTop + d.scrollHeight) * (d.offsetHeight ? b.height / d.offsetHeight : 1);
}
function ompBodyContentHeight(d) {
  var box = ompBodyBoxHeight(d);
  // A stretched body (height:100%, a min-height shell) reports the viewport
  // through scrollHeight. The in-flow children's extent is the real content
  // bottom then, so a fitted card can shrink instead of holding a viewport of
  // blank space. A page with an overflowing scroller keeps the box: its
  // frame-bottom scroller needs the taller frame (one scrollbar, not two).
  var extent = 0;
  var count = 0;
  for (var el = d.firstElementChild; el; el = el.nextElementSibling) {
    var st = getComputedStyle(el);
    if (st.display === "none" || st.position === "absolute" || st.position === "fixed") continue;
    var r = el.getBoundingClientRect();
    var bottom = r.bottom + window.scrollY;
    if (bottom > extent) extent = bottom;
    count++;
  }
  if (count === 0) return box;
  extent += parseFloat(getComputedStyle(d).paddingBottom) || 0;
  return extent > 0 ? Math.min(box, extent) : box;
}
function ompMeasureHeight() {
  var r = document.documentElement;
  var d = document.body;
  if (ompMeasure.dirty) ompScan();
  // Is any scroller (or the body) actually scrolling its own content? A page
  // with one is a fill-the-frame page: do not shrink it to its children.
  var scrollerOverflows = false;
  for (var k = 0; k < ompMeasure.scrollers.length; k++) {
    var scroller = ompMeasure.scrollers[k];
    if (scroller.scrollHeight > scroller.clientHeight + 1) {
      scrollerOverflows = true;
      break;
    }
  }
  if (!scrollerOverflows && d && /^(?:scroll|auto)$/.test(getComputedStyle(d).overflowY) && d.scrollHeight > d.clientHeight + 1) {
    scrollerOverflows = true;
  }
  // Root content only when it overflows the viewport; a short page's root
  // rect is floored at the viewport and would pin a tall frame forever.
  var rootOverflows = r.scrollHeight > r.clientHeight + 1;
  var v = rootOverflows ? r.scrollHeight : 0;
  // Body content, unless the body itself scrolls/clips: then its scrollHeight
  // is the scroller's size, not the content's.
  if (d && !/^(?:hidden|clip|scroll|auto)$/.test(getComputedStyle(d).overflowY)) {
    var bodyHeight = scrollerOverflows ? ompBodyBoxHeight(d) : ompBodyContentHeight(d);
    // Overflowing root: the taller wins. Fitted root: the body's content is
    // the authority and may shrink below the frame's viewport.
    v = rootOverflows ? Math.max(v, bodyHeight) : bodyHeight;
  }
  if (v <= 0) v = r.getBoundingClientRect().height;
  // Positioned popups that stick out past the card are part of its box.
  for (var i = 0; i < ompMeasure.positioned.length; i++) {
    var p = ompMeasure.positioned[i];
    var pr = p.getBoundingClientRect();
    if (!pr.width && !pr.height) continue;
    var bottom = pr.bottom + window.scrollY;
    if (bottom > v) v = bottom;
  }
  // A scroller sitting on the frame's bottom edge grows the frame instead of
  // scrolling inside it: one scrollbar (the chat's), not two. Its grown
  // request is remembered while its own height is unchanged, so growing the
  // frame (which unpins it) cannot oscillate back to the short size.
  for (var j = -1; j < ompMeasure.scrollers.length; j++) {
    var s = j < 0 ? d : ompMeasure.scrollers[j];
    if (!s || s.scrollHeight <= s.clientHeight + 1) continue;
    if (j < 0 && !/^(?:scroll|auto)$/.test(getComputedStyle(s).overflowY)) continue;
    var sr = s.getBoundingClientRect();
    var pinned = sr.top <= 1 && Math.abs(sr.bottom - window.innerHeight) <= 1;
    var memo = ompMeasure.scrollerMemo.get(s);
    var grown;
    if (memo && Math.abs(memo[0] - sr.height) < 0.5) {
      grown = memo[1];
    } else if (pinned) {
      grown = window.innerHeight + s.scrollHeight - s.clientHeight;
      ompMeasure.scrollerMemo.set(s, [sr.height, grown]);
    } else {
      continue;
    }
    if (grown > v) v = grown;
  }
  // The page scrollbar exists only when the host caps the frame (content
  // taller than the card may occupy); a fitted card shows none.
  var overflow = v > window.innerHeight + 1;
  if (overflow !== ompMeasure.lastOverflow) {
    ompMeasure.lastOverflow = overflow;
    r.style.overflowY = overflow ? "auto" : "hidden";
  }
  return v;
}
function ompReportHeight() {
  try {
    var height = Math.ceil(ompMeasureHeight());
    if (height === ompMeasure.lastHeight) return;
    ompMeasure.lastHeight = height;
    parent.postMessage({ type: "musepi-widget-resize", mountId: window.DaimonCanvas && window.DaimonCanvas.mountId, height: height }, "*");
  } catch (err) {}
}
function ompScheduleReport() {
  if (ompMeasure.scheduled) return;
  // Timers, not requestAnimationFrame: a backgrounded tab/webview pauses rAF,
  // and a page that shrinks while hidden would keep its stale frame height
  // until it is shown again.
  ompMeasure.scheduled = setTimeout(function () {
    ompMeasure.scheduled = 0;
    ompReportHeight();
  }, 16);
}
window.musepiSubmit = function (text, data) {
  // One answer per card: the host drops repeats, and this keeps the face
  // from queueing them in the first place.
  if (window.musepiWidgetAnswered) return;
  try {
    parent.postMessage({ type: "musepi-widget-submit", text: String(text == null ? "" : text), data: data === undefined ? undefined : data }, "*");
  } catch (err) {}
};
window.addEventListener("load", function () { ompMeasure.dirty = 1; ompReportHeight(); });
window.addEventListener("resize", ompReportHeight);
if (window.ResizeObserver) {
  var ompResizeObserver = new ResizeObserver(ompReportHeight);
  ompResizeObserver.observe(document.documentElement);
  document.addEventListener("DOMContentLoaded", function () {
    if (document.body) ompResizeObserver.observe(document.body);
  });
}
new MutationObserver(function (records) {
  // Structural changes can add/remove scrollers (rescan); attribute changes
  // matter only for size-relevant ones — a stretched body does not resize
  // when its child shrinks, so ResizeObserver alone would miss it.
  for (var i = 0; i < records.length; i++) {
    if (records[i].type !== "attributes") {
      ompMeasure.dirty = 1;
      break;
    }
  }
  ompScheduleReport();
}).observe(document.documentElement, {
  subtree: true,
  childList: true,
  characterData: true,
  attributes: true,
  attributeFilter: ["style", "class", "hidden"],
});
// A focused frame keeps every key, so the app's Cmd/Ctrl shortcuts die while
// the page has focus. Pass on the chords the page left alone; clipboard,
// select-all and undo stay the page's own.
function ompForwardKey(e, kind) {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.isComposing) return;
  var t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ""))) return;
  if (kind === "down" && e.defaultPrevented) return;
  var k = String(e.key || "").toLowerCase();
  if (k === "c" || k === "v" || k === "x" || k === "a" || k === "z") return;
  try { parent.postMessage({ type: "musepi-widget-key", kind: kind, key: e.key, code: e.code, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey }, "*"); } catch (err) {}
}
window.addEventListener("keydown", function (e) { ompForwardKey(e, "down"); });
window.addEventListener("keyup", function (e) { ompForwardKey(e, "up"); });
// A page that fits its frame never scrolls inside; hand the wheel back so it
// scrolls the chat around the page. A page the host had to cap keeps its own
// scrollbar, and the wheel must scroll that page first — one scroller at a
// time, matching the height probe above.
function ompPageScrollable(deltaY) {
  var sc = document.scrollingElement;
  if (!sc || sc.scrollHeight <= sc.clientHeight + 1) return false;
  var atTop = sc.scrollTop <= 0;
  var atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 1;
  return !((deltaY < 0 && atTop) || (deltaY > 0 && atBottom));
}
function ompCanScroll(node, deltaY) {
  while (node && node.nodeType === 1) {
    var style = getComputedStyle(node);
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) {
      var atTop = node.scrollTop <= 0;
      var atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
      return !((deltaY < 0 && atTop) || (deltaY > 0 && atBottom));
    }
    node = node.parentElement;
  }
  return ompPageScrollable(deltaY);
}
window.addEventListener("wheel", function (e) {
  if (ompCanScroll(e.target, e.deltaY)) return;
  try { parent.postMessage({ type: "musepi-widget-wheel", deltaY: e.deltaY, deltaMode: e.deltaMode }, "*"); } catch (err) {}
}, { passive: true });
window.addEventListener("message", function (e) {
  var d = e.data;
  if (d && d.type === "musepi-widget-font" && typeof d.px === "number") {
    document.documentElement.style.fontSize = d.px + "px";
    document.documentElement.style.setProperty("--page-rem", d.px + "px");
    ompReportHeight();
  }
  if (d && d.type === "musepi-widget-answered") {
    window.musepiWidgetAnswered = true;
    // The answer the host accepted, so the face can render "you picked A"
    // instead of just going quiet. Mirrored onto a global (a face that boots
    // after the answer, e.g. a theme rebuild, reads it on load) and delivered
    // as an event (a face already running reacts without polling).
    var answer = { text: typeof d.text === "string" ? d.text : "", data: d.data };
    window.musepiWidgetAnswer = answer;
    window.__MUSEPI_ANSWER__ = answer;
    document.documentElement.setAttribute("data-musepi-answered", "1");
    try { document.documentElement.setAttribute("data-musepi-answer", answer.text); } catch (err) {}
    window.dispatchEvent(new CustomEvent("musepi-widget-answered", { detail: answer }));
  }
  if (d && d.type === "musepi-widget-data") {
    window.__WIDGET_DATA__ = d.data || {};
    window.musepiWidgetData = window.__WIDGET_DATA__;
    // Faces bound to the pre-rename event keep working.
    window.dispatchEvent(new CustomEvent("musepi-widget-data"));
    window.dispatchEvent(new CustomEvent("omp-widget-data"));
    try { parent.postMessage({ type: "musepi-widget-face-updated", canvasId: window.DaimonCanvas && window.DaimonCanvas.canvasId, mountId: window.DaimonCanvas && window.DaimonCanvas.mountId }, "*"); } catch (err) {}
  }
});
// 统一标注握手:宿主把 overlay 脚本经 postMessage 送进来(不透明源沙箱挡住
// 了宿主对 frame document 的直接访问,只能靠消息)。overlay 在 frame 内部
// 自己的 document 上跑,元素拾取/区域/绘制与内置浏览器是同一份实现。
//
// The host page's CSP allows 'unsafe-inline' but not 'unsafe-eval', and a
// srcdoc frame inherits it — eval here was silently blocked and the button
// did nothing. Inline script injection runs under 'unsafe-inline', so the
// overlay arrives the same way the face's own scripts do.
window.__musepiAnnotateRunning = false;
function musepiRunInline(source) {
  var script = document.createElement("script");
  script.textContent = source;
  var root = document.documentElement || document.head || document.body;
  root.appendChild(script);
  if (script.parentNode) script.parentNode.removeChild(script);
}
window.addEventListener("message", function (e) {
  var d = e.data;
  if (d && d.type === "musepi-widget-annotate" && typeof d.script === "string") {
    if (window.__musepiAnnotateRunning) return;
    window.__musepiAnnotateRunning = true;
    var done = function (payload) {
      window.__musepiAnnotateRunning = false;
      try { parent.postMessage({ type: "musepi-widget-annotated", payload: payload }, "*"); } catch (err) {}
    };
    var fail = function (reason) {
      try { parent.postMessage({ type: "musepi-widget-annotation-failed", reason: String(reason || "unknown") }, "*"); } catch (err) {}
      done(null);
    };
    try {
      // The overlay is a complete expression *statement* (it ends with its own
      // semicolon). Wrapping it in parentheses made a parse error, so the
      // script never assigned and the host reported "overlay did not start".
      // Trim the terminator before wrapping.
      var source = String(d.script).trimEnd().replace(/;+$/, "");
      musepiRunInline("window.__musepiAnnotationResult = (" + source + ");");
      var running = window.__musepiAnnotationResult;
      try { delete window.__musepiAnnotationResult; } catch (err) {}
      if (running && typeof running.then === "function") {
        // The host waits for this before calling the entry live: a script the
        // policy blocked never settles, and silence reads as a broken button.
        try { parent.postMessage({ type: "musepi-widget-annotation-started" }, "*"); } catch (err) {}
        running.then(done, function (reason) {
          fail((reason && reason.message) || reason || "overlay rejected");
        });
      } else {
        fail("overlay did not start");
      }
    } catch (err) { fail((err && err.message) || err); }
  }
  if (d && d.type === "musepi-widget-annotate-cancel" && typeof d.teardown === "string") {
    var wasRunning = window.__musepiAnnotateRunning;
    try { musepiRunInline(d.teardown); } catch (err) {}
    window.__musepiAnnotateRunning = false;
    // The overlay promise only settles when the user finishes, so a cancel
    // left the guard true and every later click was dropped silently — the
    // button turned into a no-op for the rest of the session. Report the
    // cancel so the host clears its own "annotating" state too.
    if (wasRunning) {
      try { parent.postMessage({ type: "musepi-widget-annotated", payload: null }, "*"); } catch (err) {}
    }
  }
});
</script>`;
}

export function HtmlCard({
	data,
	update,
	canvasId,
	mountId,
	interactive = true,
	sendPrompt,
	annotateCapture,
}: {
	data: Record<string, unknown>;
	update(patch: Record<string, unknown>): void;
	canvasId?: string;
	mountId?: string;
	/** Board canvas passes editMode; inline widgets keep interaction on. */
	interactive?: boolean;
	/** Submit a face's answer into the conversation as a user prompt.
	 * Absent in hosts that do not accept widget input (board canvas). */
	sendPrompt?: (text: string) => void;
	/** 统一标注(桌面渲染器提供卡片 rasterize 时才出现入口):宿主把卡片
	 * 拍成图,标注截图的合成由本组件完成。缺省时隐藏标注按钮。 */
	annotateCapture?: () => Promise<Blob | null>;
}): ReactNode {
	const raw = typeof data.html === "string" ? data.html : "";
	const oversize = raw.length > MAX_HTML;
	const frameRef = useRef<HTMLIFrameElement | null>(null);
	// One answer per card. Ref, not state: a re-render must not reopen the gate.
	const gateRef = useRef(createAnswerGate());
	/** The answer this card accepted. Kept so a REBUILT frame (theme flip
	 *  rewrites the srcdoc) can be told again — otherwise the settled state
	 *  vanishes on a light/dark switch and the face looks answerable again. */
	const answerRef = useRef<{ text: string; data?: unknown } | null>(null);
	// Theme-aware face: the srcdoc carries the host scheme so faces can
	// adapt; a MutationObserver rebuilds it when the scheme flips live.
	const [theme, setTheme] = useState<"dark" | "light">(widgetHostTheme);
	useEffect(() => {
		const root = document.documentElement;
		const mo = new MutationObserver(() => setTheme(widgetHostTheme()));
		mo.observe(root, { attributes: true, attributeFilter: ["data-theme", "data-color-scheme"] });
		return () => mo.disconnect();
	}, []);
	// 统一标注会话状态。srcdoc 重建(主题翻转/数据更新)会把 frame 里的
	// overlay 一起杀掉,宿主侧必须同步退出,否则按钮永远停在"标注中"。
	const [annotating, setAnnotating] = useState(false);
	useEffect(() => {
		setAnnotating(false);
	}, [data.data, theme, raw]);

	// The page's root size follows the chat body, so rem/em markup scales with
	// the interface size setting instead of the browser's 16px default.
	const baseFontPx =
		typeof document === "undefined"
			? 16
			: Math.round(Number.parseFloat(getComputedStyle(document.body).fontSize) || 16);
	const doc = useMemo(() => {
		if (!raw || oversize) return "";
		const payload = (data.data ?? {}) as Record<string, unknown>;
		const head =
			`<meta charset="utf-8">` +
			// No height:100% on html/body: the frame is sized to the page's own
			// content, and a viewport-height body made the report circular.
			`<style>html,body{margin:0;padding:0;box-sizing:border-box}*{box-sizing:border-box}` +
			// Native form controls / scrollbars follow the injected scheme.
			`html.musepi-theme-dark,html.omp-theme-dark{color-scheme:dark}` +
			`html.musepi-theme-light,html.omp-theme-light{color-scheme:light}` +
			// Readability floor for faces that don't set their own type — a
			// theme-matching text color (the #1 cause of "字体看不清" is model HTML
			// with no color: the iframe default black vanishes on the dark scheme).
			`html.musepi-theme-dark body,html.omp-theme-dark body{color:#e8e8ea}` +
			`html.musepi-theme-light body,html.omp-theme-light body{color:#1f2328}` +
			// The shared kit: base type, ready classes, readable controls.
			PAGE_KIT_CSS +
			`</style>`;
		const tokens = readFaceTokens();
		const boot = bootScript(canvasId ?? "", mountId ?? "", theme, tokens, baseFontPx);
		const bootData = `<script>window.__WIDGET_DATA__ = ${JSON.stringify(payload)};</script>`;
		return head + bootData + boot + raw;
	}, [raw, oversize, data.data, canvasId, mountId, theme, baseFontPx]);

	// Push data changes into the live frame (task refresh / editor edit).
	useEffect(() => {
		const frame = frameRef.current;
		if (!frame?.contentWindow || !raw) return;
		frame.contentWindow.postMessage(
			{ type: "musepi-widget-data", data: (data.data ?? {}) as Record<string, unknown> },
			"*",
		);
	}, [data.data, raw]);

	// Follow the interface size setting without rebuilding the frame (a rebuild
	// would drop the page's own script state).
	useEffect(() => {
		const frame = frameRef.current;
		if (!frame?.contentWindow || !raw) return;
		frame.contentWindow.postMessage({ type: "musepi-widget-font", px: baseFontPx }, "*");
	}, [baseFontPx, raw]);

	// ── 统一标注(与内置浏览器同一份 overlay,经 postMessage 握手进沙箱) ──

	/** The frame has to answer before the overlay counts as running: posting
	 *  blindly left a dead button when the bridge could not start (a blocked
	 *  script, a frame rebuilt mid-click). */
	const annotationProbeRef = useRef<number | null>(null);
	const [annotationError, setAnnotationError] = useState<string | null>(null);

	const clearAnnotationProbe = (): void => {
		if (annotationProbeRef.current !== null) {
			window.clearTimeout(annotationProbeRef.current);
			annotationProbeRef.current = null;
		}
	};

	const startCardAnnotation = (): void => {
		const frame = frameRef.current;
		if (!frame?.contentWindow || annotating) return;
		setAnnotationError(null);
		try {
			const overlayTheme: AnnotationOverlayTheme = resolveAnnotationOverlayTheme(theme);
			frame.contentWindow.postMessage(
				{
					type: "musepi-widget-annotate",
					script: buildAnnotationOverlayScript(overlayTheme, annotationOverlayLabels()),
				},
				"*",
			);
			setAnnotating(true);
			// Keys (Escape, the comment field) belong to the page once the overlay
			// is up; without this they stay on the host document.
			frame.focus();
		} catch (err) {
			// Building the overlay (theme tokens, labels) can fail on the host
			// side before anything is posted; say so instead of a dead button.
			setAnnotating(false);
			const reason = err instanceof Error ? err.message : String(err);
			console.warn("[musepi] annotation setup failed:", reason);
			setAnnotationError(`${t("annotation.startFailed")} (${reason})`);
			return;
		}
		clearAnnotationProbe();
		annotationProbeRef.current = window.setTimeout(() => {
			annotationProbeRef.current = null;
			setAnnotating(false);
			// Surfaced in place rather than silently: a blocked script is
			// invisible from here, and "the button does nothing" is not a
			// reportable bug.
			setAnnotationError(t("annotation.startFailed"));
		}, ANNOTATION_START_TIMEOUT_MS);
	};

	const cancelCardAnnotation = (): void => {
		clearAnnotationProbe();
		setAnnotationError(null);
		frameRef.current?.contentWindow?.postMessage(
			{ type: "musepi-widget-annotate-cancel", teardown: ANNOTATION_TEARDOWN_SCRIPT },
			"*",
		);
		setAnnotating(false);
	};

	/** overlay 的 payload 回来(或取消)后的收尾:校验 → 补页面信息 →
	 *  宿主截图 → 合成带标记的图 → 附图 + prompt 一起进 composer。 */
	const finishCardAnnotation = async (rawPayload: unknown): Promise<void> => {
		if (!isAnnotationPayload(rawPayload) || !annotateCapture) return;
		const frame = frameRef.current;
		if (!frame) return;
		// 沙箱里的 location 是 about:srcdoc,没有信息量;换成卡片身份。
		const payload = {
			...rawPayload,
			pageUrl: "",
			pageTitle: t("annotation.cardPageTitle"),
		};
		const overlayTheme = resolveAnnotationOverlayTheme(theme);
		const capture = await annotateCapture().catch(() => null);
		const screenshot = capture
			? await renderAnnotationScreenshotFromBlob({
					blob: capture,
					cssWidth: frame.clientWidth || payload.viewport.width,
					cssHeight: frame.clientHeight || payload.viewport.height,
					payload,
					accentColor: overlayTheme.primary,
					accentFill: overlayTheme.primarySoft,
				})
			: null;
		await dispatchAnnotationResult({ payload, screenshot, intro: t("annotation.cardIntro") });
	};
	// 消息监听只注册一次([raw] 依赖),经 ref 拿最新实现,避免闭包陈旧。
	const finishCardAnnotationRef = useRef(finishCardAnnotation);
	finishCardAnnotationRef.current = finishCardAnnotation;

	// 标注完成(含 frame 内取消):来源必须是本卡 frame —— 与
	// readWidgetFaceMessage 同一道来源校验,邻居卡片发来的同形消息不能替
	// 这张卡收尾。
	useEffect(() => {
		if (!raw) return;
		const onMsg = (e: MessageEvent): void => {
			if (e.source !== (frameRef.current?.contentWindow ?? null)) return;
			const annotated = e.data as { type?: string; payload?: unknown; reason?: string } | null;
			if (annotated?.type === "musepi-widget-annotation-started") {
				clearAnnotationProbe();
				return;
			}
			if (annotated?.type === "musepi-widget-annotation-failed") {
				clearAnnotationProbe();
				setAnnotating(false);
				const reason = annotated.reason ?? "unknown";
				console.warn("[musepi] annotation overlay failed:", reason);
				setAnnotationError(`${t("annotation.startFailed")} (${reason})`);
				return;
			}
			if (annotated?.type !== "musepi-widget-annotated") return;
			clearAnnotationProbe();
			setAnnotating(false);
			void finishCardAnnotationRef.current(annotated.payload);
		};
		window.addEventListener("message", onMsg);
		return () => {
			window.removeEventListener("message", onMsg);
			clearAnnotationProbe();
		};
	}, [raw]);

	// The sandbox face reports its content height (musepi-widget-resize) so the
	// iframe grows to fit instead of clamping to the 320px inline floor —
	// tall faces stop being cut off, short faces stop leaving dead space.
	// The measured height is remembered per page (keyed by its own bytes), so
	// a virtualized transcript that unmounts a card and mounts it again
	// restores the size instead of growing from the floor under the reader.
	const frameKey = useMemo(() => (raw ? `${raw.length}:${fnv1a(raw)}` : ""), [raw]);
	const [frameHeight, setFrameHeight] = useState<number | null>(() =>
		frameKey ? (rememberedFrameHeights.get(frameKey) ?? null) : null,
	);
	// Nothing is painted until the page has laid out once: a dark-theme frame
	// briefly shows the browser's white canvas when the timeline remounts it.
	const [frameReady, setFrameReady] = useState(false);
	useEffect(() => {
		setFrameHeight(frameKey ? (rememberedFrameHeights.get(frameKey) ?? null) : null);
	}, [frameKey]);
	useEffect(() => {
		if (!raw) return;
		const onMsg = (e: MessageEvent): void => {
			const frame = frameRef.current;
			if (e.source !== (frame?.contentWindow ?? null)) return;
			const kind = (e.data as { type?: string } | null)?.type;
			if (kind === "musepi-widget-key") {
				if (!frame) return;
				const k = e.data as {
					kind?: string;
					key?: string;
					code?: string;
					ctrl?: boolean;
					meta?: boolean;
					shift?: boolean;
					alt?: boolean;
				};
				if (k.kind !== "down" && k.kind !== "up") return;
				// Replay the chord on the frame element: the app's shortcut
				// handling listens on window and sees an ordinary key outside any
				// text field, so no per-shortcut list has to stay in sync.
				frame.dispatchEvent(
					new KeyboardEvent(k.kind === "down" ? "keydown" : "keyup", {
						key: String(k.key ?? ""),
						code: String(k.code ?? ""),
						ctrlKey: k.ctrl === true,
						metaKey: k.meta === true,
						shiftKey: k.shift === true,
						altKey: k.alt === true,
						bubbles: true,
						cancelable: true,
						composed: true,
					}),
				);
				return;
			}
			if (kind === "musepi-widget-wheel") {
				if (!frame) return;
				const w = e.data as { deltaY?: number; deltaMode?: number };
				const deltaY = typeof w.deltaY === "number" ? w.deltaY : 0;
				if (deltaY === 0) return;
				// deltaMode 1 is lines, 2 is pages.
				const step = w.deltaMode === 1 ? 16 : w.deltaMode === 2 ? frame.clientHeight : 1;
				frame.dispatchEvent(
					new WheelEvent("wheel", {
						deltaY: deltaY * step,
						deltaMode: 0,
						bubbles: true,
						cancelable: true,
					}),
				);
				return;
			}
			const msg = readWidgetFaceMessage(e.source, frame?.contentWindow ?? null, e.data);
			if (msg?.kind === "resize") {
				const height = Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, msg.height));
				if (frameKey) rememberFrameHeight(frameKey, height);
				setFrameReady(true);
				setFrameHeight(prev => (prev === height ? prev : height));
			} else if (msg?.kind === "submit") {
				const claimed = gateRef.current.claim(msg.text);
				if (claimed === null) return;
				const answer = { text: claimed, ...(msg.data !== undefined ? { data: msg.data } : {}) };
				answerRef.current = answer;
				sendPrompt?.(claimed);
				// Tell the face so it can render a settled state; the injected
				// stylesheet dims its controls whether or not it listens.
				frameRef.current?.contentWindow?.postMessage({ type: "musepi-widget-answered", ...answer }, "*");
			}
		};
		window.addEventListener("message", onMsg);
		return () => window.removeEventListener("message", onMsg);
	}, [raw, sendPrompt]);

	const headSlot = useContext(WidgetHeadActionsSlot);
	if (!raw || oversize) {
		return <div className="gui-widget-html-empty">html</div>;
	}
	// The annotation entry sits with the card's other head actions. A face
	// outside a card (board canvas, export) has no slot and keeps its own row.
	const annotateAction = annotateCapture ? (
		<button
			type="button"
			className={`gui-widget-annotate-btn${annotating ? " gui-widget-annotate-btn--active" : ""}`}
			title={annotating ? t("annotation.stop") : t("annotation.toggle")}
			aria-label={annotating ? t("annotation.stop") : t("annotation.toggle")}
			aria-pressed={annotating}
			onClick={() => (annotating ? cancelCardAnnotation() : startCardAnnotation())}
		>
			<MorphIcon icon={annotating ? XIconData : PencilIconData} size={12} spring="snappy" />
		</button>
	) : null;
	return (
		<div className="gui-widget-html-wrap">
			{annotateAction ? (
				headSlot ? (
					createPortal(annotateAction, headSlot)
				) : (
					// Board canvas / HTML export: no card head to portal into, so the
					// entry keeps its own row above the page.
					<div className="gui-widget-html-tools">{annotateAction}</div>
				)
			) : null}
			<iframe
				ref={frameRef}
				className="gui-widget-html"
				title="widget"
				sandbox="allow-scripts"
				srcDoc={doc}
				// A rebuilt frame (theme flip rewrites the srcdoc) starts blank;
				// replay the accepted answer so the face still shows its settled
				// state instead of looking answerable again.
				onLoad={() => {
					// The page has painted something of its own by now (or its
					// script will report a height immediately).
					setFrameReady(true);
					const answer = answerRef.current;
					if (answer)
						frameRef.current?.contentWindow?.postMessage({ type: "musepi-widget-answered", ...answer }, "*");
				}}
				style={{
					height: frameHeight !== null ? `${frameHeight}px` : undefined,
					// A remount under a dark theme flashes the frame's white canvas
					// before the page paints; hold the space at its remembered
					// height and reveal on the first load or size report.
					opacity: frameReady ? 1 : 0,
					transition: "opacity 120ms ease-out",
					...(interactive ? {} : { pointerEvents: "none" }),
				}}
			/>
			{annotationError && (
				<div className="gui-widget-html-error" role="status">
					{annotationError}
				</div>
			)}
		</div>
	);
}
