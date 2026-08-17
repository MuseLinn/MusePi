import type { ReactNode } from "react";
import { useEffect, useMemo, useRef } from "react";

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
 *
 * The card is interactive by default (buttons/sliders inside the face);
 * the board canvas disables iframe pointer-events while in edit mode so
 * cards stay draggable (kimi's draft-mode behavior).
 */

const MAX_HTML = 64_000;

export function htmlDefaults(): Record<string, unknown> {
	return { html: "", data: {} };
}

function bootScript(canvasId: string, mountId: string): string {
	return `<script>
window.__WIDGET_DATA__ = window.__WIDGET_DATA__ || {};
window.DaimonCanvas = window.DaimonCanvas || { canvasId: ${JSON.stringify(canvasId)}, mountId: ${JSON.stringify(mountId)} };
window.addEventListener("message", function (e) {
  var d = e.data;
  if (d && d.type === "omp-widget-data") {
    window.__WIDGET_DATA__ = d.data || {};
    window.dispatchEvent(new CustomEvent("omp-widget-data"));
    try { parent.postMessage({ type: "omp-widget-face-updated", canvasId: window.DaimonCanvas && window.DaimonCanvas.canvasId, mountId: window.DaimonCanvas && window.DaimonCanvas.mountId }, "*"); } catch (err) {}
  }
});
<\/script>`;
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

	const doc = useMemo(() => {
		if (!raw) return "";
		const payload = (data.data ?? {}) as Record<string, unknown>;
		const head =
			`<meta charset="utf-8">` +
			`<style>html,body{margin:0;padding:0;height:100%;box-sizing:border-box}*{box-sizing:border-box}</style>`;
		const boot = bootScript(canvasId ?? "", mountId ?? "");
		const bootData = `<script>window.__WIDGET_DATA__ = ${JSON.stringify(payload)};<\/script>`;
		return head + bootData + boot + raw;
	}, [raw, data.data, canvasId, mountId]);

	// Push data changes into the live frame (task refresh / editor edit).
	useEffect(() => {
		const frame = frameRef.current;
		if (!frame?.contentWindow || !raw) return;
		frame.contentWindow.postMessage(
			{ type: "omp-widget-data", data: (data.data ?? {}) as Record<string, unknown> },
			"*",
		);
	}, [data.data, raw]);

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
			style={interactive ? undefined : { pointerEvents: "none" }}
		/>
	);
}
