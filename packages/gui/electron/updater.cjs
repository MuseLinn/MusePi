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
const { app, BrowserWindow } = require("electron");

/** Current user-facing state (mirrored to the renderer via updater-state). */
const state = {
	status: "idle", // idle | checking | preparing | downloading | downloaded | error
	version: null,
	progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
	error: null,
};

/** Release notes asset on the latest GitHub release (same redirect the daemon
 *  RPC uses — no api.github.com rate limits). */
const RELEASE_MANIFEST_URL =
	"https://github.com/MuseLinn/MusePi/releases/latest/download/update-manifest.json";

/** Notes-fetch URL: `OMP_UPDATE_MANIFEST_URL` env → `package.json
 *  update.manifestUrl` → default (documented override chain for testing /
 *  self-hosted manifests; the electron-updater feed itself comes from the
 *  build publish config, not the manifest). */
function manifestUrl() {
	try {
		const pkg = require("../package.json");
		return process.env.OMP_UPDATE_MANIFEST_URL || pkg?.update?.manifestUrl || RELEASE_MANIFEST_URL;
	} catch {
		return RELEASE_MANIFEST_URL;
	}
}

/**
 * Release notes from update-manifest.json. The manifest ships `notes` as a
 * plain string (the newest CHANGELOG.musepi section, bilingual-mixed — see
 * gui-release.yml); the {zh,en} shape is reserved for a future split manifest.
 * Success is cached (shared by the enriched checkForUpdates result and the
 * updater-notes IPC); failures are not, so an offline first ask retries.
 */
let notesCache;
let notesInFlight = null;

function fetchManifestNotes() {
	if (notesCache !== undefined) return Promise.resolve(notesCache);
	if (!notesInFlight) {
		notesInFlight = (async () => {
			try {
				const res = await fetch(manifestUrl(), { signal: AbortSignal.timeout(8_000) });
				if (!res.ok) return null;
				const data = await res.json();
				notesCache = typeof data?.notes === "string" && data.notes ? data.notes : null;
				return notesCache;
			} catch {
				return null;
			} finally {
				notesInFlight = null;
			}
		})();
	}
	return notesInFlight;
}

/** Base-version compare ("0.4.16" vs "0.4.9"); prerelease suffix stripped —
 *  stable clients (allowPrerelease=false) never see beta latest.yml anyway. */
function isNewerVersion(latest, current) {
	const parse = (v) =>
		String(v)
			.split("-")[0]
			.split(".")
			.map((n) => Number.parseInt(n, 10) || 0);
	const a = parse(latest);
	const b = parse(current);
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0);
		if (diff !== 0) return diff > 0;
	}
	return false;
}

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

/** Windows taskbar download progress (openchamber parity): value ∈ [0,1]
 *  for determinate progress, -1 for indeterminate, -2 clears (remove).
 *  Only meaningful on Windows; no-op elsewhere. */
function setTaskbarProgress(value) {
	if (process.platform !== "win32") return;
	for (const win of BrowserWindow.getAllWindows()) {
		if (win.isDestroyed()) continue;
		try {
			win.setProgressBar(value);
		} catch {
			// window mid-teardown — best effort
		}
	}
}

// ── autoUpdater event wiring ─────────────────────────────────────────────

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

autoUpdater.on("checking-for-update", () => {
	state.status = "checking";
	state.error = null;
	setTaskbarProgress(-2);
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
	setTaskbarProgress(-2);
	emitState();
});

autoUpdater.on("download-progress", (progress) => {
	state.status = "downloading";
	state.progress = {
		percent: Math.round(progress.percent),
		transferred: progress.transferred,
		total: progress.total,
		bytesPerSecond: progress.bytesPerSecond ?? 0,
	};
	setTaskbarProgress(progress.percent > 0 ? Math.min(1, Math.max(0, progress.percent / 100)) : -1);
	emitState();
});

autoUpdater.on("update-downloaded", (info) => {
	state.status = "downloaded";
	state.version = info.version;
	state.progress = { percent: 100, transferred: 0, total: 0 };
	state.error = null;
	// Clear the taskbar progress once the download lands; the install
	// phase is signaled by the app quitting, not a bar.
	setTaskbarProgress(-2);
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
 * Check for updates. Resolves to the renderer contract (UpdateCheckResult):
 * `newer`/`latest`/`current` from the feed's updateInfo, plus release notes
 * fetched beside the feed check. The autoUpdater events drive the state
 * machine; the renderer listens to updater-state for live updates.
 */
async function checkForUpdates() {
	// Kick the notes fetch beside the feed check so the enriched result rarely
	// waits on a second round-trip (and the toast's updater-notes ask hits cache).
	const notesPromise = fetchManifestNotes();
	try {
		const result = await autoUpdater.checkForUpdates();
		const latest = result?.updateInfo?.version ?? null;
		const current = app.getVersion();
		const notes = await notesPromise;
		return {
			enabled: true,
			newer: isNewerVersion(latest, current),
			latest,
			current,
			notes,
		};
	} catch (err) {
		state.status = "error";
		state.error = err?.message ?? String(err);
		emitState();
		return { enabled: true, error: state.error };
	}
}

/**
 * Download the detected update. The renderer shows progress via
 * updater-state events. Returns true on success, false on error.
 */
async function downloadUpdate() {
	// Re-entry guard: a double-click (or toast + settings racing) must not
	// start a second electron-updater download — it rejects confusingly.
	if (state.status === "preparing" || state.status === "downloading") return true;
	// Optimistic intermediate state: the first download-progress event only
	// fires once bytes flow (latest.yml + release-asset TTFB can take seconds),
	// so the renderer shows a preparing bar instead of a dead button.
	state.status = "preparing";
	state.error = null;
	setTaskbarProgress(-1); // indeterminate until the first byte flows
	emitState();
	try {
		await autoUpdater.downloadUpdate();
		return true;
	} catch (err) {
		state.status = "error";
		state.error = err?.message ?? String(err);
		setTaskbarProgress(-2);
		emitState();
		return false;
	}
}

// quitAndInstall() reports failures (rejected code signature, a Squirrel
// session already disabled by an earlier failure) asynchronously on the
// 'error' event, long after the call returns. Give the install that long to
// either take the app down or report why it did not. On failure, roll the
// quit/install state back so the UI can offer retry instead of wedging.
const UPDATE_INSTALL_GRACE_MS = 15_000;

/**
 * Hand the downloaded update to the NSIS installer. Resolves when the app
 * is shutting down (grace period elapsed without an error event) or
 * rejects if the installer reports a failure — the renderer surfaces the
 * rejection instead of the install dying silently in the log.
 */
function quitAndInstall() {
	return new Promise((resolve, reject) => {
		let settled = false;

		const fail = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(graceTimer);
			autoUpdater.removeListener("error", fail);
			// Roll back to the downloaded state so the UI can retry; the
			// global error handler below also updates state, but this
			// restores a retryable status for the install-specific path.
			state.status = "downloaded";
			state.error = error instanceof Error ? error.message : String(error);
			emitState();
			reject(error instanceof Error ? error : new Error(String(error)));
		};

		// Still running after the grace period: the install is underway and
		// the app is shutting down, so release the pending promise.
		const graceTimer = setTimeout(() => {
			if (settled) return;
			settled = true;
			autoUpdater.removeListener("error", fail);
			resolve(null);
		}, UPDATE_INSTALL_GRACE_MS);

		autoUpdater.on("error", fail);

		// Defer so the renderer's invoke channel is idle before the app
		// starts shutting down.
		setImmediate(() => {
			try {
				autoUpdater.quitAndInstall();
			} catch (error) {
				fail(error);
			}
		});
	});
}

module.exports = { checkForUpdates, downloadUpdate, quitAndInstall, fetchManifestNotes, wireRenderer, state };