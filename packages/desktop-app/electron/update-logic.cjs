/**
 * Pure updater logic — no electron / electron-updater imports, so it is
 * directly unit-testable (test/update-logic.test.ts) from plain bun test.
 *
 * Two concerns live here:
 *   1. Failure classification: a raw updater error → a stable semantic kind
 *      ({check|download|install} × {network|other}), dsh
 *      update-presentation.ts parity. The renderer maps the kind to
 *      localized copy; the raw message travels as technicalDetails.
 *   2. Poll backoff: fixed-interval scheduling with ×2 failure backoff
 *      (capped) and ±jitter, dsh update-schedule.ts parity.
 */
"use strict";

/** Semantic failure operations (one updater phase each). */
const UPDATE_OPERATIONS = ["check", "download", "install"];

/** dsh update-presentation.ts NETWORK_FAILURE — Windows/Chromium socket
 *  codes plus the generic Node "fetch failed" wrapper and obvious network
 *  wording. Heuristic on the message: electron-updater flattens every
 *  underlying cause into a single Error with no code field. */
const NETWORK_ERROR_PATTERN =
	/\b(?:ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_CONNECTION_REFUSED|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_ADDRESS_UNREACHABLE|ERR_NETWORK_CHANGED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)\b/i;

const NETWORK_ERROR_WORDS = /(?:network|timeout|timed out|socket hang up|fetch failed|connection)/i;

/** True when the error text smells like a network-level failure. */
function isNetworkError(message) {
	const text = typeof message === "string" ? message : String(message ?? "");
	if (!text) return false;
	return NETWORK_ERROR_PATTERN.test(text) || NETWORK_ERROR_WORDS.test(text);
}

/**
 * Classify one updater failure.
 * @param {"check"|"download"|"install"} op which phase failed
 * @param {unknown} err the raw error (Error, string, anything)
 * @returns {{ kind: string, message: string, technicalDetails?: string }}
 *   kind   — stable semantic enum "<op>" | "<op>-network"
 *   message — raw human-readable error text (renderer folds it into the
 *             技术详情 section; localized copy comes from the kind)
 *   technicalDetails — extra diagnostics (error stack) when present
 */
function classifyUpdateError(op, err) {
	const operation = UPDATE_OPERATIONS.includes(op) ? op : "check";
	const message = err instanceof Error ? err.message : typeof err === "string" ? err : String(err ?? "unknown error");
	const kind = isNetworkError(message) ? `${operation}-network` : operation;
	const details = { kind, message };
	const stack = err instanceof Error ? err.stack : undefined;
	if (typeof stack === "string" && stack) details.technicalDetails = stack;
	return details;
}

/** Poll schedule parameters (dsh update-schedule.ts parity). */
const UPDATE_POLL_BASE_MS = 60 * 60 * 1000; // 1h between checks on success
const UPDATE_POLL_MAX_MS = 6 * 60 * 60 * 1000; // backoff cap: 6h
const UPDATE_POLL_JITTER = 0.2; // ±20% jitter around the delay

/**
 * Delay until the next automatic check.
 * @param {number} consecutiveFailures 0 = last check succeeded → base interval;
 *   n ≥ 1 → base × 2^n capped at the max, then jittered.
 * @param {{ baseMs?: number, maxMs?: number, jitter?: number, random?: () => number }} [opts]
 *   random — injectable RNG so tests can pin the jitter extremes.
 * @returns {number} delay in ms — dsh schedule() parity: delay is
 *   base × 2^failures (capped at max), jittered within
 *   [delay×(1−jitter), min(max, delay×(1+jitter))].
 */
function nextPollDelayMs(consecutiveFailures, opts = {}) {
	const base = typeof opts.baseMs === "number" ? opts.baseMs : UPDATE_POLL_BASE_MS;
	const max = typeof opts.maxMs === "number" ? opts.maxMs : UPDATE_POLL_MAX_MS;
	const jitter = typeof opts.jitter === "number" ? opts.jitter : UPDATE_POLL_JITTER;
	const random = typeof opts.random === "function" ? opts.random : Math.random;
	const failures = Math.max(0, Math.floor(consecutiveFailures) || 0);
	const delay = failures === 0 ? base : Math.min(max, base * 2 ** failures);
	const lower = delay * (1 - jitter);
	const upper = Math.min(max, delay * (1 + jitter));
	return Math.round(lower + (upper - lower) * Math.min(1, Math.max(0, random())));
}

module.exports = {
	UPDATE_OPERATIONS,
	NETWORK_ERROR_PATTERN,
	UPDATE_POLL_BASE_MS,
	UPDATE_POLL_MAX_MS,
	UPDATE_POLL_JITTER,
	isNetworkError,
	classifyUpdateError,
	nextPollDelayMs,
};
