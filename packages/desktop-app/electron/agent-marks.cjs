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

module.exports = { AGENT_MARK_MS, agentMarkFor };
