import { createRoot } from "react-dom/client";
import { App } from "./app";
import { initTooltips } from "./lib/tooltips";
import { shellPlatform } from "./lib/electron";
import "@musepi/desktop-web/src/styles/tokens.css";
import "@musepi/desktop-web/src/styles/base.css";
import "@musepi/desktop-web/src/components/shell/shell.css";
import "@musepi/desktop-web/src/components/transcript/transcript.css";
import "@musepi/desktop-web/src/components/agents/agents.css";
import "@musepi/desktop-web/src/tool-render/tool-render.css";
import "./styles/fonts.css";
import "./styles/gui.css";
import "./styles/gui-taskcenter.css";
import "./styles/tailwind.out.css";

// ── Renderer error capture (掉线诊断): a renderer-side failure kills the
// daemon WebSocket with it (the "前后端掉线" report); without a trace the
// drop is a black box. Keep a bounded ring of uncaught errors/rejections
// in localStorage so the broken state (blank sidebar, streaming 错位) can
// be traced after the fact. main.cjs auto-reloads the window on
// render-process-gone; this log survives the reload.
const ERROR_LOG_KEY = "musepi-gui-error-log";
function captureRenderError(kind: "error" | "rejection", detail: string): void {
	console.error(`[gui] uncaught ${kind}:`, detail);
	try {
		const ring = JSON.parse(localStorage.getItem(ERROR_LOG_KEY) ?? "[]") as string[];
		ring.push(`${new Date().toISOString()} ${kind}: ${detail}`);
		if (ring.length > 100) ring.splice(0, ring.length - 100);
		localStorage.setItem(ERROR_LOG_KEY, JSON.stringify(ring));
	} catch {
		// storage unavailable — the console trace above still stands
	}
}
window.addEventListener("error", event => captureRenderError("error", event.message));
window.addEventListener("unhandledrejection", event => {
	const reason = event.reason;
	captureRenderError(
		"rejection",
		reason instanceof Error ? `${reason.message}\n${reason.stack ?? ""}` : String(reason),
	);
});

// Unified tooltip layer: replace native `title` tooltips (clipped at the
// window edge in Electron) with one clamped floating tooltip.
initTooltips();

// Platform hook for CSS overrides (e.g. Windows has no macOS traffic
// lights, so the 84px left clearance is wasted space there).
document.documentElement.dataset.platform = shellPlatform();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(<App />);
