/**
 * OTA updater — wraps electron-updater v6 to provide the existing renderer
 * contract (checkForUpdates → UpdateCheckResult) plus download/install
 * controls (updater-download / updater-install / updater-state).
 *
 * electron-updater reads the feed from the electron-builder publish config
 * (GitHub provider → latest.yml per platform). The daemon-side update flow
 * (changelog.display, "no-update-source") is unchanged — the old
 * update-manifest.json asset still exists for the daemon RPC.
 */
"use strict";

const { autoUpdater } = require("electron-updater");
const { app } = require("electron");

/** Current user-facing state (mirrored to the renderer via updater-state). */
const state = {
	status: "idle", // idle | checking | downloading | downloaded | error
	version: null,
	progress: { percent: 0, transferred: 0, total: 0 },
	error: null,
};

/** Subscription list for upstream → renderer events (set by main.cjs). */
let sendToRenderer = null; // (channel, data) => void

/**
 * Wire the updater to a renderer send function (called once by main.cjs
 * after the main window is ready, so auto-detected update events can
 * forward to the renderer).
 */
function wireRenderer(forward) {
	sendToRenderer = forward;
}

// ── autoUpdater event wiring ─────────────────────────────────────────────

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

autoUpdater.on("checking-for-update", () => {
	state.status = "checking";
	state.error = null;
	emitState();
});

autoUpdater.on("update-available", (info) => {
	state.status = "idle";
	state.version = info.version;
	state.error = null;
	emitState();
	emitUpdateAvailable(info.version);
});

autoUpdater.on("update-not-available", () => {
	state.status = "idle";
	state.error = null;
	emitState();
});

autoUpdater.on("error", (err) => {
	state.status = "error";
	state.error = err?.message ?? String(err);
	emitState();
});

autoUpdater.on("download-progress", (progress) => {
	state.status = "downloading";
	state.progress = {
		percent: Math.round(progress.percent),
		transferred: progress.transferred,
		total: progress.total,
	};
	emitState();
});

autoUpdater.on("update-downloaded", (info) => {
	state.status = "downloaded";
	state.version = info.version;
	state.progress = { percent: 100, transferred: 0, total: 0 };
	state.error = null;
	emitState();
});

function emitState() {
	if (sendToRenderer) sendToRenderer("updater-state", { ...state });
}

function emitUpdateAvailable(version) {
	if (sendToRenderer) {
		sendToRenderer("update-available", {
			enabled: true,
			newer: true,
			current: app.getVersion(),
			latest: version,
		});
	}
}

// ── Public API (replaces the old updater.cjs exports) ────────────────────

/**
 * Check for updates. Returns the current state (synchronous — the
 * autoUpdater events drive the state machine; the renderer listens to
 * updater-state for live updates).
 */
async function checkForUpdates() {
	try {
		await autoUpdater.checkForUpdates();
	} catch (err) {
		state.status = "error";
		state.error = err?.message ?? String(err);
		emitState();
		return { enabled: true, error: state.error };
	}
	return { enabled: true };
}

/**
 * Download the detected update. The renderer shows progress via
 * updater-state events. Returns true on success, false on error.
 */
async function downloadUpdate() {
	try {
		await autoUpdater.downloadUpdate();
		return true;
	} catch (err) {
		state.status = "error";
		state.error = err?.message ?? String(err);
		emitState();
		return false;
	}
}

/**
 * Quit and install the downloaded update. The caller must kill the daemon
 * sidecar before calling this.
 */
function quitAndInstall() {
	setImmediate(() => {
		autoUpdater.quitAndInstall();
	});
}

module.exports = { checkForUpdates, downloadUpdate, quitAndInstall, wireRenderer, state };