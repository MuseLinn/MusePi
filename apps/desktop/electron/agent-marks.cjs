"use strict";

/**
 * Agent operation marks for the managed browser panel.
 *
 * The agent drives the page over CDP, so the only trustworthy ground truth is
 * the input the agent dispatches: a press carries the CSS-pixel point it hit,
 * a wheel event carries the point it scrolled. Deriving marks from those keeps
 * this layer free of page injection and of anything the page could forge.
 */

/** How long one mark stays on the page before the panel clears it. */
const AGENT_MARK_MS = 1100;

/** CDP command → one visual mark, or null when the command leaves no trace. */
function agentMarkFor(method, params) {
	if (method !== "Input.dispatchMouseEvent") return null;
	const type = params?.type;
	if (type !== "mousePressed" && type !== "mouseWheel") return null;
	if (typeof params.x !== "number" || typeof params.y !== "number") return null;
	if (!Number.isFinite(params.x) || !Number.isFinite(params.y)) return null;
	return { x: params.x, y: params.y, kind: type === "mouseWheel" ? "scroll" : "click" };
}

/**
 * Injected once per document: a fixed-position layer that pulses a ring at an
 * agent action point. Lives in the page so it paints above the guest's own
 * content; the layer is pointer-events:none and names nothing about the page.
 */
const AGENT_MARK_SCRIPT = `(() => {
  const KEY = "__musepiAgentMarks";
  // Re-runs after navigation and in a re-created document: reuse whatever layer
  // exists instead of returning early, and never close over a detached one.
  let layer = document.getElementById("musepi-agent-marks");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "musepi-agent-marks";
    layer.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647;";
    const style = document.createElement("style");
    style.textContent = "@keyframes musepi-agent-mark{from{opacity:.95;transform:scale(.45)}to{opacity:0;transform:scale(1.7)}}";
    document.documentElement.appendChild(style);
    document.documentElement.appendChild(layer);
  }
  const show = (mark) => {
    if (!mark || typeof mark.x !== "number" || typeof mark.y !== "number") return;
    const ring = document.createElement("span");
    ring.style.cssText =
      "position:fixed;box-sizing:border-box;width:22px;height:22px;border:2px solid #3b82f6;border-radius:50%;pointer-events:none;" +
      "left:" + (mark.x - 11) + "px;top:" + (mark.y - 11) + "px;" +
      (mark.kind === "scroll" ? "border-style:dashed;" : "") +
      "animation:musepi-agent-mark 780ms ease-out both;";
    (document.getElementById("musepi-agent-marks") || layer).appendChild(ring);
    setTimeout(() => ring.remove(), 900);
  };
  const paths = (points) => {
    if (!Array.isArray(points) || points.length < 2) return;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.style.cssText = "position:fixed;left:0;top:0;pointer-events:none;";
    const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    line.setAttribute("points", points.map(([x, y]) => x + "," + y).join(" "));
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", "#3b82f6");
    line.setAttribute("stroke-width", "2");
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("stroke-linejoin", "round");
    line.setAttribute("stroke-dasharray", "6 4");
    line.style.cssText = "filter:drop-shadow(0 0 3px rgba(59,130,246,.65));animation:musepi-agent-mark 1100ms ease-out both;";
    svg.appendChild(line);
    (document.getElementById("musepi-agent-marks") || layer).appendChild(svg);
    setTimeout(() => svg.remove(), 1200);
  };
  window[KEY] = show;
  window.__musepiAgentPaths = paths;
})();`;

/** JavaScript that calls the injected marker with one JSON-safe mark. */
function agentMarkCall(mark) {
	return `window.__musepiAgentMarks && window.__musepiAgentMarks(${JSON.stringify({
		x: Math.round(mark.x),
		y: Math.round(mark.y),
		kind: mark.kind,
	})});`;
}

/** One CDP mouse step that belongs to a drag; null for everything else. */
function agentDragStep(method, params) {
	if (method !== "Input.dispatchMouseEvent") return null;
	const type = params?.type;
	const x = params?.x;
	const y = params?.y;
	if (typeof x !== "number" || typeof y !== "number") return null;
	if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
	if (type === "mousePressed") return { phase: "start", x, y };
	// `buttons` is a bitmask; bit 0 is the primary button.
	if (type === "mouseMoved" && (Number(params?.buttons) & 1) === 1) return { phase: "move", x, y };
	if (type === "mouseReleased") return { phase: "end", x, y };
	return null;
}

/** Call the injected path painter with rounded CSS-pixel points. */
function agentPathCall(points) {
	const rounded = points.map(point => [Math.round(point.x), Math.round(point.y)]);
	return `window.__musepiAgentPaths && window.__musepiAgentPaths(${JSON.stringify(rounded)});`;
}

module.exports = {
	AGENT_MARK_MS,
	AGENT_MARK_SCRIPT,
	agentDragStep,
	agentMarkCall,
	agentMarkFor,
	agentPathCall,
};
