/**
 * OTA updater — wraps electron-updater v6 to provide the existing renderer
 * contract (checkForUpdates → UpdateCheckResult) plus download/install
 * controls (updater-download / updater-install / updater-state).
 *
 * Stable builds read latest.yml through the electron-builder GitHub config;
 * beta builds read beta.yml from the channel-beta release. The daemon-side
 * update flow uses update-manifest.json from the matching channel.
 */
"use strict";

// ── Host guard ────────────────────────────────────────────────────────────
// electron-updater's lazy autoUpdater getter constructs an app adapter that
// reads `require("electron").app` — under a plain-Node host (a broken/raced
// launcher shim executing main.cjs with node instead of the Electron binary)
// that is undefined and the require below crashes the ENTIRE startup with a
// cryptic ElectronAppAdapter dump (observed 2026-09-29: one `bun run desktop`
// run raced a concurrent bun install rewriting the .bin shim). Degrade to a
// disabled-updater stub with a one-line diagnosis instead: the GUI may still
// come up, and the log says exactly what happened.
const electronModule = require("electron");
const app = typeof electronModule === "string" ? null : (electronModule.app ?? null);

if (!app) {
	const unavailable = "updater unavailable: main process is not running under the Electron binary (require(\"electron\") returned no app object — check the launcher shim)";
	process.stderr.write(`[updater] ${unavailable}\n`);
	const disabledState = {
		status: "error",
		mode: "ota",
		version: null,
		progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
		error: { kind: "check-other", message: unavailable },
		installerPath: null,
	};
	module.exports = {
		checkForUpdates: async () => ({ enabled: false, error: unavailable, url: "", otaCapable: false }),
		downloadUpdate: async () => false,
		downloadInstaller: async () => ({ ok: false, error: unavailable }),
		installUpdate: async () => ({ ok: false, error: unavailable }),
		quitAndInstall: async () => {
			throw new Error(unavailable);
		},
		fetchManifestNotes: async () => null,
		fetchManifestMeta: async () => null,
		otaCapable: () => false,
		detectSigning: () => "unknown",
		setChannel: () => ({ channel: "stable" }),
		setAutoRestart: () => ({ autoRestart: false }),
		channel: () => "stable",
		log: (...args) => process.stderr.write(`[updater] ${args.join(" ")}\n`),
		wireRenderer: () => {},
		wireRestartHandoff: () => {},
		snapshot: () => ({ ...disabledState, restart: { auto: false, status: "idle", inFlight: 0, blockers: [] } }),
		state: disabledState,
	};
	return;
}

const { autoUpdater } = require("electron-updater");
const { BrowserWindow, session, shell } = electronModule;
const fs = require("node:fs");
const nodePath = require("node:path");
const {
	classifyUpdateError,
	idleRestartStep,
	isMissingUpdateFeedError,
	isNewerVersion,
	normalizeUpdateChannel,
	releaseChannelForVersion,
	releaseDownloadUrl,
	shouldAutoRestart,
	updateFeedForChannel,
	updateManifestUrlForVersion,
	UPDATE_IDLE_SAMPLE_MS,
} = require("./update-logic.cjs");

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

const DEFAULT_STABLE_MANIFEST_URL =
	"https://github.com/MuseLinn/MusePi/releases/latest/download/update-manifest.json";
const RELEASES_PAGE = "https://github.com/MuseLinn/MusePi/releases/latest";

function manifestUrl() {
	const channelUrl = updateManifestUrlForVersion(app.getVersion(), requestedChannel);
	try {
		const pkg = require("../package.json");
		const configured = pkg?.update?.manifestUrl;
		return (
			process.env.MUSEPI_UPDATE_MANIFEST_URL ||
			(configured && configured !== DEFAULT_STABLE_MANIFEST_URL ? configured : channelUrl)
		);
	} catch {
		return channelUrl;
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

/** Fetch and cache the release manifest ({notes, url, downloads}). */
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
				const rawDownloads = data?.downloads && typeof data.downloads === "object" && !Array.isArray(data.downloads) ? data.downloads : {};
				manifestCache = {
					notes: typeof data?.notes === "string" && data.notes ? data.notes : null,
					url: typeof data?.url === "string" && data.url ? data.url : "",
					downloads: Object.fromEntries(
						Object.entries(rawDownloads).filter(([, value]) => typeof value === "string" && value),
					),
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

/** Cached manifest metadata ({notes, url, downloads}) — resolves null when unavailable. */
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

/**
 * Requested update channel, persisted next to the other main-process
 * preferences. The daemon owns the `update.channel` setting; the renderer
 * pushes it here on load and on change, and the file keeps the last choice
 * for the cold-start silent check, which runs before settings are reachable.
 */
const CHANNEL_FILE = nodePath.join(app.getPath("userData"), "update-channel.json");

function readRequestedChannel() {
	try {
		const raw = JSON.parse(fs.readFileSync(CHANNEL_FILE, "utf8"));
		return normalizeUpdateChannel(raw?.channel);
	} catch {
		return "stable";
	}
}

let requestedChannel = readRequestedChannel();

/**
 * Whether a downloaded OTA package restarts on its own once live work
 * settles. Stored beside the channel because the watchdog must decide without
 * a daemon round-trip — the daemon may be the thing being replaced. Defaults
 * to on: 下载更新 is the user's consent to be updated.
 */
function readAutoRestart() {
	try {
		const raw = JSON.parse(fs.readFileSync(CHANNEL_FILE, "utf8"));
		return raw?.autoRestart !== false;
	} catch {
		return true;
	}
}

let autoRestart = readAutoRestart();

/** Persist both main-process update preferences (channel + auto-restart). */
function writePreferences() {
	try {
		fs.mkdirSync(nodePath.dirname(CHANNEL_FILE), { recursive: true });
		fs.writeFileSync(CHANNEL_FILE, JSON.stringify({ channel: requestedChannel, autoRestart }));
	} catch (error) {
		log("failed to persist update preferences:", String(error));
	}
}

/** Channel the updater actually follows (a beta build never leaves beta). */
function effectiveChannel() {
	return releaseChannelForVersion(app.getVersion(), requestedChannel);
}

function applyChannelFeed() {
	const channel = effectiveChannel();
	autoUpdater.allowPrerelease = channel === "beta";
	autoUpdater.setFeedURL(updateFeedForChannel(channel));
	log(`update channel: ${channel}`);
	return channel;
}

/**
 * Switch the channel at runtime. Persists the request, repoints the feed and
 * returns the channel now in effect — a beta build reports `beta` even for a
 * `stable` request, so the caller can show what the updater will follow
 * instead of echoing a preference that has no effect.
 */
function setChannel(value) {
	requestedChannel = normalizeUpdateChannel(value);
	writePreferences();
	// A new feed means a new target: the armed watchdog pointed at the old one.
	stopIdleWatch("channel change");
	return { channel: applyChannelFeed() };
}

applyChannelFeed();

autoUpdater.on("checking-for-update", () => {
	state.status = "checking";
	clearError();
	setTaskbarProgress(-2);
	emitState();
});

autoUpdater.on("update-available", (info) => {
	// A new candidate invalidates the armed target.
	stopIdleWatch("new candidate");
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
	stopIdleWatch("no update");
	// A stale-version verdict must not erase a downloaded package either.
	if (!["preparing", "downloading", "verifying", "downloaded"].includes(state.status)) {
		state.status = "idle";
	}
	clearError();
	emitState();
});

autoUpdater.on("error", (err) => {
	stopIdleWatch("error");
	// A release with no update metadata for this platform/channel (404 on
	// latest.yml) means "nothing to update to", not a broken updater
	// (openchamber updater-check parity): log it, stay idle, and let the
	// checkForUpdates result carry the missingFeed verdict to the settings
	// page — the toast never shows because no update-available fires.
	if (state.status !== "verifying" && state.status !== "downloaded" && state.status !== "downloading" && state.status !== "preparing" && isMissingUpdateFeedError(err)) {
		log("update feed not published for this platform/channel:", err?.message ?? err);
		state.status = "idle";
		clearError();
		emitState();
		return;
	}
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
	// The package is verified: from here the only open question is when no
	// live work remains.
	armIdleWatch();
});

function emitState() {
	if (sendToRenderer) sendToRenderer("updater-state", snapshot());
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

// ── Idle restart (dsh updateTasks parity) ────────────────────────────────
// A downloaded OTA package restarts as soon as live work settles: inspect the
// daemon, lock admission, stop the owned daemon, hand off to the installer.
// This module decides *when*; update-restart.cjs performs the handoff and is
// wired by main.cjs (daemon RPC + owned-daemon stop live there).

/** Shell-owned handoff, injected at startup before any check can fire. */
let restartHandoff = null;

/** Progress mirrored to the renderer so the banner can name what is running. */
const restart = {
	/** An idle watchdog is armed. */
	auto: false,
	/** "idle" | "waiting" | "installing" | "blocked" */
	status: "idle",
	inFlight: 0,
	/** Armed scheduled reminders the restart would drop. */
	scheduled: 0,
	blockers: [],
};

let idleTimer = null;
let idleStreak = 0;
let unknownStreak = 0;
let installing = false;

/** Wire the shell-owned handoff (called once at startup). */
function wireRestartHandoff(handoff) {
	restartHandoff = handoff;
}

/** State plus restart progress, for the updater-state IPC and event pushes. */
function snapshot() {
	return { ...state, restart: { ...restart, blockers: [...restart.blockers] } };
}

function stopIdleWatch(reason) {
	if (idleTimer) {
		clearInterval(idleTimer);
		idleTimer = null;
	}
	idleStreak = 0;
	unknownStreak = 0;
	if (!restart.auto) return;
	restart.auto = false;
	log("auto-restart: disarmed", reason ?? "");
	emitState();
}

/** Arm the watchdog for a downloaded package (idempotent). */
function armIdleWatch() {
	if (!restartHandoff || idleTimer || installing || restart.status === "blocked") return;
	if (!shouldAutoRestart({ status: state.status, mode: state.mode, autoRestart, otaCapable: otaCapable() })) {
		if (restart.status !== "idle") {
			restart.status = "idle";
			emitState();
		}
		return;
	}
	log("auto-restart: armed");
	restart.auto = true;
	restart.status = "waiting";
	restart.inFlight = 0;
	restart.blockers = [];
	emitState();
	idleTimer = setInterval(() => void idleTick(), UPDATE_IDLE_SAMPLE_MS);
	// The watchdog must never be the reason the process stays alive.
	idleTimer.unref?.();
	// Sample immediately: the app may already be idle.
	void idleTick();
}

async function idleTick() {
	if (!idleTimer || installing || !restartHandoff) return;
	const summary = await restartHandoff.inspect();
	// A manual install (or a disarm) may have landed while the inspection was
	// in flight; the sample is then stale, not authoritative.
	if (!idleTimer || installing) return;
	const step = idleRestartStep({ summary, streak: idleStreak, unknownStreak });
	idleStreak = step.streak;
	unknownStreak = step.unknownStreak;
	restart.status = "waiting";
	restart.inFlight = step.inFlight ?? 0;
	restart.scheduled = step.scheduled ?? 0;
	restart.blockers = step.blockers;
	emitState();
	if (step.giveUp) {
		// A daemon that cannot answer is not evidence of idleness: stop asking
		// automatically and leave 立即重启 to the user.
		stopIdleWatch("daemon did not answer");
		restart.status = "blocked";
		restart.blockers = ["tasks-unavailable"];
		restart.inFlight = 0;
		emitState();
		return;
	}
	if (step.action === "restart") {
		stopIdleWatch("idle");
		void installUpdate("auto");
	}
}

/**
 * Hand the downloaded package to the installer.
 * @param {"manual"|"auto"} [reason] `auto` refuses while work is in flight.
 */
async function installUpdate(reason = "manual") {
	if (installing) return { ok: false, error: "install already in progress" };
	if (!restartHandoff) return { ok: false, error: "update handoff unavailable" };
	// Nothing to hand off: never stop the daemon for a package that is not
	// downloaded and verified.
	if (state.status !== "downloaded") return { ok: false, error: "no downloaded update" };
	stopIdleWatch(reason === "auto" ? "handing off" : "manual install");
	installing = true;
	restart.status = "installing";
	restart.blockers = [];
	emitState();
	try {
		const result = await restartHandoff.install({ auto: reason === "auto" });
		if (result.ok) return { ok: true };
		// Keep the verified package and the retry entry: a refused handoff never
		// discards the download.
		restart.status = "blocked";
		restart.blockers = result.blockers ?? [result.reason];
		restart.inFlight = result.inFlight ?? restart.inFlight;
		log("install refused:", result.reason);
		emitState();
		return { ok: false, error: result.reason };
	} finally {
		installing = false;
	}
}

/** Toggle the idle restart policy; a downloaded package re-arms immediately. */
function setAutoRestart(value) {
	autoRestart = value === true;
	writePreferences();
	if (autoRestart) {
		// An explicit policy change is also the retry path after a blocked
		// handoff: clear the refusal so the watchdog may try again.
		restart.status = "idle";
		restart.blockers = [];
		armIdleWatch();
	} else {
		stopIdleWatch("disabled");
	}
	return { autoRestart };
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
			/** Platform-matched installer, or the releases page when none is published. */
			url: releaseDownloadUrl(meta, process.platform, process.arch, RELEASES_PAGE),
			/** false ⇒ Squirrel cannot install here (ad-hoc signed macOS build);
			 *  the renderer must offer the manual installer instead. */
			otaCapable: otaCapable(),
		};
	} catch (err) {
		// Missing feed (404 on latest.yml / channel file never published) is
		// "nothing to update to", not a failure — a dedicated verdict lets the
		// settings page say so instead of implying the user's network is down.
		if (isMissingUpdateFeedError(err)) {
			log("check: update feed not published:", err?.message ?? err);
			return {
				enabled: true,
				newer: false,
				latest: null,
				current: app.getVersion(),
				missingFeed: true,
				url: "",
				otaCapable: otaCapable(),
			};
		}
		state.status = "error";
		setError("check", err);
		// The renderer contract ships both the raw message (folded into the
		// 技术详情 section) and the classified `kind` (mapped to localized
		// copy there); the structured shape also travels on updater-state.
		emitState();
		return {
			enabled: true,
			error: state.error.message,
			errorKind: state.error.kind,
			url: "",
			otaCapable: otaCapable(),
		};
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
	// A new download supersedes the armed idle target.
	stopIdleWatch("new download");
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
		// starts shutting down. Silent install + relaunch: both entry points
		// (立即重启 and the idle handoff) promise a restarted app, not an
		// installer wizard (dsh `quitAndInstall(true, true)` parity).
		setImmediate(() => {
			try {
				autoUpdater.quitAndInstall(true, true);
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
	installUpdate,
	quitAndInstall,
	fetchManifestNotes,
	fetchManifestMeta,
	otaCapable,
	detectSigning,
	setChannel,
	setAutoRestart,
	channel: effectiveChannel,
	log,
	wireRenderer,
	wireRestartHandoff,
	snapshot,
	state,
};