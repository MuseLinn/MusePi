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

/** openchamber updater-check.mjs parity: electron-updater rejects the check
 *  with these wordings when the release simply has no update metadata for
 *  this platform/channel yet (404 on latest.yml, or a channel file that was
 *  never published). That is authoritative "nothing to update to", not a
 *  broken updater — surface it as its own verdict instead of a failure so
 *  users don't blame their network. Deliberately narrower than openchamber's
 *  regex: a bare HttpError/status-code 404 also matches a missing installer
 *  ASSET mid-download, which must stay a download error, so only the
 *  provider's own "cannot find the channel file" wordings count; ENOTFOUND
 *  likewise stays a network error (we classify it separately). */
const MISSING_UPDATE_FEED_RE = /Cannot find (?:channel\b|.+ in the latest release artifacts)/i;

/** True when a check-phase rejection means "no update metadata published". */
function isMissingUpdateFeedError(err) {
	const message = err instanceof Error ? err.message : String(err ?? "");
	return MISSING_UPDATE_FEED_RE.test(message);
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

const CHANNEL_VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-beta\.([1-9]\d*))?$/;

function parseChannelVersion(version) {
	const match = CHANNEL_VERSION_RE.exec(String(version).trim());
	if (!match) return null;
	return { core: match.slice(1, 4).map(Number), beta: match[4] === undefined ? null : Number(match[4]) };
}

function releaseChannelForVersion(version) {
	const parsed = parseChannelVersion(version);
	return parsed && parsed.beta !== null ? "beta" : "stable";
}

function isNewerVersion(latest, current) {
	const a = parseChannelVersion(latest);
	const b = parseChannelVersion(current);
	if (!a || !b) return false;
	for (let i = 0; i < 3; i++) {
		if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i];
	}
	if (a.beta === b.beta) return false;
	if (a.beta === null) return true;
	if (b.beta === null) return false;
	return a.beta > b.beta;
}

function updateFeedForVersion(version) {
	if (releaseChannelForVersion(version) !== "beta") return null;
	return {
		provider: "generic",
		url: "https://github.com/MuseLinn/MusePi/releases/download/channel-beta",
		channel: "beta",
	};
}

function updateManifestUrlForVersion(version) {
	return releaseChannelForVersion(version) === "beta"
		? "https://github.com/MuseLinn/MusePi/releases/download/channel-beta/update-manifest.json"
		: "https://github.com/MuseLinn/MusePi/releases/latest/download/update-manifest.json";
}

function releaseDownloadUrl(manifest, platform, arch, releasesPage) {
	const downloads = manifest?.downloads;
	const targeted = downloads?.[`${platform}-${arch}`];
	if (typeof targeted === "string" && targeted) return targeted;
	if (platform === "darwin" && arch === "arm64" && typeof manifest?.url === "string") return manifest.url;
	return releasesPage;
}

module.exports = {
	UPDATE_OPERATIONS,
	NETWORK_ERROR_PATTERN,
	UPDATE_POLL_BASE_MS,
	UPDATE_POLL_MAX_MS,
	UPDATE_POLL_JITTER,
	MISSING_UPDATE_FEED_RE,
	isNetworkError,
	isMissingUpdateFeedError,
	classifyUpdateError,
	nextPollDelayMs,
	releaseChannelForVersion,
	releaseDownloadUrl,
	isNewerVersion,
	updateFeedForVersion,
	updateManifestUrlForVersion,
};
