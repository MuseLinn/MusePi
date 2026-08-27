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
 *   and every data change is pushed via postMessage (`omp-widget-data`)
 *   so a widget refreshed by a task re-renders without reloading.
 * - `window.DaimonCanvas = { canvasId, mountId }` mirrors kimi's host
 *   globals for faces that want to know where they live.
 * - **Theme adaptation (深浅色热切换)**: the host's resolved scheme is
 *   injected as `window.__WIDGET_THEME__` ("dark" | "light") and mirrored
 *   on the sandbox root as `class="omp-theme-dark|light"`, so faces can
 *   provide two palettes via `html.omp-theme-light body { … }` or JS.
 *   A MutationObserver on the host `<html data-theme>` rebuilds the
 *   srcdoc when the scheme flips, so the face follows the GUI's live
 *   light/dark toggle (widget.md's 铁律: faces must adapt, never ship a
 *   single fixed palette that loses contrast on the other scheme).
 *
 * The card is interactive by default (buttons/sliders inside the face);
 * the board canvas disables iframe pointer-events while in edit mode so
 * cards stay draggable (kimi's draft-mode behavior).
 */

const MAX_HTML = 64_000;

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
document.documentElement.className = "omp-theme-${theme}";
window.__WIDGET_THEME__ = ${JSON.stringify(theme)};
window.__WIDGET_DATA__ = window.__WIDGET_DATA__ || {};
window.DaimonCanvas = window.DaimonCanvas || { canvasId: ${JSON.stringify(canvasId)}, mountId: ${JSON.stringify(mountId)} };
function ompReportHeight() {
  try {
    parent.postMessage({ type: "omp-widget-resize", mountId: window.DaimonCanvas && window.DaimonCanvas.mountId, height: document.documentElement.scrollHeight }, "*");
  } catch (err) {}
}
window.addEventListener("load", ompReportHeight);
window.addEventListener("resize", ompReportHeight);
new MutationObserver(ompReportHeight).observe(document.documentElement, { subtree: true, childList: true, attributes: true });
window.addEventListener("message", function (e) {
  var d = e.data;
  if (d && d.type === "omp-widget-data") {
    window.__WIDGET_DATA__ = d.data || {};
    window.dispatchEvent(new CustomEvent("omp-widget-data"));
    try { parent.postMessage({ type: "omp-widget-face-updated", canvasId: window.DaimonCanvas && window.DaimonCanvas.canvasId, mountId: window.DaimonCanvas && window.DaimonCanvas.mountId }, "*"); } catch (err) {}
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
}: {
	data: Record<string, unknown>;
	update(patch: Record<string, unknown>): void;
	canvasId?: string;
	mountId?: string;
	/** Board canvas passes editMode; inline widgets keep interaction on. */
	interactive?: boolean;
}): ReactNode {
	const raw = typeof data.html === "string" ? data.html : "";
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
		if (!raw) return "";
		const payload = (data.data ?? {}) as Record<string, unknown>;
		const head =
			`<meta charset="utf-8">` +
			`<style>html,body{margin:0;padding:0;height:100%;box-sizing:border-box}*{box-sizing:border-box}` +
			// Native form controls / scrollbars follow the injected scheme.
			`html.omp-theme-dark{color-scheme:dark}html.omp-theme-light{color-scheme:light}` +
			// Readability floor for faces that don't set their own type —
			// 14px base + relaxed line-height + a theme-matching text color
			// (the #1 cause of "字体看不清" is model HTML with no color:
			// the iframe default black vanishes on the dark scheme).
			`html.omp-theme-dark body{color:#e8e8ea}html.omp-theme-light body{color:#1f2328}` +
			`html.omp-theme-dark body,html.omp-theme-light body{font-size:14px;line-height:1.6}</style>`;
		const boot = bootScript(canvasId ?? "", mountId ?? "", theme);
		const bootData = `<script>window.__WIDGET_DATA__ = ${JSON.stringify(payload)};</script>`;
		return head + bootData + boot + raw;
	}, [raw, data.data, canvasId, mountId, theme]);

	// Push data changes into the live frame (task refresh / editor edit).
	useEffect(() => {
		const frame = frameRef.current;
		if (!frame?.contentWindow || !raw) return;
		frame.contentWindow.postMessage(
			{ type: "omp-widget-data", data: (data.data ?? {}) as Record<string, unknown> },
			"*",
		);
	}, [data.data, raw]);

	// The sandbox face reports its content height (omp-widget-resize) so the
	// iframe grows to fit instead of clamping to the 320px inline floor —
	// tall faces stop being cut off, short faces stop leaving dead space.
	const [frameHeight, setFrameHeight] = useState<number | null>(null);
	useEffect(() => {
		if (!raw) return;
		const onMsg = (e: MessageEvent): void => {
			const d = e.data as { type?: string; height?: number } | null;
			if (d?.type === "omp-widget-resize" && typeof d.height === "number") {
				const height = d.height;
				setFrameHeight(prev => (prev === height ? prev : height));
			}
		};
		window.addEventListener("message", onMsg);
		return () => window.removeEventListener("message", onMsg);
	}, [raw]);

	if (!raw) {
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
