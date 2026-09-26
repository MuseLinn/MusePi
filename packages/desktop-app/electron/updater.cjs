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
const { app, BrowserWindow, session, shell } = require("electron");
const fs = require("node:fs");
const nodePath = require("node:path");
const { classifyUpdateError } = require("./update-logic.cjs");

// ── File log ─────────────────────────────────────────────────────────────
// Everything the updater does also lands in ~/Library/Logs/MusePi/updater.log
// (Windows: %USERPROFILE%\AppData\Roaming\MusePi\logs). Console output is
// invisible once the app is packaged, and a Squirrel install failure happens
// in a child process AFTER the app quit — without a file log this whole class
// of "restarted, still the old version" bug is undiagnosable.
const LOG_DIR = (() => {
	try {
		return app.getPath("logs");
	} catch {
		return "";
	}
})();
let logStream = null;

/** Append one line to updater.log (best effort — never throws into the flow). */
function log(...args) {
	const line = `[${new Date().toISOString()}] ${args
		.map(a => (typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()))
		.join(" ")}\n`;
	try {
		if (LOG_DIR) {
			if (!logStream) {
				fs.mkdirSync(LOG_DIR, { recursive: true });
				logStream = fs.createWriteStream(nodePath.join(LOG_DIR, "updater.log"), { flags: "a" });
			}
			logStream.write(line);
		}
	} catch {
		// logging must never break the update flow
	}
	console.log("[updater]", ...args);
}

/** Current user-facing state (mirrored to the renderer via updater-state). */
const state = {
	status: "idle", // idle | available | checking | preparing | downloading | verifying | downloaded | error
	/** "ota" = electron-updater/Squirrel path; "installer" = manual dmg/exe. */
	mode: "ota",
	version: null,
	progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
	/** Structured failure: { kind, message, technicalDetails? } — kind is the
	 *  stable {check|download|install}×{network|other} enum (update-logic.cjs);
	 *  the renderer maps kind → localized copy and folds the raw message +
	 *  stack into a 技术详情 section. */
	error: null,
	/** Path of a downloaded manual installer (mode "installer"). */
	installerPath: null,
};

/** Record a classified failure into the state and log it. */
function setError(op, err) {
	state.error = classifyUpdateError(op, err);
	log(`${op} failed (${state.error.kind}):`, state.error.message);
}

/** Clear any recorded failure (call on every successful transition). */
function clearError() {
	state.error = null;
}

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
let manifestCache;
let manifestInFlight = null;

/** Fetch and cache the release manifest ({notes, url}). */
function fetchManifest() {
	if (manifestCache !== undefined) return Promise.resolve(manifestCache);
	if (!manifestInFlight) {
		manifestInFlight = (async () => {
			try {
				const res = await fetch(manifestUrl(), { signal: AbortSignal.timeout(8_000) });
				if (!res.ok) {
					log("manifest fetch failed:", res.status);
					return null;
				}
				const data = await res.json();
				manifestCache = {
					notes: typeof data?.notes === "string" && data.notes ? data.notes : null,
					// Direct installer URL (dmg on macOS) — the manual install path
					// uses it when OTA cannot work.
					url: typeof data?.url === "string" && data.url ? data.url : "",
				};
				return manifestCache;
			} catch (err) {
				log("manifest fetch error:", err?.message ?? err);
				return null;
			} finally {
				manifestInFlight = null;
			}
		})();
	}
	return manifestInFlight;
}

function fetchManifestNotes() {
	return fetchManifest().then(meta => meta?.notes ?? null);
}

/** Cached manifest metadata ({notes, url}) — resolves null when unavailable. */
function fetchManifestMeta() {
	return fetchManifest();
}

// ── Signing probe (macOS OTA capability) ─────────────────────────────────
// Squirrel.Mac validates an update against the RUNNING app's designated
// requirement. An ad-hoc signed app has a cdhash-only requirement, which no
// freshly built update can ever match, so OTA is impossible — the download
// and the quit-and-install silently do nothing. Detect that once and let the
// renderer offer the manual installer instead of a button that cannot work.
let signingCache = null;

function detectSigning() {
	if (signingCache) return signingCache;
	if (process.platform !== "darwin") {
		signingCache = "n/a";
		return signingCache;
	}
	try {
		const exeDir = nodePath.dirname(app.getPath("exe")); // …/Contents/MacOS
		const bundlePath = nodePath.resolve(exeDir, "..", ".."); // …/MusePi.app
		const res = require("node:child_process").spawnSync("/usr/bin/codesign", ["-d", "-r-", bundlePath], {
			encoding: "utf8",
		});
		const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
		if (/cdhash/.test(out)) signingCache = "adhoc";
		else if (/anchor apple/.test(out)) signingCache = "developer-id";
		else if (out.trim()) signingCache = "self-signed";
		else signingCache = "unknown";
		log("signing probe:", signingCache, "path:", bundlePath);
	} catch (err) {
		log("signing probe failed:", err?.message ?? err);
		signingCache = "unknown";
	}
	return signingCache;
}

/** True when electron-updater/Squirrel can actually install an update here. */
function otaCapable() {
	// "unknown" keeps the previous behaviour (attempt OTA) so a probe failure
	// never removes the working path on Windows/Linux.
	return detectSigning() !== "adhoc";
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
	clearError();
	setTaskbarProgress(-2);
	emitState();
});

autoUpdater.on("update-available", (info) => {
	// `available` is now an explicit phase (design §3.1-1) so the renderer
	// can read "a newer version exists" from the state stream alone instead
	// of splicing the update-available event with updater-state. Never
	// downgrade an in-flight download/install — a manual re-check while the
	// package is downloaded must not wipe the 立即重启 entry.
	if (!["preparing", "downloading", "verifying", "downloaded"].includes(state.status)) {
		state.status = "available";
	}
	state.mode = "ota";
	state.version = info.version;
	clearError();
	log("update available:", info.version);
	emitState();
	emitUpdateAvailable(info.version);
});

autoUpdater.on("update-not-available", () => {
	// A stale-version verdict must not erase a downloaded package either.
	if (!["preparing", "downloading", "verifying", "downloaded"].includes(state.status)) {
		state.status = "idle";
	}
	clearError();
	emitState();
});

autoUpdater.on("error", (err) => {
	// electron-updater's `error` event fires for whatever operation is
	// current — infer the operation from the phase the failure arrived in.
	const op = state.status === "verifying" || state.status === "downloaded" ? "install" : state.status === "downloading" || state.status === "preparing" ? "download" : "check";
	state.status = "error";
	setError(op, err);
	setTaskbarProgress(-2);
	emitState();
});

autoUpdater.on("download-progress", (progress) => {
	// ≥100% but no `update-downloaded` yet: the package is being verified /
	// finalized (dsh update-coordinator verifying phase) — the progress bar
	// no longer sits at a fake 100% with no explanation.
	state.status = progress.percent >= 100 ? "verifying" : "downloading";
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
	state.mode = "ota";
	state.version = info.version;
	state.progress = { percent: 100, transferred: 0, total: 0 };
	clearError();
	log("update downloaded:", info.version);
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
	// Kick the manifest fetch beside the feed check so the enriched result rarely
	// waits on a second round-trip (and the toast's updater-notes ask hits cache).
	const manifestPromise = fetchManifest();
	try {
		const result = await autoUpdater.checkForUpdates();
		const latest = result?.updateInfo?.version ?? null;
		const current = app.getVersion();
		const meta = await manifestPromise;
		const newer = isNewerVersion(latest, current);
		log("check: current", current, "latest", latest, "newer", newer, "otaCapable", otaCapable());
		return {
			enabled: true,
			newer,
			latest,
			current,
			notes: meta?.notes ?? null,
			/** Manual-install fallback (dmg/exe) from the release manifest. */
			url: meta?.url ?? "",
			/** false ⇒ Squirrel cannot install here (ad-hoc signed macOS build);
			 *  the renderer must offer the manual installer instead. */
			otaCapable: otaCapable(),
		};
	} catch (err) {
		state.status = "error";
		setError("check", err);
		// The checkForUpdates() renderer contract keeps `error` a string
		// (settings page prints it verbatim); the structured shape only
		// travels on updater-state.
		emitState();
		return { enabled: true, error: state.error.message, url: "", otaCapable: otaCapable() };
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
	state.mode = "ota";
	clearError();
	setTaskbarProgress(-1); // indeterminate until the first byte flows
	emitState();
	try {
		await autoUpdater.downloadUpdate();
		return true;
	} catch (err) {
		state.status = "error";
		setError("download", err);
		setTaskbarProgress(-2);
		emitState();
		return false;
	}
}

/**
 * Download the standalone installer (dmg on macOS, exe on Windows) into the
 * user's Downloads folder and open it. This is the fallback for builds where
 * Squirrel cannot install anything — an ad-hoc signed macOS app has a
 * cdhash-only designated requirement that no freshly built update matches, so
 * OTA can never land. Downloading through the Chromium session gives real
 * progress events for the existing toast and handles GitHub's redirects.
 */
function downloadInstaller(url) {
	const targetUrl = typeof url === "string" ? url.trim() : "";
	if (!targetUrl) {
		log("downloadInstaller: no url");
		return Promise.resolve({ ok: false, error: "no installer url" });
	}
	let fileName = "";
	try {
		fileName = nodePath.basename(new URL(targetUrl).pathname) || "MusePi.dmg";
	} catch {
		fileName = "MusePi.dmg";
	}
	let target = "";
	try {
		target = nodePath.join(app.getPath("downloads"), fileName);
	} catch {
		target = nodePath.join(app.getPath("userData"), fileName);
	}

	state.status = "preparing";
	state.mode = "installer";
	clearError();
	state.installerPath = null;
	state.progress = { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 };
	log("installer download start:", targetUrl, "→", target);
	emitState();

	return new Promise(resolve => {
		const ses = session.defaultSession;
		let claimed = false;
		const onWillDownload = (event, item) => {
			if (claimed) return;
			claimed = true;
			item.setSavePath(target);
			item.on("updated", () => {
				const received = item.getReceivedBytes();
				const total = item.getTotalBytes();
				state.status = "downloading";
				state.mode = "installer";
				state.progress = {
					percent: total > 0 ? Math.round((received / total) * 100) : 0,
					transferred: received,
					total,
					bytesPerSecond: 0,
				};
				emitState();
			});
			item.on("done", (_event, doneState) => {
				ses.removeListener("will-download", onWillDownload);
			if (doneState !== "completed") {
				state.status = "error";
				setError("download", `download ${doneState}`);
				emitState();
				resolve({ ok: false, error: state.error.message });
				return;
			}
				state.status = "downloaded";
				state.mode = "installer";
				state.installerPath = target;
				state.progress = { percent: 100, transferred: 0, total: 0, bytesPerSecond: 0 };
				log("installer download done:", target);
				emitState();
				// Open (mount) it so the user only has to drag MusePi over
				// Applications — no Finder hunting for the file.
				shell
					.openPath(target)
					.then(result => {
						if (result) log("openPath returned:", result);
					})
					.catch(err => log("openPath failed:", err?.message ?? err));
				resolve({ ok: true, path: target });
			});
		};
		ses.on("will-download", onWillDownload);
		try {
			ses.downloadURL(targetUrl);
		} catch (err) {
			ses.removeListener("will-download", onWillDownload);
			state.status = "error";
			setError("download", err);
			emitState();
			resolve({ ok: false, error: state.error.message });
		}
	});
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
			setError("install", error);
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

module.exports = {
	checkForUpdates,
	downloadUpdate,
	downloadInstaller,
	quitAndInstall,
	fetchManifestNotes,
	fetchManifestMeta,
	otaCapable,
	detectSigning,
	log,
	wireRenderer,
	state,
};