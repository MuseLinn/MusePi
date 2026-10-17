import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

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
 * - **Answer channel**: the face hands a choice back to the conversation
 *   with `musepiSubmit(text, data)` - the host turns it into a user
 *   prompt, the same path every other interactive widget uses.
 *   Non-blocking by design: the agent's turn is over by the time the
 *   user clicks, and the answer arrives as the next user message. A
 *   question that must *hold* the turn open is the `ask` tool's job.
 *   This is a prompt-injection surface - model-authored JS can now put
 *   text into the agent's context - so the host bounds it: the message
 *   source must be this card's own frame, and the text is capped.
 *
 * The card is interactive by default (buttons/sliders inside the face);
 * the board canvas disables iframe pointer-events while in edit mode so
 * cards stay draggable (kimi's draft-mode behavior).
 */

/** Declared but previously never enforced. Model-authored markup that can
 * now answer is context-injection surface, so it gets a real bound rather
 * than a decorative constant. */
const MAX_HTML = 64_000;
/** Ceiling on what one face may say into the conversation. */
const MAX_SUBMIT_TEXT = 8_000;

/** What a sandbox face is allowed to ask the host for. */
export type WidgetFaceMessage =
	| { kind: "resize"; height: number }
	| { kind: "submit"; text: string };

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
	const d = raw as { type?: string; height?: number; text?: string } | null;
	if (!d || typeof d !== "object") return null;
	if (d.type === "musepi-widget-resize" && typeof d.height === "number") {
		return { kind: "resize", height: d.height };
	}
	if (d.type === "musepi-widget-submit" && typeof d.text === "string" && d.text.length > 0) {
		return { kind: "submit", text: d.text.slice(0, MAX_SUBMIT_TEXT) };
	}
	return null;
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

function bootScript(canvasId: string, mountId: string, theme: "dark" | "light"): string {
	return `<script>
document.documentElement.className = "musepi-theme-${theme} omp-theme-${theme}";
window.__WIDGET_THEME__ = ${JSON.stringify(theme)};
window.__WIDGET_DATA__ = window.__WIDGET_DATA__ || {};
// The payload script runs before this one, so alias it rather than
// starting a second object - the two globals must not diverge.
window.musepiWidgetData = window.__WIDGET_DATA__;
window.DaimonCanvas = window.DaimonCanvas || { canvasId: ${JSON.stringify(canvasId)}, mountId: ${JSON.stringify(mountId)} };
function ompReportHeight() {
  try {
    parent.postMessage({ type: "musepi-widget-resize", mountId: window.DaimonCanvas && window.DaimonCanvas.mountId, height: document.documentElement.scrollHeight }, "*");
  } catch (err) {}
}
window.musepiSubmit = function (text, data) {
  try {
    parent.postMessage({ type: "musepi-widget-submit", text: String(text == null ? "" : text), data: data === undefined ? undefined : data }, "*");
  } catch (err) {}
};
window.addEventListener("load", ompReportHeight);
window.addEventListener("resize", ompReportHeight);
new MutationObserver(ompReportHeight).observe(document.documentElement, { subtree: true, childList: true, attributes: true });
window.addEventListener("message", function (e) {
  var d = e.data;
  if (d && d.type === "musepi-widget-data") {
    window.__WIDGET_DATA__ = d.data || {};
    window.musepiWidgetData = window.__WIDGET_DATA__;
    // Faces bound to the pre-rename event keep working.
    window.dispatchEvent(new CustomEvent("musepi-widget-data"));
    window.dispatchEvent(new CustomEvent("omp-widget-data"));
    try { parent.postMessage({ type: "musepi-widget-face-updated", canvasId: window.DaimonCanvas && window.DaimonCanvas.canvasId, mountId: window.DaimonCanvas && window.DaimonCanvas.mountId }, "*"); } catch (err) {}
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
}): ReactNode {
	const raw = typeof data.html === "string" ? data.html : "";
	const oversize = raw.length > MAX_HTML;
	const frameRef = useRef<HTMLIFrameElement | null>(null);
	// Theme-aware face: the srcdoc carries the host scheme so faces can
	// adapt; a MutationObserver rebuilds it when the scheme flips live.
	const [theme, setTheme] = useState<"dark" | "light">(widgetHostTheme);
	useEffect(() => {
		const root = document.documentElement;
		const mo = new MutationObserver(() => setTheme(widgetHostTheme()));
		mo.observe(root, { attributes: true, attributeFilter: ["data-theme", "data-color-scheme"] });
		return () => mo.disconnect();
	}, []);

	const doc = useMemo(() => {
		if (!raw || oversize) return "";
		const payload = (data.data ?? {}) as Record<string, unknown>;
		const head =
			`<meta charset="utf-8">` +
			`<style>html,body{margin:0;padding:0;height:100%;box-sizing:border-box}*{box-sizing:border-box}` +
			// Native form controls / scrollbars follow the injected scheme.
			`html.musepi-theme-dark,html.omp-theme-dark{color-scheme:dark}` +
			`html.musepi-theme-light,html.omp-theme-light{color-scheme:light}` +
			// Readability floor for faces that don't set their own type —
			// 14px base + relaxed line-height + a theme-matching text color
			// (the #1 cause of "字体看不清" is model HTML with no color:
			// the iframe default black vanishes on the dark scheme).
			`html.musepi-theme-dark body,html.omp-theme-dark body{color:#e8e8ea}` +
			`html.musepi-theme-light body,html.omp-theme-light body{color:#1f2328}` +
			`html.musepi-theme-dark body,html.musepi-theme-light body{font-size:14px;line-height:1.6}</style>`;
		const boot = bootScript(canvasId ?? "", mountId ?? "", theme);
		const bootData = `<script>window.__WIDGET_DATA__ = ${JSON.stringify(payload)};</script>`;
		return head + bootData + boot + raw;
	}, [raw, oversize, data.data, canvasId, mountId, theme]);

	// Push data changes into the live frame (task refresh / editor edit).
	useEffect(() => {
		const frame = frameRef.current;
		if (!frame?.contentWindow || !raw) return;
		frame.contentWindow.postMessage(
			{ type: "musepi-widget-data", data: (data.data ?? {}) as Record<string, unknown> },
			"*",
		);
	}, [data.data, raw]);

	// The sandbox face reports its content height (musepi-widget-resize) so the
	// iframe grows to fit instead of clamping to the 320px inline floor —
	// tall faces stop being cut off, short faces stop leaving dead space.
	const [frameHeight, setFrameHeight] = useState<number | null>(null);
	useEffect(() => {
		if (!raw) return;
		const onMsg = (e: MessageEvent): void => {
			const msg = readWidgetFaceMessage(e.source, frameRef.current?.contentWindow ?? null, e.data);
			if (msg?.kind === "resize") {
				setFrameHeight(prev => (prev === msg.height ? prev : msg.height));
			} else if (msg?.kind === "submit") {
				sendPrompt?.(msg.text);
			}
		};
		window.addEventListener("message", onMsg);
		return () => window.removeEventListener("message", onMsg);
	}, [raw, sendPrompt]);

	if (!raw || oversize) {
		return <div className="gui-widget-html-empty">html</div>;
	}
	return (
		<iframe
			ref={frameRef}
			className="gui-widget-html"
			title="widget"
			sandbox="allow-scripts"
			srcDoc={doc}
			style={{
				height: frameHeight !== null ? `${frameHeight}px` : undefined,
				...(interactive ? {} : { pointerEvents: "none" }),
			}}
		/>
	);
}
