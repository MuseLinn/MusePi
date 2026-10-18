import { MAX_WIDGET_HTML } from "@musepi/pi-utils";
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
 * - **Injected component kit**: `.musepi-options` / `.musepi-option` /
 *   `.musepi-button` plus the host's own `--bg` / `--fg` / `--accent` /
 *   `--border` / `--radius-*` values, so a "pick one" face does not have
 *   to hand-write a component or invent a palette. The sandbox is a null
 *   origin, so these are resolved host-side and shipped in; a face that
 *   uses `var(--bg)` without them gets nothing.
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
	"--color-success",
	"--color-danger",
	"--radius-sm",
	"--radius-md",
	"--radius-lg",
] as const;

export function readFaceTokens(): Record<string, string> {
	if (typeof document === "undefined") return {};
	const computed = getComputedStyle(document.documentElement);
	const out: Record<string, string> = {};
	for (const name of FACE_TOKENS) {
		const value = computed.getPropertyValue(name).trim();
		if (value) out[name] = value;
	}
	return out;
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

function bootScript(
	canvasId: string,
	mountId: string,
	theme: "dark" | "light",
	tokens: Record<string, string>,
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
window.musepiWidgetTokens = ${JSON.stringify(tokens)};
window.DaimonCanvas = window.DaimonCanvas || { canvasId: ${JSON.stringify(canvasId)}, mountId: ${JSON.stringify(mountId)} };
function ompReportHeight() {
  try {
    parent.postMessage({ type: "musepi-widget-resize", mountId: window.DaimonCanvas && window.DaimonCanvas.mountId, height: document.documentElement.scrollHeight }, "*");
  } catch (err) {}
}
window.musepiSubmit = function (text, data) {
  // One answer per card: the host drops repeats, and this keeps the face
  // from queueing them in the first place.
  if (window.musepiWidgetAnswered) return;
  try {
    parent.postMessage({ type: "musepi-widget-submit", text: String(text == null ? "" : text), data: data === undefined ? undefined : data }, "*");
  } catch (err) {}
};
window.addEventListener("load", ompReportHeight);
window.addEventListener("resize", ompReportHeight);
new MutationObserver(ompReportHeight).observe(document.documentElement, { subtree: true, childList: true, attributes: true });
window.addEventListener("message", function (e) {
  var d = e.data;
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
			`html.musepi-theme-dark body,html.musepi-theme-light body{font-size:14px;line-height:1.6}` +
			// Option cards and a primary button, so a "pick one" face does not have
			// to hand-write a whole component. Values come from the injected
			// --bg/--fg/--accent vars, which the host resolves for this scheme.
			`.musepi-options{display:grid;gap:10px;grid-template-columns:1fr}` +
			`@media (min-width:560px){.musepi-options[data-columns="2"]{grid-template-columns:1fr 1fr}}` +
			`.musepi-option{display:flex;flex-direction:column;gap:4px;width:100%;text-align:left;` +
			`padding:11px 13px;border-radius:calc(var(--radius-lg,10px) * 1.2);cursor:pointer;` +
			`font:inherit;color:inherit;` +
			`background:var(--bg-raised);border:1px solid var(--border);}` +
			`.musepi-option:hover{border-color:var(--border-strong)}` +
			`.musepi-option[aria-pressed="true"]{border-color:var(--accent);` +
			`box-shadow:inset 0 0 0 1px var(--accent)}` +
			`.musepi-option-sub{color:var(--fg-muted);font-size:12.5px;line-height:1.5}` +
			`.musepi-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;` +
			`padding:7px 14px;border-radius:var(--radius-md,6px);cursor:pointer;font:inherit;` +
			`background:var(--accent);border:0}` +
			// Answered: the host sent musepi-widget-answered, so this card already
			// reached the conversation. Dim and stop taking clicks even if the face
			// ignores the event — a second answer would be a duplicate user message.
			`html[data-musepi-answered] .musepi-option,` +
			`html[data-musepi-answered] .musepi-button,` +
			`html[data-musepi-answered] button,` +
			`html[data-musepi-answered] [role="button"]{opacity:.5;pointer-events:none;cursor:default}` +
			`</style>`;
		const tokens = readFaceTokens();
		const boot = bootScript(canvasId ?? "", mountId ?? "", theme, tokens);
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
			// A rebuilt frame (theme flip rewrites the srcdoc) starts blank;
			// replay the accepted answer so the face still shows its settled
			// state instead of looking answerable again.
			onLoad={() => {
				const answer = answerRef.current;
				if (answer)
					frameRef.current?.contentWindow?.postMessage({ type: "musepi-widget-answered", ...answer }, "*");
			}}
			style={{
				height: frameHeight !== null ? `${frameHeight}px` : undefined,
				...(interactive ? {} : { pointerEvents: "none" }),
			}}
		/>
	);
}
