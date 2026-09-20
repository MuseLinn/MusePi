/**
 * Electron main process — the MusePi GUI shell (replaces the Tauri shell).
 *
 * Window: macOS hiddenInset title bar keeps the native traffic lights and
 * the window full-bleed, matching the previous Tauri Overlay layout. The
 * renderer's toolbar already drags via -webkit-app-region (Electron honors
 * the same CSS as Tauri did), and its left padding clears the traffic
 * lights (88px), so no window chrome work is needed in here.
 *
 * Loads the built SPA (packages/desktop-app/dist) over file:// — no dev static
 * server required. The daemon (musepi serve) is probed/spawned over IPC
 * from the renderer, identical semantics to the removed Tauri commands.
 */
"use strict";

const { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, net, Notification, powerMonitor, screen, session, shell } = require("electron");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
// win32 desktop integration (foreground-fullscreen probe, per-monitor DPI,
// DWM cloak recovery) over koffi FFI. Instantiates to a fail-open stub off
// Windows or when koffi is unavailable — every caller can use it unguarded.
const { createWindowsNative, CLOAK_APP } = require("./win32-native.cjs");
const win32Native = createWindowsNative({ log: msg => console.log(`[pet] ${msg}`) });
// GUI verification harness: set MUSEPI_CDP_PORT to expose a CDP endpoint so
// external tooling can screenshot/inspect the renderer (visual regression
// work). Off by default — no switch, no port.
if (process.env.MUSEPI_CDP_PORT) {
	app.commandLine.appendSwitch("remote-debugging-port", process.env.MUSEPI_CDP_PORT);
}
const { probe, probeWeb, restart, start, kill, portOpen } = require("./daemon.cjs");
const { createTrayController } = require("./tray.cjs");
const {
	checkForUpdates,
	downloadUpdate,
	downloadInstaller,
	quitAndInstall,
	fetchManifestNotes,
	wireRenderer,
	otaCapable,
	log: logUpdater,
	state: updaterState,
} = require("./updater.cjs");
const { ManagedBrowserController } = require("./managed-browser.cjs");

// ── Main-process log + crash guard ───────────────────────────────────────
// Electron main's console writes go to the parent's stdio pipe. When the GUI
// is launched from a launcher/Finder/Dock (no attached terminal), that pipe
// closes and ANY console.error throws EPIPE ("broken pipe") — an uncaught
// exception that surfaces Electron's "A JavaScript error occurred in the
// main process" modal and wedges the whole app (daemon stays busy, GUI shows
// "working" forever, messages stop sending). Two fixes:
//  1. Redirect console to a rotating file so writes never touch the pipe.
//  2. Swallow EPIPE-style uncaught exceptions so a stale pipe can never
//     turn a log line into a fatal modal; record everything else to the log.
const HOME_LOG_DIR = path.join(os.homedir(), ".musepi", "logs");
function mainLogPath() {
	try {
		fs.mkdirSync(HOME_LOG_DIR, { recursive: true });
	} catch {}
	const day = new Date().toISOString().slice(0, 10);
	return path.join(HOME_LOG_DIR, `gui-main.${day}.log`);
}
const mainLogStream = fs.createWriteStream(mainLogPath(), { flags: "a" });
function writeMainLog(level, args) {
	const line = `${new Date().toISOString()} [${level}] ${args.map(a => (typeof a === "string" ? a : safeStringify(a))).join(" ")}\n`;
	mainLogStream.write(line);
}
function safeStringify(value) {
	try {
		return typeof value === "string" ? value : JSON.stringify(value);
	} catch {
		return String(value);
	}
}
console.log = (...args) => writeMainLog("info", args);
console.warn = (...args) => writeMainLog("warn", args);
console.error = (...args) => writeMainLog("error", args);

process.on("uncaughtException", err => {
	writeMainLog("fatal", [err && err.stack ? err.stack : String(err)]);
	// Any uncaught exception in main would surface Electron's "A JavaScript
	// error occurred in the main process" modal and wedge the app. Swallow
	// everything (recorded above); an EPIPE specifically means the launcher
	// closed our console pipe, so stop writing to it entirely.
	if (err && err.code === "EPIPE") {
		console.log = () => {};
		console.warn = () => {};
		console.error = () => {};
		return;
	}
	// Non-EPIPE: keep the app alive; the console is already redirected to the
	// file sink, so no further writes can reach the pipe.
});
process.on("unhandledRejection", reason => {
	writeMainLog("fatal", ["unhandledRejection:", reason instanceof Error ? reason.stack || reason.message : String(reason)]);
	if (reason && reason.code === "EPIPE") {
		console.log = () => {};
		console.warn = () => {};
		console.error = () => {};
	}
});

// ── Data-root override ────────────────────────────────────────────────────
// The GUI can relocate the app data root (~/.musepi by default): the picked
// parent folder gets a fixed ".musepi" child (same convention as the home
// default), existing data is copied over, the choice is persisted here, and
// the daemon is respawned with PI_CONFIG_DIR set. The daemon itself is
// never told the path — pi-utils re-resolves every dir from that env var.

const DATA_ROOT_OVERRIDE_FILE = "data-root.json";

/** Persisted override { root } from the Electron userData dir, or null. */
function dataRootOverride() {
	try {
		const raw = fs.readFileSync(path.join(app.getPath("userData"), DATA_ROOT_OVERRIDE_FILE), "utf8");
		const parsed = JSON.parse(raw);
		return typeof parsed?.root === "string" && parsed.root !== "" ? { root: parsed.root } : null;
	} catch {
		return null;
	}
}

/** Effective data root: inherited env (shell-started daemons) → override → default. */
function currentDataRoot() {
	return process.env.PI_CONFIG_DIR || dataRootOverride()?.root || path.join(os.homedir(), ".musepi");
}

/** Env for daemon spawns: carry the override so the daemon resolves dirs there. */
function daemonEnv() {
	const override = dataRootOverride();
	return override ? { PI_CONFIG_DIR: override.root } : {};
}

// Explicit GPU acceleration (Electron defaults to on; force the flag so the
// heavy frosted-glass compositing — 24px backdrop blurs, menu overlays —
// stays GPU-backed). OMP_SOFTWARE_GL=1 opts out for remote/virtualized
// displays where the GPU compositor misbehaves.
// NOTE: Windows used to disable GPU compositing here because transparent
// windows flicker per-element there. That is fixed by the PLATFORM-NATIVE
// window material instead (Windows 11 backgroundMaterial via the DWM
// compositor, opaque window — see createWindow): software rendering made
// the 119 CSS backdrop-filter surfaces CPU-composited every frame, which
// is the visible lag vs macOS. GPU stays on everywhere now.
if (process.env.OMP_SOFTWARE_GL === "1") {
	app.disableHardwareAcceleration();
} else {
	app.commandLine.appendSwitch("enable-gpu");
	app.commandLine.appendSwitch("ignore-gpu-blocklist");
}

const DEV = !app.isPackaged;
const DIST_DIR = path.resolve(__dirname, "..", "dist");
const ICON_PATH = path.resolve(__dirname, "..", "build", "icon.png");

// Dev data isolation (dsh-desktop parity; set by dev-desktop.mjs): point
// userData at .desktop-build/development/ BEFORE anything resolves it —
// requestSingleInstanceLock's lock file lives there, so this also gives the
// dev instance its own lock and lets it run beside the user's real install.
if (process.env.MUSEPI_GUI_USER_DATA) {
	try {
		fs.mkdirSync(process.env.MUSEPI_GUI_USER_DATA, { recursive: true });
		app.setPath("userData", process.env.MUSEPI_GUI_USER_DATA);
	} catch (err) {
		console.error("[dev] failed to isolate userData:", err?.message ?? err);
	}
}

/**
 * Windows 11 (build 10.0.22000+): native Mica/Acrylic window materials are
 * available via backgroundMaterial (DWM compositor). Windows 10 falls back
 * to an opaque frame with a painted background.
 */
const IS_WIN11 =
	process.platform === "win32" &&
	(() => {
		try {
			const v = process.getSystemVersion?.() ?? "";
			const m = /10\.0\.(\d+)/.exec(v);
			return m ? Number(m[1]) >= 22000 : false;
		} catch {
			return false;
		}
	})();

// Single instance: a second `electron .` (dev:hot relaunch race, double
// launch) focuses the running window instead of stacking another. The
// `desktop` flow still works — relaunch-gui.mjs kills the stale instance
// first, so its lock is released before the fresh one requests it.
if (!app.requestSingleInstanceLock()) {
	app.quit();
	return; // CJS top-level: skip the rest of the module, no window flash
}
// Normal exit tears the daemon down WITH the GUI. Only the daemon this GUI
// instance SPAWNED is killed — a daemon we merely connected to (another GUI
// instance, autostart, terminal `musepi serve`) must survive. A crash never
// reaches this handler, so the detached daemon stays alive through crashes
// by design. The updater-install path kills the daemon explicitly earlier.
let daemonQuitHandled = false;
	// Keep a flag so the real quit path (tray "quit" → before-quit) can
	// close the window when we're exiting. User close on non-darwin hides
	// to tray instead.
	let quitting = false;
	app.on("before-quit", event => {
		console.error("[main] before-quit");
		quitting = true;
		if (daemonQuitHandled) return;
		daemonQuitHandled = true;
		// Electron does not await async quit handlers: hold the quit open while
		// the owned daemon tears down (SIGTERM + grace window), then re-quit.
		event.preventDefault();
	const { killOwnedDaemon } = require("./daemon.cjs");
	killOwnedDaemon()
		.then(killed => {
			console.error(`[main] daemon teardown on quit: ${killed ? "killed" : "not owned"}`);
		})
		.catch(err => {
			console.error("[main] daemon teardown on quit failed:", err?.message ?? err);
		})
		.finally(() => app.quit());
});
app.on("second-instance", () => {
	if (mainWindow && !mainWindow.isDestroyed()) {
		if (mainWindow.isMinimized()) mainWindow.restore();
		mainWindow.show();
		mainWindow.focus();
	}
});
// Dev-mode Dock icon: app.dock.setIcon() pastes the image raw into the
// NSDockTile — it does NOT go through LaunchServices, so macOS never applies
// the system squircle mask. The full-bleed build/icon.png would therefore
// show as a square. icon-dock.png is the same dot-matrix π pre-rounded
// (superellipse n=5 + transparent margins) so dev matches the packaged look.
const ICON_DOCK_PATH = path.resolve(__dirname, "..", "build", "icon-dock.png");

// Windows toast notifications REQUIRE a stable AppUserModelID — without it
// the OS cannot attribute the toast to this app (Electron shows it under a
// generic/blank source or drops it). Set once at startup; the packaged
// installer (electron-builder) also sets it, so this covers dev mode too.
app.setAppUserModelId("com.musepi.gui");

/** Cached window handle (single-window app). */
let mainWindow = null;
/** Debounce timer for main-window bounds persistence. */
let mainBoundsTimer = null;
/** Managed in-app browser (right-pane tool): WebContentsView + CDP bridge. */
const managedBrowser = new ManagedBrowserController();

// ── Agent companion pet window (伙伴, BitFun parity) ────────────────────
// A frameless, transparent, always-on-top companion window hosting pet.html.
// Created lazily on first show; the renderer drives it via IPC:
//   pet-toggle {visible}        show/hide (create on first show)
//   pet-drag-client {clientX}   anchor drag (renderer pointer drag)
//   pet-click                    focus the main window
//   pet-activity {mood, bubble}  main-window store → pet window
//   pet-import                   pick a Petdex zip, unpack, return package
// SINGLE WINDOW (merged 2026-09-16, killing the 双窗口 drift): the sprite,
// the activity bubbles and the interaction panel all live in THIS window —
// "bubble follows pet" positioning bugs are structurally impossible, there
// is one coordinate space and one window to move. The window is 320 wide
// and grows UPWARD (bottom edge fixed, so the sprite never moves on screen)
// when bubbles/panel need room (pet-set-content-size); it shrinks back to
// the 290 base height when they close.
// Height 290: the pet anchors at bottom:52px in pet-window.css with 52px of
// transparent room below — rest shadow (0 6px 16px ≈ 22px) and hover shadow
// (0 10px 22px ≈ 32px, + bump ≈ 2px) all fade inside the window instead of
// being hard-cut at the bottom edge.
const PET_WINDOW_SIZE = { width: 320, height: 290 };

// ── win32 topmost upkeep: level (2026-09-19) ────────────────────────────
// setAlwaysOnTop(true, "floating") is a one-shot z-order assertion. On win32
// the band is not sticky: the window manager demotes the window when another
// topmost window claims the band, when the pet is dragged against or snapped
// to a work-area edge, and across sleep/wake -- after which the pet silently
// sinks behind normal windows for the rest of the session.
//
// "pop-up-menu" sits above taskbar-level UI (clawd-on-desk uses the same level
// for the same reason); "floating" only clears ordinary windows.
//
// Declared HERE, next to PET_WINDOW_SIZE and above its first use in
// createPetWindow: a `const` read before its declaration is a TDZ throw, and
// the call chain that reaches it is long enough that the ordering would
// otherwise be an invisible trap.
const PET_TOPMOST_LEVEL = process.platform === "win32" ? "pop-up-menu" : "floating";

let petWindow = null;
let petVisible = false;
/** Last pet:activity payload — replayed to the pet window when it loads
 *  (the first bubble can arrive before the window's renderer subscribed;
 *  without the replay it is silently dropped). */
let lastPetActivity = null;

function petPosFile() {
	return path.join(app.getPath("userData"), "pet-pos.json");
}

function loadPetPosition() {
	try {
		const raw = fs.readFileSync(petPosFile(), "utf8");
		const pos = JSON.parse(raw);
		if (pos.dock === true || pos.dock === false) petDockEnabled = pos.dock;
		// Restore the measured spaces so restore/clamp/poll are consistent
		// with what was saved (before the window exists — no re-measure).
		petPosPhysical = pos.posPhysical === true;
		petCursorPhysical = pos.cursorPhysical === true;
		petPosScaleF = Number.isFinite(pos.scale) && pos.scale > 0 ? pos.scale : 1;
		if (Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
			// Coordinates are stored in DIP (converted at persist time when
			// the environment speaks physical). The stored rect must be fully
			// inside some display's DIP work area — macOS clamps out-of-bounds
			// frames at show time, which desyncs the stored position from the
			// real one (and makes the window jump back to the stale frame
			// when the click-through toggles). Fall back to the default
			// otherwise.
			//
			// The anchor is the pet's BOTTOM edge (see persistPetPos): the
			// window is recreated at BASE height, so a top-left `y` captured
			// while the overlay had grown the window would drop the pet by
			// the grown amount on next launch — and a bottom-near-edge rect
			// failed this visibility check outright, falling back to the
			// default corner (「拖拽的位置偏移」). `bottom` wins when present;
			// legacy files derive it from y+h — identical math whether the
			// stored h was base or grown.
			const storedBottom =
				Number.isFinite(pos.bottom) && pos.bottom > 0 ? pos.bottom : pos.y + (Number.isFinite(pos.h) ? pos.h : 0);
			const y = storedBottom - PET_WINDOW_SIZE.height;
			const w = PET_WINDOW_SIZE.width;
			const h = PET_WINDOW_SIZE.height;
			const visible = screen.getAllDisplays().some(d => {
				const b = d.workArea;
				return (
					pos.x >= b.x &&
					pos.x + w <= b.x + b.width &&
					y >= b.y &&
					y + h <= b.y + b.height
				);
			});
			if (visible) return { x: pos.x, y };
		}
	} catch {
		// first run — default below
	}
	// Default: bottom-right of the primary display's work area (DIP).
	const work = screen.getPrimaryDisplay().workArea;
	return { x: work.x + work.width - PET_WINDOW_SIZE.width - 16, y: work.y + work.height - PET_WINDOW_SIZE.height - 16 };
}

function createPetWindow() {
	if (petWindow && !petWindow.isDestroyed()) return petWindow;
	const pos = loadPetPosition();
	// Stored coordinates are DIP; convert into the environment's position
	// space (measured at the last drag / restored from pet-pos.json).
	const dipToPos = petPosPhysical ? petPosScaleF : 1;
	petWindow = new BrowserWindow({
		...PET_WINDOW_SIZE,
		x: Math.round(pos.x * dipToPos),
		y: Math.round(pos.y * dipToPos),
		title: "MusePi Pet",
		frame: false,
		// Pure transparent (no vibrancy): vibrancy + transparent:true
		// renders the WHOLE window as an opaque glass panel (verified —
		// the desktop pet became a solid dark rectangle). The bubbles fake
		// the glass with a translucent surface + highlight edge instead.
		transparent: true,
		// Explicit transparent background: on Windows a transparent window
		// without backgroundColor can composite with an opaque default
		// (white/black block around the pet). No-op on macOS.
		backgroundColor: "#00000000",
		alwaysOnTop: true,
		skipTaskbar: true,
		resizable: false,
		fullscreenable: false,
		hasShadow: false,
		webPreferences: {
			preload: path.join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			backgroundThrottling: false,
		},
	});
	petWindow.setAlwaysOnTop(true, PET_TOPMOST_LEVEL);
	petWindow.loadFile(path.join(DIST_DIR, "pet.html"));
	// Any renderer navigation (reload, crash-reload) resets the drag
	// anchor — the fresh renderer starts with no pressed state, so a
	// stale petDragLast would make its first hover move drag the window
	// (openpets' resetForNavigation pattern). Also replay the last
	// activity: the merged window consumes bubbles/approvals/state too,
	// and a first bubble can arrive before this window is ever created.
	petWindow.webContents.on("did-finish-load", () => {
		petDragLast = null;
		if (lastPetActivity) {
			setTimeout(() => {
				if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send("pet:activity", lastPetActivity);
			}, 150);
		}
	});
	// Click-through by default (transparent widget pattern): the 320×290
	// window must not block the desktop — the pet occupies only the bottom.
	// Ignore/hover is driven by a MAIN-PROCESS cursor poll (BitFun's
	// cursorPosition + hitbox approach): the renderer reports the
	// interactive rect (pet + bubble) via pet-set-hitbox, and a 120ms
	// timer compares screen.getCursorScreenPoint() against the window
	// bounds + hitbox, flipping setIgnoreMouseEvents accordingly. No
	// reliance on the macOS-only `forward` option (verified unreliable on
	// macOS 26) — the poll works on Windows identically (same coordinate
	// math, no event forwarding needed).
	if (process.platform === "darwin" || process.platform === "win32") {
		petWindow.setIgnoreMouseEvents(true);
	}
	petWindow.on("closed", () => {
		petWindow = null;
		petVisible = false;
		petDragLast = null;
		stopPetClickThroughPoll();
		stopPetTopmostWatchdog();
		petSyncApprovalHotkeys(); // pet gone → unregister the approval hotkeys
	});
	return petWindow;
}

/** Interactive rect (window-relative) reported by the pet renderer —
 *  null = nothing interactive. */
let petHitbox = null;
/** Sprite-only rect (window coords, CSS px). The dock snap aligns the
 *  CHARACTER flush to the screen edge — the window is ~320px wide while
 *  the sprite is centered, so window-edge alignment leaves the pet
 *  visibly ~90px off the edge. */
let petRect = null;
/** Sprite left edge in window coords (fallback: hitbox, then window). */
function petCharLeft() {
	return petRect ? petRect.x : petHitbox ? petHitbox.x : 0;
}
/** Sprite right edge in window coords. */
function petCharRight() {
	if (petRect) return petRect.x + petRect.width;
	if (petHitbox) return petHitbox.x + petHitbox.width;
	return PET_WINDOW_SIZE.width;
}
/** Last ignore state, so the poll only calls setIgnoreMouseEvents on change. */
let petIgnoreState = null;
/** Last hover state pushed to the pet window (drives the hover mood row). */
let petHoverState = null;
/**
 * Renderer pointer is DOWN on the pet but no move has been sent yet
 * (dragRef.pressed, before DRAG_THRESHOLD travel). The click-through poll
 * must not flip the window ignore state between down and the first
 * pet-drag-client — the renderer arms on pointerdown and disarms via
 * pet-drag-end (same channel as petDragLast's drag teardown).
 */
let petDragArmed = false;

// Drag anchor for pet-drag-client: the renderer sends window-relative
// client coords; main converts to screen space with the window position
// and diffs against this anchor. Window moves cancel out (position delta
// shifts clientX the other way), so the window tracks the pointer 1:1
// without the macOS Retina screenX logical/physical split. Non-null while
// a drag is in flight — also gates the click-through poll (F1).
let petDragLast = null;

// ── Drag-space calibration (renderer as ground truth, 2026-09-16) ───────
// Electron's DIP contract does NOT hold on every Windows environment
// (RDP / virtualized sessions / per-monitor DPI setups: the cursor API
// and/or the window APIs report physical px) — the old startup probes
// tried to detect this per machine, and the pure-DIP rewrite assumed the
// contract; both guess, and a wrong guess accumulates: the pet lags the
// cursor by (1 − 1/scale) per unit of travel, so "the farther you drag,
// the farther it falls behind". This measures instead.
//
// The pet renderer reports window.screenX/screenY alongside clientX/Y —
// Chromium's own on-screen position, DIP-true by construction and immune
// to whatever the OS window APIs do. While the window is stationary at
// drag start, one comparison each pins both spaces exactly:
//   cursorDIP = screenX + clientX           (window DIP + pointer-in-window DIP)
//   |raw − cursorDIP| small   → cursor API speaks DIP
//   |raw − cursorDIP×F| small → cursor API speaks physical (F = display scale)
//   getPosition vs screenX    → same test for the window position APIs
// The ratio (cursor-space units per position-space unit) then converts
// cursor travel into position space for the anchored drag; settle and the
// click-through poll convert CSS-px offsets the same way; persistence
// stores DIP so restore is space-consistent. No startup probes — the
// measurement happens at drag start, when the window is stationary and
// all three readings are mutually consistent.
let petCursorPhysical = false;
let petPosPhysical = false;
/** Display scale captured at the last calibration (persisted for restore). */
let petPosScaleF = 1;

/** CSS px (renderer DIP) → window-position space. */
function cssToPos(css) {
	return petPosPhysical ? css * petPosScaleF : css;
}

/** Cursor-space point → window-position space. */
function cursorToPos(point) {
	const k = (petCursorPhysical ? petPosScaleF : 1) / (petPosPhysical ? petPosScaleF : 1);
	return { x: point.x * k, y: point.y * k };
}

function calibrateDragSpace(clientX, clientY, screenX, screenY) {
	if (!petWindow || petWindow.isDestroyed()) return;
	if (!Number.isFinite(screenX) || !Number.isFinite(screenY) || !Number.isFinite(clientX) || !Number.isFinite(clientY)) {
		return;
	}
	// Scale precedence: the window's MEASURED DPI (win32, GetDpiForWindow)
	// beats Electron's display-matching guess. The guess has to pick a display
	// from the window rect and can land on a neighbour when the pet straddles
	// a boundary; the measured value is the factor Windows actually applies to
	// this window. Probing DPI *inside* an event (rather than on a timer) keeps
	// it on the same turn as the reading it will be compared against, so a
	// mid-drag DPI change cannot pair a stale factor with a fresh pointer.
	let scale = 0;
	let scaleRung = "measured";
	try {
		const dpi = win32Native.dpiForWindow(petWindow);
		if (Number.isFinite(dpi) && dpi > 0) scale = dpi / 96;
	} catch {
		// fall through to the display guess
	}
	if (!(scale > 0)) {
		const disp = screen.getDisplayMatching(petWindow.getBounds());
		scale = disp && disp.scaleFactor > 0 ? disp.scaleFactor : 1;
		scaleRung = "display-guess";
	}
	const raw = screen.getCursorScreenPoint();
	// The pointer has travelled the 8px drag threshold since pointerdown,
	// so the DIP estimate carries a small (~≤15px) baseline offset — orders
	// of magnitude below the ×F error a wrong hypothesis produces at any
	// real screen coordinate (e.g. ×1.25 at x=600 → 150px).
	const curDipX = screenX + clientX;
	const curDipY = screenY + clientY;
	const errCurDip = Math.abs(raw.x - curDipX) + Math.abs(raw.y - curDipY);
	const errCurPhys = Math.abs(raw.x - curDipX * scale) + Math.abs(raw.y - curDipY * scale);
	petCursorPhysical = errCurPhys < errCurDip;
	const [wx, wy] = petWindow.getPosition();
	const errPosDip = Math.abs(wx - screenX) + Math.abs(wy - screenY);
	const errPosPhys = Math.abs(wx - screenX * scale) + Math.abs(wy - screenY * scale);
	petPosPhysical = errPosPhys < errPosDip;
	petPosScaleF = scale;
	console.log(
		"[pet] drag-space calibrated:",
		JSON.stringify({
			scale,
			scaleSource: scaleRung,
			cursorPhysical: petCursorPhysical,
			posPhysical: petPosPhysical,
		}),
	);
}

// Dock-to-edge preference (settings → 宠物 → 挂靠左右侧): when enabled,
// dropping the pet within a margin of a screen edge snaps it flush to the
// work-area edge (with a visual dock indicator); when disabled, an
// out-of-bounds drop bounces back inside the work area.
let petDockEnabled = false;
/** Current dock side pushed to the pet renderer ("left" | "right" | null). */
let petDockSide = null;
/** Do-not-disturb: hide the pet for a fixed span, then bring it back.
 *  petDndUntil is the epoch ms the DND ends (null when inactive). */
let petDndTimer = null;
let petDndUntil = null;
/** 8-frame settle animation handle — cancelled if a drag starts mid-bounce. */
let petSettleTimer = null;

function cancelPetSettle() {
	if (petSettleTimer !== null) {
		clearInterval(petSettleTimer);
		petSettleTimer = null;
	}
}

/** Round a coordinate for setPosition. Math.round can yield -0 from
 *  fractional inputs (e.g. -0.335 → -0), and gin's int converter rejects
 *  -0 — and any fraction — with the "conversion failure from" TypeError. */
function intCoord(v) {
	const r = Math.round(v);
	return r === 0 ? 0 : r;
}

/** The single choke point for pet-window moves. gin only accepts int32:
 *  NaN, ±Infinity, fractions (Retina .5 DIP positions, e.g. -279.5), -0
 *  and beyond-±2^31 values (garbage from macOS multi-display coordinate
 *  flips) all throw the main-process "conversion failure from" dialog.
 *  Round + normalize here, drop the call when still not int32-safe.
 *
 *  COORDINATE CONTRACT (DIP everywhere, no runtime probes — 2026-09-16):
 *  Electron's documented contract on Windows is DIP for getPosition /
 *  setPosition / getCursorScreenPoint / workArea alike. The old code ran
 *  startup probes guessing DIP vs physical and multiplied by scaleFactor
 *  when a probe "detected" physical — a wrong guess (RDP, virtualized
 *  sessions, per-monitor DPI) scaled the whole drag loop and produced the
 *  non-100%-scaling drift. There are no probes anymore: every coordinate
 *  in this file is DIP, and the drag loop never reads the position back
 *  mid-drag (the old same-value guard read getPosition on every frame,
 *  feeding the async-setPosition feedback loop behind "keeps drifting
 *  while I hold the mouse still").
 *
 *  Update 2026-09-19: the contract above is still the point of departure, but
 *  the POSITION WRITE now reconciles (see setPetBounds). The contract tells us
 *  which units to speak; reconciliation handles the rounding the compositor
 *  applies when it converts DIP to physical pixels — the two are complementary,
 *  not alternatives. That subtlety is why setPetBounds is the ONLY position
 *  writer left: it reads the live rect before deciding to write, so an OS-side
 *  correction is never silently overwritten from a stale anchor.
 *
 *  int32-only: gin accepts nothing else. NaN, ±Infinity, fractions (Retina
 *  .5 DIP positions, e.g. -279.5), -0 and beyond-±2^31 values (garbage from
 *  macOS multi-display coordinate flips) all throw the main-process
 *  "conversion failure from" dialog. intCoord() rounds + normalizes;
 *  setPetBounds drops the write when the result is still not int32-safe. */

// ── Write choke point with read-back reconciliation (2026-09-19) ────────
// win32's SetWindowPos converts DIP → physical pixels per-monitor and rounds;
// the desktop window manager may additionally snap or clamp near edges. Writing
// the position alone leaves every one of those corrections UNAPPLIED to the
// anchor the drag loop works from — the delta is re-derived from a stale
// assumption on the next frame, so the error accumulates and the pet ends up
// permanently offset from the cursor by the time the user releases.
//
// setPetBounds() therefore reads the live rect first and only writes when it
// actually differs (clawd-on-desk's applyPetWindowBounds pattern) — a no-op
// frame costs one getBounds() and no native write, and a frame that DID get
// corrected by the OS is immediately visible to the next delta.
//
// setBounds() (not setPosition()) so width/height travel with the write: the
// content-driven height path changes the rect's height and y together, and
// splitting that into setPosition + setSize gives the compositor an
// intermediate frame at the wrong size.
//
// Every coordinate here is DIP (see the contract note above). This function
// does NOT convert spaces — it only normalizes to int32-safe values.
function setPetBounds(win, rect) {
	if (!win || win.isDestroyed()) return false;
	const x = intCoord(rect.x);
	const y = intCoord(rect.y);
	const w = intCoord(rect.width);
	const h = intCoord(rect.height);
	if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) {
		console.error("[pet] dropped invalid setBounds:", rect);
		return false;
	}
	if (Math.abs(x) > 1e7 || Math.abs(y) > 1e7 || w <= 0 || h <= 0 || w > 1e5 || h > 1e5) {
		console.error("[pet] dropped out-of-range setBounds:", rect);
		return false;
	}
	const cur = win.getBounds();
	if (cur.x === x && cur.y === y && cur.width === w && cur.height === h) return false;
	win.setBounds({ x, y, width: w, height: h });
	return true;
}

/** Move the pet window, preserving its current size. Position-only callers go
 *  through the same reconciliation choke point as the rect callers. */
function setPetPosition(x, y) {
	if (!petWindow || petWindow.isDestroyed()) return false;
	const b = petWindow.getBounds();
	return setPetBounds(petWindow, { x, y, width: b.width, height: b.height });
}

// ── win32 topmost upkeep: watchdog (2026-09-19) ─────────────────────────
// 5s watchdog: cheap (one setAlwaysOnTop call), and the z-order loss it
// repairs is otherwise permanent. Runs only while the pet is visible.
const PET_TOPMOST_WATCHDOG_MS = 5000;
let petTopmostWatchdog = null;

/** True when `b` touches (or crosses) an edge of the work area containing its
 *  center. Tolerance 2 covers the rounding of a flush dock. Displays can be
 *  unavailable mid-topology-change, so a failure reads as "not near an edge"
 *  — the watchdog is the backstop for that case. */
function isNearWorkAreaEdge(b) {
	if (!b) return false;
	try {
		const wa = screen.getDisplayMatching(b).workArea;
		const T = 2;
		return (
			b.x <= wa.x + T ||
			b.y <= wa.y + T ||
			b.x + b.width >= wa.x + wa.width - T ||
			b.y + b.height >= wa.y + wa.height - T
		);
	} catch {
		return false;
	}
}

/**
 * Whether to stand down from the topmost band this tick.
 *
 * The foreground probe is a native call (win32-native.cjs, koffi → user32):
 * Electron's BrowserWindow.isFullScreen() only reports OUR OWN windows, so it
 * cannot see a fullscreen game. Without the probe the 5s watchdog claws the
 * z-order band back over a fullscreen app on every tick — the classic
 * desktop-pet annoyance.
 *
 * The probe fails open to "not fullscreen", i.e. the pet keeps its pre-FFI
 * behaviour if koffi or a DLL is unavailable.
 */
function shouldStandDownForFullscreen() {
	// Ours first: cheap, and always authoritative for our own windows.
	const ours = [mainWindow, miniWindow];
	if (ours.some(w => w && !w.isDestroyed() && w.isFullScreen && w.isFullScreen())) return true;
	return win32Native.isForegroundFullscreen();
}

function reassertPetTopmost() {
	if (process.platform !== "win32") return;
	if (!petWindow || petWindow.isDestroyed()) return;
	petWindow.setAlwaysOnTop(true, PET_TOPMOST_LEVEL);
}

function startPetTopmostWatchdog() {
	if (process.platform !== "win32") return;
	if (petTopmostWatchdog !== null) return;
	petTopmostWatchdog = setInterval(() => {
		if (!petVisible || !petWindow || petWindow.isDestroyed()) return;
		// DWM cloak runs FIRST and independently of the stand-down: a cloaked
		// pet is invisible while every JS-visible signal (isVisible,
		// WS_VISIBLE) stays green, so this is the only place it can be caught.
		// Sleep/wake and RDP reconnects are the prime cloak moments.
		recoverCloakedPet();
		// Never fight a fullscreen app for the z-order band.
		if (shouldStandDownForFullscreen()) return;
		reassertPetTopmost();
	}, PET_TOPMOST_WATCHDOG_MS);
}

/** Self-heal state for the cloak probe. */
let petCloakFailStreak = 0;
const PET_CLOAK_BACKOFF_BASE_MS = 10000;
const PET_CLOAK_BACKOFF_MAX_MS = 120000;

/**
 * Repair a DWM-cloaked pet window.
 *
 * Only APP (self-inflicted) cloaks are cleared. A SHELL cloak is frequently
 * legitimate — the user parked the window on another virtual desktop — and
 * un-cloaking it would drag the pet onto the desktop the user is looking at,
 * which is not our call. Without the IVirtualDesktopManager COM query that
 * distinguishes the two (clawd-on-desk does this via manual vtable dispatch)
 * we cannot tell them apart, so we recover conservatively: APP and
 * APP|INHERITED only.
 *
 * Backs off exponentially after a failure so a persistently-cloaked window
 * does not get hammered every tick.
 */
function recoverCloakedPet() {
	if (!petWindow || petWindow.isDestroyed()) return;
	if (petCloakCooldownUntil > Date.now()) return;
	const flag = win32Native.readCloakState(petWindow);
	if (flag === 0) {
		petCloakFailStreak = 0;
		return;
	}
	if ((flag & CLOAK_APP) === 0) return; // SHELL-only: likely another desktop
	console.log(`[pet] DWM cloak detected (flag=${flag}); attempting un-cloak`);
	if (!win32Native.uncloak(petWindow)) {
		petCloakFailStreak += 1;
		petCloakCooldownUntil =
			Date.now() + Math.min(PET_CLOAK_BACKOFF_BASE_MS * 2 ** petCloakFailStreak, PET_CLOAK_BACKOFF_MAX_MS);
		return;
	}
	// DWM accepted it; re-show and re-top. showInactive so we never steal focus.
	petWindow.showInactive();
	reassertPetTopmost();
	if (win32Native.readCloakState(petWindow) === 0) {
		petCloakFailStreak = 0;
		petCloakCooldownUntil = 0;
		console.log("[pet] DWM cloak cleared");
	} else {
		petCloakFailStreak += 1;
		petCloakCooldownUntil =
			Date.now() + Math.min(PET_CLOAK_BACKOFF_BASE_MS * 2 ** petCloakFailStreak, PET_CLOAK_BACKOFF_MAX_MS);
	}
}
let petCloakCooldownUntil = 0;

function stopPetTopmostWatchdog() {
	if (petTopmostWatchdog !== null) {
		clearInterval(petTopmostWatchdog);
		petTopmostWatchdog = null;
	}
}

/** Dock or clamp the pet window inside the work area after a drag. */
function settlePetWindow() {
	if (!petWindow || petWindow.isDestroyed()) return;
	cancelPetSettle();
	const waRaw = screen.getDisplayMatching(petWindow.getBounds()).workArea;
	const [wx, wy] = petWindow.getPosition();
	// Use the ACTUAL window size — a stale 320×290 assumption would let a
	// 340-wide (panel-open) window hang 20px past the right edge.
	const { width: w, height: h } = petWindow.getBounds();
	// Work-area space detection: window APIs should share one space, but
	// virtualized environments disagree. If the position sits outside the
	// unscaled work area yet inside the ×F one, scale the area to match —
	// otherwise the clamp would shove the pet to a wrong edge.
	const insideArea = a => wx >= a.x && wy >= a.y && wx <= a.x + a.width && wy <= a.y + a.height;
	let wa = waRaw;
	if (!insideArea(wa) && petPosScaleF !== 1) {
		const scaled = {
			x: waRaw.x * petPosScaleF,
			y: waRaw.y * petPosScaleF,
			width: waRaw.width * petPosScaleF,
			height: waRaw.height * petPosScaleF,
		};
		if (insideArea(scaled)) wa = scaled;
	}
	// Sprite offsets are renderer CSS px — convert to position space so the
	// dock alignment aligns the CHARACTER flush to the edge on every
	// environment (the sprite is centered, so window-edge alignment would
	// leave the pet visibly ~90px off the edge).
	const cssK = petPosPhysical ? petPosScaleF : 1;
	const charL = petCharLeft() * cssK;
	const charR = petCharRight() * cssK;
	let x = wx;
	let y = wy;
	let side = null;
	if (petDockEnabled) {
		const MARGIN = 32 * cssK;
		if (wx + charL <= wa.x + MARGIN) {
			x = wa.x - charL;
			side = "left";
		} else if (wx + charR >= wa.x + wa.width - MARGIN) {
			x = wa.x + wa.width - charR;
			side = "right";
		}
		y = Math.min(Math.max(wy, wa.y), wa.y + wa.height - h);
	} else {
		x = Math.min(Math.max(wx, wa.x), wa.x + wa.width - w);
		y = Math.min(Math.max(wy, wa.y), wa.y + wa.height - h);
	}
	if (x !== wx || y !== wy) {
		// Short ease-out bounce to the settle position (180ms, 8 frames).
		// setPetPosition drops any frame whose value is not int32-safe
		// (coordinate-flip garbage) instead of crashing the main process,
		// and skips the native write when the rect already matches.
		// Windows: no glide — the release slide reads as "keeps moving
		// after I stopped" (the OS window move is less tight than macOS's,
		// so the bounce is far more visible); snap to the settle position.
		if (process.platform === "win32") {
			setPetPosition(x, y);
			// The snapped rect may straddle a work-area edge, which is
			// exactly where win32 drops the topmost band.
			reassertPetTopmost();
		} else {
			const fromX = wx;
			const fromY = wy;
			let frame = 0;
			petSettleTimer = setInterval(() => {
				frame += 1;
				const t = frame / 8;
				const ease = 1 - Math.pow(1 - t, 3);
				setPetPosition(fromX + (x - fromX) * ease, fromY + (y - fromY) * ease);
				if (frame >= 8) {
					clearInterval(petSettleTimer);
					petSettleTimer = null;
				}
			}, 20);
		}
	}
	if (side !== petDockSide && !petWindow.isDestroyed()) {
		petDockSide = side;
		petWindow.webContents.send("pet:dock", { side });
	}
}

// ── Topology / wake self-heal (2026-09-19) ──────────────────────────────
// Three ways the pet strands itself off-screen or at the wrong size, none of
// which any single event covers:
//
//  1. display-removed — the saved/window rect lives in a coordinate space that
//     no longer exists (the monitor is unplugged; on win32 its origin can be
//     negative, or overlap another display's). The pet is simply unreachable
//     until restart, because loadPetPosition() rejects the stale rect next
//     launch and silently falls back to the default corner.
//  2. display-metrics-changed — DPI change / RDP reconnect. Arrives in BURSTS;
//     clamping on every event makes the pet visibly jitter mid-transition, so
//     the geometry work is debounced to the settled state (clawd-on-desk does
//     exactly this, and it is why removed/added stay immediate below).
//  3. sleep/wake — the DPI flux on resume can leave the HWND with a stale size
//     (repeatedly re-writing the drifted size "ratchets" it larger each cycle:
//     clawd's #408, "the longer it sleeps, the bigger it gets"). We pin the
//     size back to PET_WINDOW_SIZE instead of trusting the current one.
//
// Everything here is best-effort and must never throw into an event handler.
const PET_METRICS_DEBOUNCE_MS = 400;
let petMetricsTimer = null;

/** Nearest work area to a point, with a primary-display fallback. Displays can
 *  be momentarily empty during a topology change (clawd #93: reading
 *  displays[0] on an empty array crashes), so this never assumes an array. */
function petNearestWorkArea(x, y) {
	try {
		return screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) }).workArea;
	} catch {
		// fall through
	}
	try {
		return screen.getPrimaryDisplay().workArea;
	} catch {
		return null;
	}
}

/**
 * Pull the pet back into a real work area and restore its expected size.
 *
 * Deliberately positional-only when the rect is still valid: a user who
 * parked the pet in a specific spot must not be moved to the center by a
 * routine DPI event. Only a rect that is genuinely unreachable (its center
 * falls outside EVERY display) gets relocated.
 */
function reconcilePetWindow(reason) {
	if (!petWindow || petWindow.isDestroyed()) return;
	let b;
	try {
		b = petWindow.getBounds();
	} catch {
		return;
	}
	// Is the window reachable at all? Test the CENTER: a window half-off a
	// screen is still findable by the user, a center outside every work area
	// means truly gone.
	let displays = [];
	try {
		displays = screen.getAllDisplays();
	} catch {
		// leave empty — treated as "unknown", never as "gone"
	}
	const cx = b.x + b.width / 2;
	const cy = b.y + b.height / 2;
	const reachable =
		displays.length === 0 ||
		displays.some(d => {
			const wa = d.workArea;
			return cx >= wa.x && cx < wa.x + wa.width && cy >= wa.y && cy < wa.y + wa.height;
		});

	// Size is ALWAYS restored: the wake DPI flux is what ratchets it, and
	// PET_WINDOW_SIZE is the single source of truth for the desired width.
	const needsSize = b.width !== PET_WINDOW_SIZE.width || b.height !== PET_WINDOW_SIZE.height;

	if (!reachable) {
		const wa = petNearestWorkArea(
			Number.isFinite(cx) ? cx : 0,
			Number.isFinite(cy) ? cy : 0,
		);
		if (wa) {
			const x = wa.x + Math.max(0, Math.round((wa.width - PET_WINDOW_SIZE.width) / 2));
			const y = wa.y + Math.max(0, Math.round((wa.height - PET_WINDOW_SIZE.height) / 2));
			console.log(`[pet] reconcile (${reason}): rect unreachable, recentering`);
			setPetBounds(petWindow, { x, y, ...PET_WINDOW_SIZE });
			petPosDirty = true;
		}
	} else if (needsSize) {
		// Keep the bottom edge fixed: the sprite is anchored to the window
		// bottom, so growing upward never moves the pet on screen.
		const y = b.y + b.height - PET_WINDOW_SIZE.height;
		console.log(`[pet] reconcile (${reason}): size ${b.width}x${b.height} → PET_WINDOW_SIZE`);
		setPetBounds(petWindow, { x: b.x, y, ...PET_WINDOW_SIZE });
		petPosDirty = true;
	}
	reassertPetTopmost();
}

function scheduleReconcileAfterMetrics() {
	if (petMetricsTimer !== null) clearTimeout(petMetricsTimer);
	petMetricsTimer = setTimeout(() => {
		petMetricsTimer = null;
		reconcilePetWindow("display-metrics-changed");
	}, PET_METRICS_DEBOUNCE_MS);
}

function installPetDisplayListeners() {
	if (petDisplayListenersInstalled) return;
	petDisplayListenersInstalled = true;
	// Immediate: these rescue the pet off a display that just vanished or
	// appeared, and must not wait out the metrics debounce.
	screen.on("display-removed", () => reconcilePetWindow("display-removed"));
	screen.on("display-added", () => reconcilePetWindow("display-added"));
	// Debounced: DPI changes and RDP reconnects fire in bursts, and clamping
	// on each event jitters the pet through the whole transition.
	screen.on("display-metrics-changed", scheduleReconcileAfterMetrics);
}
let petDisplayListenersInstalled = false;

function updatePetClickThrough() {
	if (!petWindow || petWindow.isDestroyed() || !petVisible) return;
	// darwin + win32: transparent pet window must not block the desktop.
	// (Linux stays fully interactive — unverified on the same poll path.)
	if (process.platform !== "darwin" && process.platform !== "win32") return;
	let ignore = true;
	// Never click-through mid-drag: pointer capture depends on the window
	// receiving events. petDragArmed covers pointerdown-before-first-move
	// (the renderer arms on down, disarms via pet-drag-end); petDragLast
	// covers an in-flight drag (armed on the first pet-drag-client).
	if (petDragArmed || petDragLast !== null) {
		ignore = false;
	} else if (petHitbox) {
		// All three spaces (cursor / window position / renderer CSS px) are
		// converted into window-position space before comparing — on a
		// contract-holding machine every factor is 1 (zero cost).
		const cursor = cursorToPos(screen.getCursorScreenPoint());
		const [wx, wy] = petWindow.getPosition();
		const hx = wx + cssToPos(petHitbox.x);
		const hy = wy + cssToPos(petHitbox.y);
		ignore = !(
			cursor.x >= hx &&
			cursor.x <= hx + cssToPos(petHitbox.width) &&
			cursor.y >= hy &&
			cursor.y <= hy + cssToPos(petHitbox.height)
		);
	}
	if (ignore !== petIgnoreState) {
		petIgnoreState = ignore;
		petWindow.setIgnoreMouseEvents(ignore);
	}
	// Push hover to the pet window on change: it must switch to the hover
	// mood row even when the window flips click-through (pointerleave may
	// never fire once the window stops receiving events).
	const hovering = !ignore;
	if (hovering !== petHoverState && !petWindow.isDestroyed()) {
		petHoverState = hovering;
		petWindow.webContents.send("pet:hover", hovering);
	}
	// Gaze piggybacks on this same poll: the cursor is already in hand, so
	// eye-following costs one subtraction and a bounded send. The vector is
	// the cursor offset from the window centre, normalized by GAZE_RANGE
	// CSS px (full deflection well before the screen edge) and clamped —
	// the renderer eases the eyes toward it, so 120ms updates read smooth.
	if (!petWindow.isDestroyed()) {
		const cursor = cursorToPos(screen.getCursorScreenPoint());
		const bounds = petWindow.getBounds();
		const cx = petWindow.getPosition()[0] + cssToPos(bounds.width / 2);
		const cy = petWindow.getPosition()[1] + cssToPos(bounds.height / 2);
		const range = Math.max(1, cssToPos(PET_GAZE_RANGE_CSS));
		let gx = (cursor.x - cx) / range;
		let gy = (cursor.y - cy) / range;
		const len = Math.hypot(gx, gy);
		if (len > 1) {
			gx /= len;
			gy /= len;
		}
		if (
			!petGazeState ||
			Math.abs(gx - petGazeState.x) > PET_GAZE_EPSILON ||
			Math.abs(gy - petGazeState.y) > PET_GAZE_EPSILON
		) {
			petGazeState = { x: gx, y: gy };
			petWindow.webContents.send("pet:gaze", petGazeState);
		}
	}
}

/** Gaze-following tuning: full eye deflection at this many CSS px from
 *  the window centre, and the minimum vector change worth an IPC send.
 *
 *  RANGE was 420 — too wide: the useful deflection band (where the eyes are
 *  actually chasing the cursor) collapsed into the first ~1/3 of the travel
 *  and the rest of the screen produced identical full deflection, so the
 *  tracking read as sluggish and weak (user report 2026-09-20). 260px puts
 *  a normal desktop working distance inside the range, so moving the mouse
 *  across the pet's own neighbourhood sweeps the eyes across their full
 *  arc. Combined with the raised GAZE_TRAVEL (pet-face.ts) the follow is
 *  both larger and more responsive. */
const PET_GAZE_RANGE_CSS = 260;
const PET_GAZE_EPSILON = 0.01;
/** Last pushed gaze vector — also the "window hidden" reset handle. */
let petGazeState = null;

// BitFun's pointer poll interval; cheap and bounded. Runs ONLY while the
// pet is visible — an always-on 120ms interval would wake the main process
// (and hit screen.getCursorScreenPoint) even on machines that never enable
// the pet. Started by setPetVisible(true), stopped on hide/close.
let petClickThroughTimer = null;

function startPetClickThroughPoll() {
	if (petClickThroughTimer !== null) return;
	petClickThroughTimer = setInterval(updatePetClickThrough, 120);
}

function stopPetClickThroughPoll() {
	if (petClickThroughTimer !== null) {
		clearInterval(petClickThroughTimer);
		petClickThroughTimer = null;
	}
}

/** Clear a pending DND without touching visibility. */
function clearPetDnd() {
	if (petDndTimer !== null) {
		clearTimeout(petDndTimer);
		petDndTimer = null;
	}
	petDndUntil = null;
}

/** Hide the pet for `minutes`, then restore it automatically. */
function startPetDnd(minutes) {
	const ms = Math.max(1, Math.floor(Number(minutes) || 30)) * 60000;
	clearPetDnd();
	setPetVisible(false);
	petDndUntil = Date.now() + ms;
	petDndTimer = setTimeout(() => {
		petDndTimer = null;
		petDndUntil = null;
		if (!petVisible) setPetVisible(true);
	}, ms);
}

/** Cancel an active DND and show the pet again. */
function cancelPetDnd() {
	if (petDndTimer === null && petDndUntil === null) return;
	clearPetDnd();
	setPetVisible(true);
}

function setPetVisible(visible) {
	if (visible) {
		// A manual show (settings toggle, context menu) also exits DND.
		clearPetDnd();
		const win = createPetWindow();
		win.showInactive();
		petVisible = true;
		installPetDisplayListeners();
		startPetClickThroughPoll();
		startPetTopmostWatchdog();
	} else if (petWindow && !petWindow.isDestroyed()) {
		petWindow.hide();
		petVisible = false;
		stopPetClickThroughPoll();
		stopPetTopmostWatchdog();
		// A hide mid-drag can drop the pointerup; a stale anchor would
		// jump the window on the first move of the next drag.
		petDragLast = null;
	}
	// Approval hotkeys follow the pet's visibility (registered only while
	// the pet window is showing AND an approval is pending).
	petSyncApprovalHotkeys();
}

// Position persistence is throttled: a sync fs write per pointermove
// (~60-125Hz during a drag) would jank the main process. At most one
// write per 150ms while dragging; the final position is flushed by
// pet-drag-end (and pet-drag-client's anchor lives in petDragLast).
let petLastPosWrite = 0;
/** Set when a throttled write was skipped, so drag-end can flush it. Resolved
 *  lazily at use sites (`let` hoisting would otherwise TDZ-reject an early
 *  reconcile during startup display events). */
let petPosDirty = false;

function persistPetPos() {
	if (!petWindow || petWindow.isDestroyed()) return;
	try {
		// Persist the FULL rect, converted to DIP (position space → DIP via
		// the measured environment factor) plus the space flags — the
		// restore validates in DIP and converts back on placement, so the
		// stored file is space-consistent across environments.
		const dip = petPosPhysical ? petPosScaleF : 1;
		const [x, y] = petWindow.getPosition();
		const [w, h] = petWindow.getSize();
		fs.writeFileSync(
			petPosFile(),
			JSON.stringify({
				x: x / dip,
				y: y / dip,
				w: w / dip,
				h: h / dip,
				// The pet's BOTTOM edge, in DIP. The restore recreates the
				// window at BASE height (bubbles/panel grow the window upward
				// at runtime), so the top-left `y` alone is the wrong anchor:
				// saved while the panel was open it restored the pet h−290px
				// higher than where the user left it — and a bottom-near
				// work-area-edge rect failed the visibility check outright,
				// falling back to the default corner (「拖拽的位置偏移」).
				// The bottom edge is the invariant the sprite hangs from
				// (reconcile keeps it fixed too).
				bottom: (y + h) / dip,
				dock: petDockEnabled,
				posPhysical: petPosPhysical,
				cursorPhysical: petCursorPhysical,
				scale: petPosScaleF,
			}),
		);
	} catch {
		// position persistence is best-effort
	}
}

function flushPetPos() {
	if (!petPosDirty) return;
	petPosDirty = false;
	persistPetPos();
}

function focusMainFromPet() {
	if (mainWindow && !mainWindow.isDestroyed()) {
		if (process.platform === "darwin") app.focus({ steal: true });
		if (mainWindow.isMinimized()) mainWindow.restore();
		mainWindow.show();
		mainWindow.focus();
	}
}

// (The 2026-09-16 single-window merge killed the old bubble-window section
// that used to live here — bubbles/panel are DOM in the pet window now; see
// pet-set-content-size for the only geometry they still negotiate.)
// Tray diag — file log (stdout is buffered/unreliable under start /b).
const TRAY_DIAG = path.join(os.tmpdir(), "musepi-tray-diag.log");
function trayLog(msg) {
	try { fs.appendFileSync(TRAY_DIAG, `${new Date().toISOString()} ${msg}\n`); } catch {}
}

// ── Self-drawn frosted tray menu (win32) ─────────────────────────────────
// The native Electron Menu renders as a classic Win32 menu on Windows —
// no acrylic. Windows 11 gets a real BrowserWindow with DWM Acrylic that
// pops above the tray icon (the same material the main window uses);
// macOS/Linux keep the native Menu (system vibrancy / theme glass).
let trayMenuWindow = null;
// Fixed-size tray menu: the renderer lays out internally and scrolls when
// content overflows (sessions + provider usage can outgrow the window), so
// the main process never resizes it dynamically.
const TRAY_MENU_HEIGHT = 440;
let trayMenuLastShow = 0;

function createTrayMenuWindow() {
	if (trayMenuWindow && !trayMenuWindow.isDestroyed()) return trayMenuWindow;
	trayMenuWindow = new BrowserWindow({
		width: 316,
		height: TRAY_MENU_HEIGHT,
		title: "MusePi",
		frame: false,
		// Self-drawn frosted menu surface (tray.cjs routes BOTH win32 and
		// darwin here — macOS switched off the native Menu on 2026-08-17):
		// - macOS: system "popover" vibrancy (the menu-bar material) on a
		//   NON-transparent window — transparent + vibrancy renders an
		//   opaque panel (pet window lesson). Without vibrancy the window
		//   was fully transparent and the menu floated bare on the desktop.
		// - Windows 11: DWM Acrylic (backgroundMaterial, opaque window).
		// - Windows 10 / Linux: transparent per-pixel window; the renderer
		//   self-draws the glass surface (.gui-tray-menu background).
		transparent: !(process.platform === "darwin" || (process.platform === "win32" && IS_WIN11)),
		...(process.platform === "darwin" ? { vibrancy: "popover" } : {}),
		...(process.platform === "win32" && IS_WIN11 ? { backgroundMaterial: "acrylic" } : {}),
		backgroundColor: "#00000000",
		alwaysOnTop: true,
		skipTaskbar: true,
		resizable: false,
		fullscreenable: false,
		show: false,
		webPreferences: {
			preload: path.join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			backgroundThrottling: false,
		},
	});
	trayMenuWindow.setAlwaysOnTop(true, "pop-up-menu");
	trayMenuWindow.loadFile(path.join(DIST_DIR, "tray-menu.html"));
	// Diag: is the preload bridge actually exposed to this window?
	trayMenuWindow.webContents.on("did-finish-load", () => {
		trayMenuWindow?.webContents
			.executeJavaScript("JSON.stringify({ api: typeof window.electronAPI, tray: typeof window.electronAPI?.trayMenu })")
			.then(t => trayLog(`bridges ${t}`))
			.catch(err => trayLog(`bridge check err: ${err?.message}`));
	});
	trayMenuWindow.webContents.on("preload-error", (_e, preloadPath, error) => {
		trayLog(`preload-error ${preloadPath}: ${error?.message}`);
	});
	trayMenuWindow.webContents.on("console-message", (event) => {
		trayLog(`renderer: ${event.message}`);
	});
	// Click-away closes the menu — but DEBOUNCED: a blur can fire while
	// the click that should activate a menu button is in flight (window
	// activation races the pointer-down), and hiding immediately would
	// eat the click. Only hide if still unfocused 150ms later.
	let blurTimer = null;
	trayMenuWindow.on("blur", () => {
		if (Date.now() - trayMenuLastShow < 200) return; // focus race after show
		if (blurTimer) clearTimeout(blurTimer);
		blurTimer = setTimeout(() => {
			if (trayMenuWindow && !trayMenuWindow.isDestroyed() && !trayMenuWindow.isFocused()) {
				trayLog("menu hide (blur, still unfocused)");
				trayMenuWindow.hide();
			}
		}, 150);
	});
	trayMenuWindow.on("focus", () => {
		if (blurTimer) {
			clearTimeout(blurTimer);
			blurTimer = null;
		}
	});
	return trayMenuWindow;
}

function positionTrayMenu(win, bounds) {
	const [width, height] = win.getSize();
	// macOS click events may carry no bounds at all; the caller (tray.cjs)
	// falls back to tray.getBounds(), but guard against NaN/missing here
	// too — the menu must never end up off-screen.
	const b = bounds && Number.isFinite(bounds.x) && Number.isFinite(bounds.y) ? bounds : null;
	if (!b) {
		const work = screen.getPrimaryDisplay().workArea;
		if (process.platform === "darwin") {
			// Menu bar sits at the top: dock to the top-right corner, NOT
			// the bottom (the old hardcoded corner rendered the menu in the
			// wrong half of the screen on macOS).
			win.setPosition(Math.round(work.x + work.width - width - 12), Math.round(work.y + 4));
		} else {
			win.setPosition(Math.round(work.x + work.width - width - 12), Math.round(work.y + work.height - height - 12));
		}
		return;
	}
	const display = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
	const work = display.workArea;
	// Windows taskbar sits at the bottom by default: pop the menu ABOVE
	// the icon, right-aligned with the tray column. Taskbar on top/side:
	// clamp inside the work area.
	// macOS: the menu-bar icon sits at the very top — drop the menu just
	// BELOW the icon (bounds.y + height), right-aligned to the tray area.
	if (process.platform === "darwin") {
		const x = Math.max(work.x + 12, work.x + work.width - width - 12);
		const y = bounds.y + bounds.height + 4;
		win.setPosition(Math.round(x), Math.round(Math.max(work.y, Math.min(y, work.y + work.height - height - 12))));
		return;
	}
	const right = work.x + work.width - 12;
	const x = Math.max(work.x + 12, right - width);
	const y = bounds.y - height - 10;
	win.setPosition(Math.round(x), Math.round(y < work.y ? work.y + 12 : y));
}

function toggleTrayMenu(bounds) {
	const win = createTrayMenuWindow();
	if (win.isVisible()) {
		trayLog("menu hide (was visible)");
		win.hide();
		return;
	}
	positionTrayMenu(win, bounds);
	trayMenuLastShow = Date.now();
	if (win.webContents.isLoading()) {
		// First open: the window was just created and tray-menu.html is
		// still loading — showing now paints a blank/frosted rectangle
		// (the "delayed menu" on Windows). Position first, reveal once the
		// renderer finished, so the first click opens a fully-rendered menu.
		trayLog("menu show (waiting for load)");
		win.webContents.once("did-finish-load", () => {
			if (trayMenuWindow === win && !win.isDestroyed()) {
				win.show();
				win.focus();
			}
		});
		return;
	}
	win.show();
	win.focus();
	// Windows focus races the pointer click that opened the menu — the
	// window can blur immediately after show() even though it is about to
	// receive the click. Ignore blurs in the 200ms after showing.
	trayLog(`menu show at ${JSON.stringify(win.getBounds())} focused=${win.isFocused()}`);
}

function hideTrayMenu() {
	if (trayMenuWindow && !trayMenuWindow.isDestroyed()) trayMenuWindow.hide();
}

// Tray menu window IPC — actions reuse the shared tray action router.
ipcMain.on("tray-menu:action", (_event, payload) => {
	trayLog(`ipc action ${JSON.stringify(payload)}`);
	const { type, ...params } = payload ?? {};
	handleTrayAction({ type, ...params });
	if (type !== "quit") hideTrayMenu();
});

// ── Single-window content sizing (merged 2026-09-16) ────────────────────
// Bubbles and the interaction panel used to live in their own window that
// chased the pet window on every move (syncBubbleWindow) — the source of
// the relative-drift bug family. They now render INSIDE the pet window;
// the only main-process job left is growing/shrinking the window upward
// (bottom edge fixed → the sprite never moves on screen) via pet-set-
// content-size, handled next to the other pet IPC handlers below.

// ── Menu-bar tray (openchamber tray parity) ─────────────────────────────
// Sessions are polled from the daemon (session.list over the daemon
// WebSocket, same port file the renderer's RPC client uses) so the menu
// stays live even when the main window is closed. Clicking a row routes
// through the same pet:open-session bridge the pet panel uses.
let trayController = null;
let trayWs = null;
let trayPollTimer = null;
let trayClosed = false;

function traySend(method, params) {
	if (!trayWs || trayWs.readyState !== 1 /* OPEN */) return;
	trayWs.send(JSON.stringify({ jsonrpc: "2.0", id: "tray", method, params }));
}

function trayFetchState() {
	traySend("tray.state", {});
}

// Request/reply on the same tray socket. `traySend` above is fire-and-forget
// under the shared "tray" id (state pushes use it); the "always allow" write
// below needs the answer (read-modify-write of the approval policy record), so
// it takes a unique id and settles through this map. The onmessage handler
// resolves pending ids first and only then treats "tray" frames as state.
let trayRequestSeq = 0;
const trayPending = new Map();

function trayRequest(method, params, timeoutMs = 4000) {
	if (!trayWs || trayWs.readyState !== 1 /* OPEN */) return Promise.resolve(null);
	const id = `tray-r${++trayRequestSeq}`;
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			trayPending.delete(id);
			resolve(null);
		}, timeoutMs);
		trayPending.set(id, (result) => {
			clearTimeout(timer);
			resolve(result);
		});
		try {
			trayWs.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
		} catch {
			clearTimeout(timer);
			trayPending.delete(id);
			resolve(null);
		}
	});
}

/**
 * Tray "always allow": persist `tools.approval.<tool> = "allow"` so the next
 * call of the same tool skips the prompt. The approval wrapper reads the
 * record live on every call (`wrapper.ts` `settings.get("tools.approval")`),
 * so no relaunch is needed. Read-modify-write: `settings.set` replaces the
 * whole record, so the other tools' policies must survive.
 *
 * Best-effort by design — a failure leaves the one-off approval that was
 * already sent, which is strictly better than silently dropping the click.
 */
async function rememberToolApproval(tool) {
	try {
		const current = await trayRequest("settings.get", { keys: ["tools.approval"] });
		const existing = current?.["tools.approval"];
		const record = existing && typeof existing === "object" && !Array.isArray(existing) ? { ...existing } : {};
		if (record[tool] === "allow") return;
		record[tool] = "allow";
		const res = await trayRequest("settings.set", { key: "tools.approval", value: record });
		if (!res || res.error) {
			console.error(`[tray] remember approval for ${tool} failed:`, res?.error ?? "no response");
		}
	} catch (err) {
		console.error(`[tray] remember approval for ${tool} failed:`, err?.message ?? err);
	}
}

// Shared action router for tray + self-drawn tray menu (win32): the
// tray click, the native menu (mac/linux) and the frosted menu window
// all land here so the two surfaces cannot drift apart.
function handleTrayAction(action) {
	trayLog(`action ${JSON.stringify(action)}`);
	switch (action.type) {
		case "toggle-tray-menu":
			toggleTrayMenu(action.bounds);
			break;
		case "focus-session":
			if (typeof action.sessionId === "string" && mainWindow && !mainWindow.isDestroyed()) {
				focusMainFromPet();
				mainWindow.webContents.send("tray:open-session", action.sessionId);
			}
			break;
		case "respond-approval":
			// Inline Allow/Deny from the tray menu → the same RPCs the
			// renderer's approval card uses.
			if (typeof action.id === "string" && typeof action.sessionId === "string") {
				traySend(action.approved === true ? "tool.approve" : "tool.deny", {
					sessionId: action.sessionId,
					requestId: action.id,
				});
				// "Always allow" additionally remembers the policy. Both tray
				// surfaces ("始终允许" in tray.cjs, "always allow" in
				// tray-menu-main.tsx) set `remember`; they must also send the
				// tool name for the policy key. Previously the flag was
				// silently dropped and the button behaved as "allow once".
				if (action.approved === true && action.remember === true && typeof action.tool === "string" && action.tool) {
					void rememberToolApproval(action.tool);
				}
			}
			break;
		case "new-session":
			if (mainWindow && !mainWindow.isDestroyed()) {
				focusMainFromPet();
				mainWindow.webContents.send("tray:new-session");
			}
			break;
		case "mini-chat":
			openMiniChatWindow();
			break;
		case "show-main-window":
			if (!mainWindow || mainWindow.isDestroyed()) void createWindow();
			focusMainFromPet();
			break;
		case "quit":
			app.quit();
			break;
		default:
			break;
	}
}

function ensureTray() {
	if (trayController) return;
	try {
	trayController = createTrayController({
		onAction: (action) => handleTrayAction(action),
		onSnapshot: (snapshot) => {
			// win32 self-drawn tray menu: forward the polled snapshot so
			// the frosted window renders live sessions/approvals/usage.
			if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
				trayMenuWindow.webContents.send("tray-menu:snapshot", snapshot);
			}
		},
	});
	const tick = async () => {
		if (trayClosed) return;
		// WS already open = the daemon is alive; skip the TCP probes and
		// just refresh state (the probes are only a reconnection concern).
		if (trayWs && trayWs.readyState === 1) {
			trayFetchState();
			return;
		}
		let port = probe();
		// ws.port can be STALE — a previous daemon's port that no longer
		// listens (a daemon that fails its writeFile leaves the old value;
		// observed: ws.port said 8741 while the daemon bound 8300). A dead
		// port must count as "no daemon": otherwise the tray WS never opens,
		// update() never runs, and the tray icon is never created.
		if (port && !(await portOpen(port))) port = null;
		// Fall back to the renderer's DEFAULT_URL port (packages/desktop-app/src/app.tsx) —
		// the daemon binds it and it is the documented default.
		if (!port && (await portOpen(8300))) port = 8300;
		if (!port) {
			trayController.update([]);
			closeTrayWs();
			return;
		}
		if (!trayWs || trayWs.readyState === 3 /* CLOSED */) {
			try {
				trayWs = new WebSocket(`ws://127.0.0.1:${port}`);
			} catch {
				trayWs = null;
			}
			if (!trayWs) return;
			trayWs.onopen = () => trayFetchState();
			trayWs.onmessage = (event) => {
				try {
					const frame = JSON.parse(event.data);
					const settle = frame && frame.id ? trayPending.get(frame.id) : undefined;
					if (settle) {
						trayPending.delete(frame.id);
						settle(frame.error ? null : (frame.result ?? null));
						return;
					}
					if (frame && frame.id === "tray" && frame.result && typeof frame.result === "object") {
						trayController.update(frame.result);
					}
				} catch {
					// transient parse noise; next poll refreshes
				}
			};
			trayWs.onclose = () => {
				trayWs = null;
			};
		} else if (trayWs.readyState === 1) {
			trayFetchState();
		}
	};
	tick();
	trayPollTimer = setInterval(tick, 5000);
	} catch (err) {
		console.error("[tray] ensureTray failed:", err?.stack ?? err);
	}
}

function closeTrayWs() {
	if (trayWs) {
		try {
			trayWs.close();
		} catch {
			// already closed
		}
		trayWs = null;
	}
}

function destroyTray() {
	trayClosed = true;
	if (trayPollTimer) clearInterval(trayPollTimer);
	trayPollTimer = null;
	closeTrayWs();
	if (trayController) trayController.destroy();
	trayController = null;
}

ipcMain.handle("pet-toggle", (_event, visible) => {
	setPetVisible(visible === true);
	return { ok: true };
});
// Renderer pointerdown: keep the window interactive (no click-through
// flip) until the drag ends — the 120ms poll would otherwise drop the
// pointer stream between down and the first move, or after a click.
ipcMain.handle("pet-drag-arm", () => {
	petDragArmed = true;
	return { ok: true };
});
// Drag via window-relative client coords + the renderer's screenX/Y
// ground truth (anchor declared above with the click-through state).
//
// ANCHORED DRAG + MEASURED SPACES: the anchor {cursor, window} is pinned
// ONCE per drag; every frame sets the window to anchor-window + cursor-
// travel × (measured cursor→position ratio). No getPosition() readback
// mid-drag (async setPosition feedback loop — the old "keeps moving after
// the mouse stops"), no guessed scale — the spaces are measured at drag
// start via calibrateDragSpace. The 500px coordinate-flip guard re-anchors
// AND re-calibrates (a monitor change mid-drag can change the spaces).
ipcMain.handle("pet-drag-client", (_event, { clientX, clientY, screenX, screenY }) => {
	if (!petWindow || petWindow.isDestroyed() || !petVisible) return { ok: true };
	cancelPetSettle();
	const cursor = screen.getCursorScreenPoint();
	if (petDragLast === null) {
		calibrateDragSpace(clientX, clientY, screenX, screenY);
		petDragLast = {
			cx: cursor.x,
			cy: cursor.y,
			wx: petWindow.getPosition()[0],
			wy: petWindow.getPosition()[1],
		};
		return { ok: true };
	}
	const deltaX = cursor.x - petDragLast.cx;
	const deltaY = cursor.y - petDragLast.cy;
	if (
		!Number.isFinite(deltaX) ||
		!Number.isFinite(deltaY) ||
		!Number.isFinite(petDragLast.wx) ||
		!Number.isFinite(petDragLast.wy)
	) {
		// Coordinate-space glitch (multi-display flip) — drop this frame;
		// the next move re-anchors on a consistent read.
		petDragLast = null;
		return { ok: true };
	}
	if (Math.abs(deltaX) > 500 || Math.abs(deltaY) > 500) {
		// Space flip mid-drag: re-anchor AND re-measure (the display under
		// the window — and its scaleFactor — may have changed).
		calibrateDragSpace(clientX, clientY, screenX, screenY);
		petDragLast = {
			cx: cursor.x,
			cy: cursor.y,
			wx: petWindow.getPosition()[0],
			wy: petWindow.getPosition()[1],
		};
		return { ok: true };
	}
	// Cursor travel → position space, applied to the ANCHOR (never chained
	// to a fresh read — the anchor makes any residual calibration error a
	// constant offset the next re-anchor corrects, not a cumulative drift).
	const k = (petCursorPhysical ? petPosScaleF : 1) / (petPosPhysical ? petPosScaleF : 1);
	// setPetPosition reads the live rect and skips a redundant native write.
	// That read-back is what keeps an OS-side correction (DIP→physical
	// rounding, edge snap) from silently accumulating across frames: a frame
	// the OS nudged is visible to the next comparison instead of being
	// overwritten from the anchor's stale assumption.
	setPetPosition(petDragLast.wx + deltaX * k, petDragLast.wy + deltaY * k);
	// win32 drops the topmost band when a drag runs up against a work-area
	// edge (the window manager reshuffles z-order on the snap); re-assert
	// while the pointer is still down so the pet does not sink mid-gesture.
	if (process.platform === "win32") {
		const b = petWindow.getBounds();
		if (isNearWorkAreaEdge(b)) reassertPetTopmost();
	}
	// Persist (throttled) — at most one write per 150ms during a drag.
	const now = Date.now();
	if (now - petLastPosWrite >= 150) {
		petLastPosWrite = now;
		petPosDirty = false;
		persistPetPos();
	} else {
		petPosDirty = true;
	}
	return { ok: true };
});
ipcMain.handle("pet-drag-end", () => {
	petDragArmed = false;
	petDragLast = null;
	flushPetPos(); // final position of a throttled drag
	settlePetWindow();
	return { ok: true };
});
ipcMain.handle("pet-click", () => {
	focusMainFromPet();
	return { ok: true };
});
// Pet panel "recent session" click → open that session in the main window.
ipcMain.handle("pet-open-session", (_event, sessionId) => {
	if (mainWindow && !mainWindow.isDestroyed() && typeof sessionId === "string") {
		focusMainFromPet();
		mainWindow.webContents.send("pet:open-session", sessionId);
	}
	return { ok: true };
});
// Interactive rect (window-relative) for the click-through poll: the pet
// renderer reports the union of pet + bubble bounds whenever they change.
ipcMain.handle("pet-set-hitbox", (_event, rect) => {
	if (rect && Number.isFinite(rect.x) && Number.isFinite(rect.y) && Number.isFinite(rect.width) && Number.isFinite(rect.height)) {
		petHitbox = rect;
	} else {
		petHitbox = null;
	}
	petIgnoreState = null; // force a refresh on the next poll
	updatePetClickThrough();
	return { ok: true };
});
// Sprite-only rect (no badge) — drives dock alignment so the CHARACTER
// lands flush on the screen edge.
ipcMain.handle("pet-set-rect", (_event, rect) => {
	if (rect && Number.isFinite(rect.x) && Number.isFinite(rect.y) && Number.isFinite(rect.width) && Number.isFinite(rect.height)) {
		petRect = rect;
	} else {
		petRect = null;
	}
	return { ok: true };
});
ipcMain.handle("pet-activity", (_event, payload) => {
	// Cache for replay when the pet window loads after this push.
	lastPetActivity = payload;
	// Single window since the merge: the pet window consumes everything —
	// mood/scale/unread/theme AND bubbles/approvals/state/recent sessions.
	// Track pending approvals for the global Allow/Deny hotkeys.
	if (payload && typeof payload === "object" && payload.approval?.requestId) {
		const id = payload.approval.requestId;
		if (!petPendingApprovals.includes(id)) petPendingApprovals.push(id);
		petSyncApprovalHotkeys();
	}
	if (petWindow && !petWindow.isDestroyed() && petVisible) {
		petWindow.webContents.send("pet:activity", payload);
	}
	return { ok: true };
});
// Pet dock-to-edge preference (settings → 宠物 → 挂靠左右侧). The main
// window renderer owns the setting (localStorage); the main process needs
// it for settlePetWindow, so it's mirrored here and persisted with the
// pet position.
ipcMain.handle("pet-dock-set", (_event, enabled) => {
	petDockEnabled = enabled === true;
	try {
		const f = petPosFile();
		const raw = JSON.parse(fs.readFileSync(f, "utf8"));
		fs.writeFileSync(f, JSON.stringify({ ...raw, dock: petDockEnabled }));
	} catch {
		// best-effort persistence
	}
	return { ok: true };
});

// Pet right-click context menu. Menu labels are Chinese — the main process
// has no locale state (the renderer does), and musepi's UI is Chinese-first.
ipcMain.handle("pet-context-menu", () => {
	if (!petWindow || petWindow.isDestroyed()) return { ok: true };
	const template = [
		{
			label: "打开主窗口",
			click: () => focusMainFromPet(),
		},
		{
			label: "显示/隐藏面板",
			click: () => {
				if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send("pet:panel-toggle");
			},
		},
		{ type: "separator" },
		{
			label: "挂靠屏幕边缘",
			type: "checkbox",
			checked: petDockEnabled,
			click: (item) => {
				const enabled = item.checked === true;
				petDockEnabled = enabled;
				try {
					const f = petPosFile();
					const raw = JSON.parse(fs.readFileSync(f, "utf8"));
					fs.writeFileSync(f, JSON.stringify({ ...raw, dock: petDockEnabled }));
				} catch {
					// best-effort persistence
				}
				if (enabled) {
					// A toggle must visibly do something: snap straight to
					// the nearer horizontal edge. Align the CHARACTER flush
					// to the edge (the window is bigger than the sprite);
					// subsequent drops near an edge keep snapping. Sprite
					// offsets are CSS px — convert to position space.
					const wa = screen.getDisplayMatching(petWindow.getBounds()).workArea;
					const [wx, wy] = petWindow.getPosition();
					const { width: w } = petWindow.getBounds();
					const cssK = petPosPhysical ? petPosScaleF : 1;
					const charL = petCharLeft() * cssK;
					const charR = petCharRight() * cssK;
					const leftDist = wx + charL - wa.x;
					const rightDist = wa.x + wa.width - (wx + charR);
					const toLeft = leftDist <= rightDist;
					const x = toLeft ? wa.x - charL : wa.x + wa.width - charR;
					setPetPosition(x, wy);
					// Docking parks the window flush on a work-area edge — the
					// exact position where win32 demotes the topmost band.
					if (process.platform === "win32") reassertPetTopmost();
					const side = toLeft ? "left" : "right";
					if (side !== petDockSide && !petWindow.isDestroyed()) {
						petDockSide = side;
						petWindow.webContents.send("pet:dock", { side });
					}
					try {
						persistPetPos(); // docked position, space-consistent (DIP + flags)
					} catch {
						// best-effort persistence
					}
				} else if (!petWindow.isDestroyed()) {
					// Disable clears the edge highlight; the position stays
					// put and the next drop bounces back into the work area.
					petDockSide = null;
					petWindow.webContents.send("pet:dock", { side: null });
				}
			},
		},
		{ type: "separator" },
		{
			label: "免打扰",
			submenu: [
				{
					label: "暂时隐藏 30 分钟",
					click: () => startPetDnd(30),
				},
				{
					label: "暂时隐藏 1 小时",
					click: () => startPetDnd(60),
				},
				{
					label: "暂时隐藏 2 小时",
					click: () => startPetDnd(120),
				},
				{
					label: "暂时隐藏 4 小时",
					click: () => startPetDnd(240),
				},
				{ type: "separator" },
				{
					label: "取消免打扰",
					enabled: petDndUntil !== null,
					click: () => cancelPetDnd(),
				},
			],
		},
		{ type: "separator" },
		{
			label: "隐藏桌宠",
			click: () => setPetVisible(false),
		},
	];
	Menu.buildFromTemplate(template).popup({ window: petWindow });
	return { ok: true };
});

// Computer-use glow overlay: while the agent drives the desktop via the
// `computer` tool, a transparent click-through overlay rings every
// display so the user can see the AI is operating the screen. Pure
// visual layer — mouse events are forwarded to the windows below, so
// the agent's own background input keeps working.
let glowWindows = new Set();
let glowActive = false;

function setComputerGlow(on) {
	if (on === glowActive) return;
	glowActive = on;
	if (on) {
		for (const d of screen.getAllDisplays()) {
			const { x, y, width, height } = d.bounds;
			const w = new BrowserWindow({
				x,
				y,
				width,
				height,
				frame: false,
				transparent: true,
				backgroundColor: "#00000000",
				alwaysOnTop: true,
				skipTaskbar: true,
				focusable: false,
				resizable: false,
				movable: false,
				minimizable: false,
				maximizable: false,
				closable: false,
				fullscreenable: false,
				hasShadow: false,
				show: false,
				webPreferences: {
					preload: path.join(__dirname, "glow-preload.cjs"),
					contextIsolation: true,
					nodeIntegration: false,
					sandbox: true,
				},
			});
			w.setAlwaysOnTop(true, "screen-saver");
			w.setIgnoreMouseEvents(true, { forward: true });
			w.loadFile(path.join(__dirname, "glow.html"));
			w.showInactive();
			glowWindows.add(w);
			w.on("closed", () => glowWindows.delete(w));
		}
	} else {
		for (const w of glowWindows) if (!w.isDestroyed()) w.destroy();
		glowWindows.clear();
	}
}

// Main-window renderer toggles the glow when a computer tool starts/ends.
ipcMain.handle("computer-glow", (_event, on) => {
	setComputerGlow(on === true);
	return { ok: true };
});
// Computer input action → the overlay window covering the target display,
// with coordinates rebased from global screen space to that window's viewport.
ipcMain.handle("glow-target", (_event, input) => {
	if (!input || glowWindows.size === 0) return { ok: true };
	const rect = input.rect;
	if (!rect || typeof rect.x !== "number") return { ok: true };
	const cx = rect.x + rect.width / 2;
	const cy = rect.y + rect.height / 2;
	for (const w of glowWindows) {
		const b = w.getBounds();
		if (cx < b.x || cx >= b.x + b.width || cy < b.y || cy >= b.y + b.height) continue;
		const local = {
			...input,
			rect: { x: rect.x - b.x, y: rect.y - b.y, width: rect.width, height: rect.height },
			point: input.point ? { x: input.point.x - b.x, y: input.point.y - b.y } : undefined,
		};
		w.webContents.send("glow:target", local);
		break;
	}
	return { ok: true };
});

// Pet panel actions → main-window renderer (it owns the session + approvals).
ipcMain.handle("pet-reply", (_event, { text, sessionId }) => {
	if (mainWindow && !mainWindow.isDestroyed() && typeof text === "string" && text.trim()) {
		mainWindow.webContents.send("pet:command", { type: "reply", text, sessionId });
	}
	return { ok: true };
});
// Pet panel "recent session" click → ask the main window's renderer (the
// only party with a daemon RPC connection) for that session's transcript;
// it answers via pet-session-content below.
ipcMain.handle("pet-get-session-content", (_event, sessionId) => {
	if (mainWindow && !mainWindow.isDestroyed() && typeof sessionId === "string") {
		mainWindow.webContents.send("pet:get-session-content", sessionId);
	}
	return { ok: true };
});
// Main-window renderer → pet window: transcript for the requested
// session (the panel lives in the pet window since the single-window
// merge).
ipcMain.handle("pet-session-content", (_event, payload) => {
	if (petWindow && !petWindow.isDestroyed() && payload && typeof payload.sessionId === "string") {
		petWindow.webContents.send("pet:session-content", payload);
	}
	return { ok: true };
});
ipcMain.handle("pet-approve", (_event, { requestId, approved }) => {
	if (mainWindow && !mainWindow.isDestroyed() && typeof requestId === "string") {
		mainWindow.webContents.send("pet:command", { type: "approve", requestId, approved: approved === true });
	}
	// The approval is decided — drop it from the hotkey queue.
	petPendingApprovals = petPendingApprovals.filter(id => id !== requestId);
	petSyncApprovalHotkeys();
	return { ok: true };
});
// Pet bubble ×: the user acknowledged that notification — clear the
// session's unread badge in the main window (it owns the unread set; the
// bubble itself is already removed by the pet window's renderer).
ipcMain.handle("pet-mark-read", (_event, sessionId) => {
	if (mainWindow && !mainWindow.isDestroyed() && typeof sessionId === "string") {
		mainWindow.webContents.send("pet:command", { type: "mark-read", sessionId });
	}
	return { ok: true };
});
// Pet badge click: mark every session read (badge + completion/error
// bubbles — the main window pushes dismissSessions back to the pet).
ipcMain.handle("pet-mark-all-read", () => {
	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.webContents.send("pet:command", { type: "mark-all-read" });
	}
	return { ok: true };
});
// Pin a board card to the desktop (kimi 固定至桌面 parity): a small
// always-on-top frameless transparent window rendering the widget itself
// (pin.html — immersive rounded card, drag strip with hover pin-top /
// close buttons). Sized from the card's board position, clamped.
// Pinned windows persist across app restarts: the pin payload (board-space
// w/h + widget data snapshot) is stored in pinned-widgets.json and recreated
// on launch; closing a pin window removes its record.
const PIN_WINS = new Set();
const PIN_STORE_FILE = () => path.join(app.getPath("userData"), "pinned-widgets.json");
let pinStoreSeq = 0;

function readPinStore() {
	try {
		const raw = fs.readFileSync(PIN_STORE_FILE(), "utf8");
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function writePinStore(records) {
	try {
		fs.mkdirSync(path.dirname(PIN_STORE_FILE()), { recursive: true });
		fs.writeFileSync(PIN_STORE_FILE(), JSON.stringify(records, null, "\t"));
	} catch {
		// Pin persistence is best-effort; a failed write only loses
		// restore-on-launch, never the live window.
	}
}

/** Create one pinned-widget window from a stored payload. */
function createPinWindow(payload) {
	const title = (payload && typeof payload.title === "string" ? payload.title : "Widget").slice(0, 60);
	const type = payload && typeof payload.type === "string" ? payload.type : "widget";
	// Desktop-card sizing: keep the card's board aspect, scaled down to a
	// comfortable desktop-card width (kimi 固定至桌面 cards are ~500-560px).
	const pw = Number(payload && payload.w) || 300;
	const ph = Number(payload && payload.h) || 240;
	const scale = Math.min(1, 560 / Math.max(pw, 1));
	const w = Math.max(220, Math.round(pw * scale));
	const h = Math.max(180, Math.round(ph * scale));
	const data = payload && typeof payload.data === "object" && payload.data !== null ? JSON.stringify(payload.data) : "";
	const win = new BrowserWindow({
		width: w,
		height: h,
		frame: false,
		transparent: true,
		resizable: true,
		title: `MusePi · ${title}`,
		alwaysOnTop: true,
		skipTaskbar: true,
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, "preload.cjs") },
	});
	win.setAlwaysOnTop(true, "floating");
	win._pinKey = payload.key;
	PIN_WINS.add(win);
	// Restore the persisted position (clamped to a display work area so an
	// unplugged monitor can't strand the window off-screen) and the
	// always-on-top choice. Default: top-left of the primary display.
	if (Number.isFinite(payload?.x) && Number.isFinite(payload?.y)) {
		const wa = screen.getDisplayMatching({ x: payload.x, y: payload.y, width: w, height: h }).workArea;
		const px = Math.min(Math.max(payload.x, wa.x - w + 80), wa.x + wa.width - 80);
		const py = Math.min(Math.max(payload.y, wa.y), wa.y + wa.height - 60);
		win.setPosition(Math.round(px), Math.round(py));
	}
	if (payload?.pinned === false) win.setAlwaysOnTop(false, "floating");
	// Persist position changes (debounced — drags fire move continuously)
	// so a restart restores the user's layout.
	let pinPosTimer = null;
	win.on("move", () => {
		if (pinPosTimer) return;
		pinPosTimer = setTimeout(() => {
			pinPosTimer = null;
			if (win.isDestroyed()) return;
			const [wx, wy] = win.getPosition();
			const records = readPinStore();
			const rec = records.find(r => r.key === win._pinKey);
			if (rec) {
				rec.x = wx;
				rec.y = wy;
				writePinStore(records);
			}
		}, 150);
	});
	win.on("closed", () => {
		PIN_WINS.delete(win);
		if (pinPosTimer) {
			clearTimeout(pinPosTimer);
			pinPosTimer = null;
		}
	});
	// loadFile passes query through url.format(), which percent-encodes
	// values — encodeURIComponent here would DOUBLE-encode (renderer would
	// parse back the encoded string and JSON.parse would throw, silently
	// falling back to widget defaults). Pass the raw JSON.
	win.loadFile(path.join(DIST_DIR, "pin.html"), {
		query: { type, title, data },
	});
	return win;
}

/** Recreate every persisted pin window (called after app ready). */
function restorePinWindows() {
	for (const record of readPinStore()) {
		try {
			createPinWindow(record);
		} catch (error) {
			console.error("[main] failed to restore pinned widget:", error);
		}
	}
}

ipcMain.handle("widget-pin", (_event, payload) => {
	const record = {
		key: `pin-${Date.now().toString(36)}-${(pinStoreSeq += 1)}`,
		title: payload && typeof payload.title === "string" ? payload.title : "Widget",
		type: payload && typeof payload.type === "string" ? payload.type : "widget",
		data: payload && typeof payload.data === "object" && payload.data !== null ? payload.data : {},
		w: Number(payload && payload.w) || 300,
		h: Number(payload && payload.h) || 240,
	};
	createPinWindow(record);
	writePinStore([...readPinStore(), record]);
	return { ok: true };
});

// User dismissed a pin window (its close button): drop the persisted record
// so it is not recreated on next launch. Plain window.close() from the pin
// renderer also works, but would not clear the record — the pin renderer
// must invoke this instead of closing itself.
ipcMain.handle("widget-pin-dismiss", (event) => {
	const win = BrowserWindow.fromWebContents(event.sender);
	if (!win || win.isDestroyed()) return { ok: false };
	const key = win._pinKey;
	if (key) {
		const records = readPinStore().filter(r => r.key !== key);
		writePinStore(records);
	}
	win.close();
	return { ok: true };
});

// Toggle always-on-top on the sending pin window (置顶 button); the choice
// is persisted so it survives restarts.
ipcMain.handle("widget-pin-top", (event) => {
	const win = BrowserWindow.fromWebContents(event.sender);
	if (win && !win.isDestroyed()) {
		const next = !win.isAlwaysOnTop();
		win.setAlwaysOnTop(next, "floating");
		const records = readPinStore();
		const rec = records.find(r => r.key === win._pinKey);
		if (rec) {
			rec.pinned = next;
			writePinStore(records);
		}
		return { ok: true, pinned: next };
	}
	return { ok: false };
});
// ── Global approval hotkeys (clawd-on-desk parity, 2026-09-16) ──────────
// While the pet window shows a pending tool approval, Ctrl/Cmd+Shift+Y
// allows and Ctrl/Cmd+Shift+N denies the OLDEST pending request — the
// pet panel no longer requires focusing a window to answer. Registered
// only while an approval is actually pending and the pet is visible.
let petPendingApprovals = [];
function resolvePetApprovalHotkey(approved) {
	const requestId = petPendingApprovals.shift();
	if (!requestId) return;
	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.webContents.send("pet:command", { type: "approve", requestId, approved });
	}
	// The pet renderer owns the approval card list — tell it the request
	// was decided so the card is removed without an activity round-trip.
	if (petWindow && !petWindow.isDestroyed()) {
		petWindow.webContents.send("pet:approval-resolved", { requestId, approved });
	}
	petSyncApprovalHotkeys();
}
function petSyncApprovalHotkeys() {
	const want = petVisible && petPendingApprovals.length > 0 && petWindow !== null && !petWindow.isDestroyed();
	for (const [accel, handler] of [
		["CmdOrCtrl+Shift+Y", () => resolvePetApprovalHotkey(true)],
		["CmdOrCtrl+Shift+N", () => resolvePetApprovalHotkey(false)],
	]) {
		try {
			if (want) {
				globalShortcut.register(accel, handler);
			} else {
				globalShortcut.unregister(accel);
			}
		} catch {
			// accelerator owned by another app — the panel buttons still work
		}
	}
}

// Pet window asks the main window's renderer for a fresh activity snapshot
// when it (re)appears — the renderer answers via pet-activity on mount.
ipcMain.handle("pet-request-state", () => {
	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.webContents.send("pet:request-state");
	}
	return { ok: true };
});
// Pet window single click → toggle the interaction panel. Since the
// single-window merge the panel lives in the PET window's renderer.
ipcMain.handle("pet-toggle-panel", () => {
	if (!petWindow || petWindow.isDestroyed()) return { ok: true };
	if (petWindow.webContents.isLoading()) {
		// The window is still loading (first click after creation): a send
		// now would race the React subscription and be dropped. Replay once
		// it settles — same delay as the activity replay.
		setTimeout(() => {
			if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send("pet:panel-toggle");
		}, 200);
	} else {
		petWindow.webContents.send("pet:panel-toggle");
	}
	return { ok: true };
});
// The merged pet window reports the height it needs (bubbles/panel grow
// upward). The bottom edge stays fixed — the sprite is anchored to the
// window bottom, so growing never moves the pet on screen. Width is
// pinned to PET_WINDOW_SIZE (panel 316px + bubbles 280px both fit).
ipcMain.handle("pet-set-content-size", (_event, size) => {
	if (!petWindow || petWindow.isDestroyed()) return { ok: true };
	const requested = size && Number.isFinite(size.height) ? Math.round(size.height) : PET_WINDOW_SIZE.height;
	const nextH = Math.min(1200, Math.max(PET_WINDOW_SIZE.height, requested));
	const [wx, wy] = petWindow.getPosition();
	const [, curH] = petWindow.getSize();
	if (curH === nextH) return { ok: true };
	let y = wy + curH - nextH;
	let h = nextH;
	// Growing must not poke past the top of the work area: clamp the top
	// edge and shrink the height instead (content clips at the top — the
	// pet stays visible, the bubble stack may lose its head).
	const wa = screen.getDisplayMatching(petWindow.getBounds()).workArea;
	if (y < wa.y) {
		h = Math.max(PET_WINDOW_SIZE.height, wy + curH - wa.y);
		y = wa.y;
	}
	petWindow.setBounds({ x: wx, y, width: PET_WINDOW_SIZE.width, height: h });
	return { ok: true };
});

// ── Petdex import (Petdex zip → unpack → pet.json + spritesheet) ────────
// Unpacks with the system bsdtar (`tar -xf`) which handles zip on macOS,
// Linux and Windows alike. Returns the package without image dimensions —
// the renderer decodes the data URL to fill width/height.
const { execFile, execFileSync, spawn } = require("node:child_process");

async function importPetdexFromZip(zipPath) {
	const dest = path.join(app.getPath("userData"), "pets", `pet-${Date.now()}`);
	fs.mkdirSync(dest, { recursive: true });
	await new Promise((resolve, reject) => {
		// windowsHide: GUI 主进程无控制台，tar 是控制台程序，缺它每次导入弹 conhost。
		execFile("tar", ["-xf", zipPath, "-C", dest], { windowsHide: true }, (err) => (err ? reject(err) : resolve()));
	});
	const petJsonPath = path.join(dest, "pet.json");
	let meta;
	try {
		meta = JSON.parse(fs.readFileSync(petJsonPath, "utf8"));
	} catch {
		return { error: "invalid-petdex" };
	}
	const spritesheetRel = typeof meta.spritesheetPath === "string" ? meta.spritesheetPath : "spritesheet.webp";
	const sheetPath = path.join(dest, spritesheetRel);
	if (!fs.existsSync(sheetPath)) return { error: "missing-spritesheet" };
	const ext = path.extname(sheetPath).toLowerCase();
	const mime = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : "image/webp";
	const dataUrl = `data:${mime};base64,${fs.readFileSync(sheetPath).toString("base64")}`;
	return {
		id: typeof meta.id === "string" && meta.id ? meta.id : `pet-${Date.now()}`,
		displayName: typeof meta.displayName === "string" && meta.displayName ? meta.displayName : "Petdex pet",
		description: typeof meta.description === "string" ? meta.description : null,
		spritesheet: dataUrl,
	};
}

// Sleep/wake (合盖待机): Electron tears down the renderer's WebSocket on
// system sleep (electron#19993 — localhost included). On resume, wake the
// renderer's recovery immediately — visibilitychange/online may not fire
// on macOS wake, so the renderer would otherwise sit on a dead socket until
// its keepalive notices (≤45s). The renderer runs the same clean-boot
// recovery the 重新连接 button uses; pause state lives in the daemon and is
// re-fetched during that boot, so global/session pauses survive intact.
app.whenReady().then(() => {
	powerMonitor.on("resume", () => {
		for (const win of BrowserWindow.getAllWindows()) {
			if (!win.isDestroyed()) win.webContents.send("app-power-resume");
		}
		// Wake is the single worst moment for the pet's geometry: the DPI flux
		// around resume is what ratchets the window size on Windows, and a
		// display that was detached while asleep comes back at its old
		// coordinates. Re-assert BOTH the size and the topmost rung — the
		// watchdog alone would take up to 5s to notice the latter.
		// Deferred one tick: the metrics-changed burst lands right after the
		// event, and reconciling into the middle of it re-clamps repeatedly.
		setTimeout(() => {
			reconcilePetWindow("resume");
		}, PET_METRICS_DEBOUNCE_MS);
	});
});
ipcMain.handle("pet-import", async () => {
	const picked = await dialog.showOpenDialog(mainWindow ?? undefined, {
		title: "Import Petdex package",
		filters: [{ name: "Petdex", extensions: ["zip"] }],
		properties: ["openFile"],
	});
	const zipPath = picked.filePaths?.[0];
	if (!zipPath) return null;
	return importPetdexFromZip(zipPath);
});

// Import a Codex hatch-pet sprite: read `pet.json` + `spritesheet.webp` from a
// Codex pets directory (`~/.codex/pets/<name>/`), mirroring open-design's
// Settings → General → Pets → Import Codex sprite flow. Shares the manifest
// contract (id/displayName/description/spritesheetPath) with the petdex zip
// import, so the same PetdexPackage shape is returned for the renderer.
ipcMain.handle("pet-import-codex", async () => {
	const picked = await dialog.showOpenDialog(mainWindow ?? undefined, {
		title: "Import Codex sprite",
		properties: ["openDirectory"],
	});
	const dir = picked.filePaths?.[0];
	if (!dir) return null;
	const petJsonPath = path.join(dir, "pet.json");
	let meta;
	try {
		meta = JSON.parse(fs.readFileSync(petJsonPath, "utf8"));
	} catch {
		return { error: "invalid-codex" };
	}
	const spritesheetRel = typeof meta.spritesheetPath === "string" ? meta.spritesheetPath : "spritesheet.webp";
	const sheetPath = path.join(dir, spritesheetRel);
	if (!fs.existsSync(sheetPath)) return { error: "missing-spritesheet" };
	const ext = path.extname(sheetPath).toLowerCase();
	const mime = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : "image/webp";
	const dataUrl = `data:${mime};base64,${fs.readFileSync(sheetPath).toString("base64")}`;
	return {
		id: typeof meta.id === "string" && meta.id ? meta.id : `pet-${Date.now()}`,
		displayName: typeof meta.displayName === "string" && meta.displayName ? meta.displayName : "Codex pet",
		description: typeof meta.description === "string" ? meta.description : null,
		spritesheet: dataUrl,
	};
});

// ── Petdex market (内嵌搜索/预览/安装) ───────────────────────────────────
// The renderer cannot fetch petdex.dev directly (no CORS headers), so the
// search API and zip downloads go through the main process. net.fetch is
// used instead of global fetch so the app's proxy settings apply.
const PETDEX_API = "https://petdex.dev/api/pets/search";

async function petdexFetch(url) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15_000);
	try {
		return await net.fetch(url, { signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

/** Search the petdex.dev catalog; returns a trimmed pet list. */
ipcMain.handle("pet-search", async (_event, query) => {
	try {
		const params = new URLSearchParams({ limit: "24", includeMeta: "0" });
		if (typeof query === "string" && query.trim()) params.set("q", query.trim());
		const resp = await petdexFetch(`${PETDEX_API}?${params}`);
		if (!resp.ok) return { error: `search failed (${resp.status})` };
		const body = await resp.json();
		const pets = Array.isArray(body?.pets) ? body.pets : [];
		return {
			pets: pets
				.filter(
					(p) =>
						p &&
						typeof p === "object" &&
						typeof p.slug === "string" &&
						typeof p.spritesheetPath === "string",
				)
				.map((p) => ({
					slug: p.slug,
					displayName: typeof p.displayName === "string" ? p.displayName : p.slug,
					description: typeof p.description === "string" ? p.description : null,
					spritesheetPath: p.spritesheetPath,
					zipUrl: typeof p.zipUrl === "string" ? p.zipUrl : null,
					soundUrl: typeof p.soundUrl === "string" ? p.soundUrl : null,
					featured: Boolean(p.featured),
					kind: typeof p.kind === "string" ? p.kind : null,
					vibes: Array.isArray(p.vibes) ? p.vibes.map(String) : [],
				})),
		};
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
});

/** Download + unpack a petdex zip (same path as the local import). */
ipcMain.handle("pet-install-url", async (_event, zipUrl) => {
	if (typeof zipUrl !== "string" || !/^https:\/\/assets\.petdex\.dev\//.test(zipUrl)) {
		return { error: "invalid petdex zip url" };
	}
	const tmpDir = path.join(app.getPath("temp"), "musepi-petdex");
	fs.mkdirSync(tmpDir, { recursive: true });
	const zipPath = path.join(tmpDir, `pet-${Date.now()}.zip`);
	try {
		const resp = await petdexFetch(zipUrl);
		if (!resp.ok) return { error: `download failed (${resp.status})` };
		const buf = Buffer.from(await resp.arrayBuffer());
		fs.writeFileSync(zipPath, buf);
		const pkg = await importPetdexFromZip(zipPath);
		if (pkg && "error" in pkg) return { error: pkg.error };
		return pkg;
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	} finally {
		try {
			fs.unlinkSync(zipPath);
		} catch {
			// already gone
		}
	}
});

// ── Scrollbar skin import (zip → scrollbar.json + optional pac.svg) ────
// Same unpack path as petdex: bsdtar handles zip on every platform. A
// skin zip carries scrollbar.json (id/displayName/base/colors/size +
// optional pacGlyphPath) — the renderer validates the shape and persists
// it to the skin registry (lib/scrollbar-skins.ts). The market slots
// below are skeletons (interface aligned with petdex) until a skin
// ecosystem exists.
async function importScrollbarSkinFromZip(zipPath) {
	const dest = path.join(app.getPath("userData"), "scrollbar-skins", `skin-${Date.now()}`);
	fs.mkdirSync(dest, { recursive: true });
	await new Promise((resolve, reject) => {
		execFile("tar", ["-xf", zipPath, "-C", dest], { windowsHide: true }, (err) => (err ? reject(err) : resolve()));
	});
	const jsonPath = path.join(dest, "scrollbar.json");
	let meta;
	try {
		meta = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
	} catch {
		return { error: "invalid-scrollbar-skin" };
	}
	let pacGlyph = null;
	const glyphRel = typeof meta.pacGlyphPath === "string" ? meta.pacGlyphPath : null;
	if (glyphRel) {
		const glyphPath = path.join(dest, glyphRel);
		if (!fs.existsSync(glyphPath)) return { error: "missing-pac-glyph" };
		pacGlyph = `data:image/svg+xml;base64,${fs.readFileSync(glyphPath).toString("base64")}`;
	}
	return {
		id: typeof meta.id === "string" && meta.id ? meta.id : `skin-${Date.now()}`,
		displayName: typeof meta.displayName === "string" && meta.displayName ? meta.displayName : "Custom skin",
		base: meta.base === "gummy" || meta.base === "pacman" ? meta.base : "pacman",
		colors: {
			...(typeof meta.colors?.accent === "string" ? { accent: meta.colors.accent } : {}),
			...(typeof meta.colors?.track === "string" ? { track: meta.colors.track } : {}),
			...(typeof meta.colors?.eaten === "string" ? { eaten: meta.colors.eaten } : {}),
		},
		...(Number.isFinite(meta.size) ? { size: meta.size } : {}),
		pacGlyph,
	};
}

ipcMain.handle("scrollbar-skin-import", async () => {
	const picked = await dialog.showOpenDialog(mainWindow ?? undefined, {
		title: "Import scrollbar skin",
		filters: [{ name: "Scrollbar skin", extensions: ["zip"] }],
		properties: ["openFile"],
	});
	const zipPath = picked.filePaths?.[0];
	if (!zipPath) return null;
	return importScrollbarSkinFromZip(zipPath);
});

// ── Scrollbar skin market (预留骨架:接口对齐 petdex,生态就绪后接站点) ──
ipcMain.handle("scrollbar-skin-search", async () => ({ skins: [] }));
ipcMain.handle("scrollbar-skin-install-url", async () => ({ error: "not-implemented" }));


function mainWindowBoundsFile() {
	return path.join(app.getPath("userData"), "main-window.json");
}

/** Persisted main-window bounds — restore the user's layout on relaunch
 *  (same pattern as pet-pos.json / pin positions). Clamped to a display
 *  work area so an unplugged monitor can't strand the window off-screen. */
function loadMainWindowBounds() {
	try {
		const raw = fs.readFileSync(mainWindowBoundsFile(), "utf8");
		const b = JSON.parse(raw);
		if (!Number.isFinite(b?.width) || !Number.isFinite(b?.height)) return null;
		const wa = screen.getDisplayMatching({ x: b.x || 0, y: b.y || 0, width: b.width, height: b.height }).workArea;
		const width = Math.max(720, Math.min(b.width, wa.width));
		const height = Math.max(480, Math.min(b.height, wa.height));
		const x = Number.isFinite(b.x) ? Math.min(Math.max(b.x, wa.x - width + 80), wa.x + wa.width - 80) : undefined;
		const y = Number.isFinite(b.y) ? Math.min(Math.max(b.y, wa.y), wa.y + wa.height - 60) : undefined;
		return { width, height, ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}) };
	} catch {
		return null; // first run — defaults
	}
}

/**
 * Resolve the compat-shell renderer origin (dsh-desktop parity).
 * Explicit MUSEPI_GUI_COMPAT_URL wins; otherwise read web.port but ONLY
 * accept it when the port actually listens — a stale web.port (daemon died
 * without unlinking: taskkill / crash / SIGKILL) must resolve null so the
 * shell loads its local bundle instead of white-screening on a dead origin
 * (same liveness gate the tray's probe uses).
 */
async function resolveCompatUrl() {
	const explicit = process.env.MUSEPI_GUI_COMPAT_URL;
	if (explicit) return explicit;
	const url = probeWeb();
	if (!url) return null;
	const port = Number.parseInt(new URL(url).port, 10);
	return port > 0 && (await portOpen(port)) ? url : null;
}

async function createWindow() {
	const saved = loadMainWindowBounds();
	mainWindow = new BrowserWindow({
		title: "MusePi",
		width: saved?.width ?? 1280,
		height: saved?.height ?? 800,
		...(saved?.x !== undefined ? { x: saved.x } : {}),
		...(saved?.y !== undefined ? { y: saved.y } : {}),
		minWidth: 720,
		minHeight: 480,
		// Native app icon (macOS Dock uses the bundle/Dock icon; this covers
		// Linux/Windows chrome and packaged macOS resources).
		icon: ICON_PATH,
		// #6: without a backgroundColor the DWM window surface starts white,
		// and the Windows taskbar thumbnail (Aero peek) renders that white
		// initial surface instead of the page. Match the dark app backdrop.
		backgroundColor: "#1e1c1a",
		// macOS native traffic lights, full-bleed content. Plain 'hidden'
		// (NOT hiddenInset — that adds its own inset and leaves the controls
		// visibly lower than the app header), traffic lights at the same
		// {16,17} openchamber uses so they sit level with the header row.
		titleBarStyle: "hidden",
		trafficLightPosition: { x: 16, y: 17 },
		// Windows/Linux: titleBarStyle "hidden" draws NO window controls on
		// its own (traffic lights are macOS-only) — without an overlay the
		// user cannot minimize/maximize/close (Alt+F4 only). titleBarOverlay
		// puts native min/max/close buttons at the top-right; transparent
		// color lets the page's glass header show through, height matches
		// the .gui-header row (h-12 = 48px). Ignored on macOS (traffic
		// lights) and on Linux distros that keep the system title bar.
		...(process.platform === "win32" || process.platform === "linux"
			? {
					titleBarOverlay: {
						color: "#00000000",
						symbolColor: "#8a8a92",
						height: 48,
					},
				}
			: {}),
		webPreferences: {
			preload: path.join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			// Embedded browser (right-pane tool): <webview> tags drive a
			// real Chromium view with cross-origin executeJavaScript —
			// the iframe fallback cannot read external pages.
			webviewTag: true,
		},
		// Platform-native window glass (no CSS compositing cost):
		// - macOS: transparent background + under-window vibrancy — the
		//   system material paints the shell, the page paints translucent
		//   scrims over it. The renderer toggles off via `gui-vibrancy`.
		// - Windows 11: DWM Acrylic via backgroundMaterial (the same
		//   material the tray menu window uses). The window stays OPAQUE —
		//   the DWM compositor blurs the desktop behind the whole frame,
		//   and the page's translucent scrims over a transparent
		//   backgroundColor let the frosted material show through, so
		//   every pane (sidebar, header, menus) reads as the same real
		//   frosted glass. The 磨砂玻璃透明度 slider then controls how
		//   much of that blurred backdrop the scrim lets through (true
		//   see-through — the previous transparent-window variant showed
		//   the desktop sharp and unblurred, so the slider only changed
		//   the tint's depth, user report). Windows 10 / Linux fall back
		//   to a transparent frame with the CSS self-drawn glass layer.
		...(process.platform === "darwin"
			? { backgroundColor: "#00000000", vibrancy: "under-window" }
			: process.platform === "win32" && IS_WIN11
				? { backgroundColor: "#00000000", backgroundMaterial: "acrylic" }
				: { backgroundColor: "#00000000" }),
	});

	// Dev hot-reload renderer: with MUSEPI_GUI_DEV=1 (bun run desktop:dev)
	// load the Vite dev server so component edits HMR in place; otherwise
	// serve the built dist bundle.
	//
	// Musepi compat shell (dsh-desktop-compat): with MUSEPI_GUI_COMPAT_URL
	// set (the daemon's webPort serves the guest-client dist at loopback),
	// load the daemon-served renderer — the runtime owns the content, the
	// Electron shell is the frame wrapper. A frame overlay (titlebar
	// reservation below) is a presentational follow-up; the loadURL swap is
	// the "shell wraps runtime content" chain.
	const devServer = DEV && process.env.MUSEPI_GUI_DEV === "1" ? "http://127.0.0.1:5173/" : null;
	// Compat shell: MUSEPI_GUI_COMPAT_URL (explicit override) wins, else the
	// daemon's web.port discovery file — but only while that port actually
	// listens (resolveCompatUrl); a stale file falls through to the local
	// bundle, whose renderer boot re-discovers/spawns the daemon via ws.port.
	const compatUrl = await resolveCompatUrl();
	// `?shell=1` signals the served renderer to reserve the titlebar
	// region (titleBarOverlay.height, 48px) so the OS window controls
	// never sit on content — the desktopWindow frame-overlay contract.
	const loadLocal = () => mainWindow.loadFile(path.join(DIST_DIR, "index.html"));
	if (compatUrl) {
		// Defense-in-depth: a listener can die between the liveness probe and
		// loadURL (or serve a broken page) — never white-screen on it.
		mainWindow.loadURL(`${compatUrl}?shell=1`).catch(() => {
			console.error(`[main] compat renderer unreachable (${compatUrl}), loading local bundle`);
			loadLocal();
		});
	} else if (devServer) mainWindow.loadURL(devServer);
	else loadLocal();

	// Renderer crash (OOM / fatal page error): the WebSocket to the daemon
	// dies with the renderer, leaving the window dead and the session turn
	// orphaned ("前后端掉线"). Auto-reload — the app's boot/reconnect path
	// re-attaches and reopens the active session (rpc onStatus open →
	// openSession), so a crash recovers without a manual relaunch.
	// OTA updater: forward electron-updater events to the renderer (UpdateToast).
	wireRenderer((channel, data) => {
		if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
	});

	// External-link policy (openchamber parity): renderer <a target=_blank>
	// must NOT spawn orphan Electron windows, and in-window navigation must
	// not replace the whole app. http(s) targets open in the system browser
	// (shell.openExternal) — the managed in-app browser (WebContentsView)
	// is driven separately via managed-browser IPC, not window navigation.
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:/i.test(url)) void shell.openExternal(url);
		return { action: "deny" };
	});
	mainWindow.webContents.on("will-navigate", (event, url) => {
		// Allow the app's own routes; everything else leaves via the
		// system browser (defense-in-depth for links that bypass target=_blank).
		if (/^https?:/i.test(url) && !url.startsWith("http://localhost") && !url.startsWith("http://127.0.0.1")) {
			event.preventDefault();
			void shell.openExternal(url);
		}
	});

	mainWindow.webContents.on("render-process-gone", (_event, details) => {
		if (details.reason === "clean-exit") return;
		console.error("[main] renderer process gone:", details.reason, "exitCode:", details.exitCode);
		if (!mainWindow.isDestroyed()) mainWindow.webContents.reload();
	});

	// Close-to-tray on non-darwin (Discord/Slack convention): hide the window
	// instead of quitting so the tray icon keeps the app alive and "show-main-window"
	// / tray-click can bring it back. A real quit goes through before-quit (the
	// tray "quit" action sets the quitting flag so the close is allowed).
	// If the tray was never created (ensureTray failure), allow the close so
	// the existing window-all-closed path quits instead of leaving a zombie.
	mainWindow.on("close", (event) => {
		if (quitting) return;
		if (process.platform !== "darwin" && trayController && !trayClosed) {
			event.preventDefault();
			mainWindow.hide();
		}
	});

	mainWindow.on("closed", () => {
		mainWindow = null;
		// The glow is driven by this window's session store; with the
		// main window gone there is no one to turn it off.
		setComputerGlow(false);
		if (mainBoundsTimer) {
			clearTimeout(mainBoundsTimer);
			mainBoundsTimer = null;
		}
	});

	// The managed browser owner wiring, bounds persistence, and webview
	// popup handling moved back inside createWindow — at module top level
	// mainWindow is still null and `mainWindow.on(...)` throws during load,
	// killing the main process before any window can open (v0.4.18 startup
	// regression).
	managedBrowser.setOwner(mainWindow);

	// Persist main-window bounds (debounced — drags/resizes fire move/resize
	// continuously) so a relaunch restores the user's layout.
	let saveBounds = () => {
		if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMaximized() || mainWindow.isFullScreen()) return;
		try {
			fs.writeFileSync(mainWindowBoundsFile(), JSON.stringify(mainWindow.getBounds()));
		} catch {
			// non-fatal — bounds restore is best-effort
		}
	};
	if (mainBoundsTimer) clearTimeout(mainBoundsTimer);
	mainBoundsTimer = setTimeout(() => {
		mainBoundsTimer = null;
		saveBounds();
	}, 300);
	mainWindow.on("move", () => {
		if (mainBoundsTimer) return;
		mainBoundsTimer = setTimeout(() => {
			mainBoundsTimer = null;
			saveBounds();
		}, 300);
	});
	mainWindow.on("resize", () => {
		if (mainBoundsTimer) return;
		mainBoundsTimer = setTimeout(() => {
			mainBoundsTimer = null;
			saveBounds();
		}, 300);
	});
}

// Webview popups (embedded browser): openchamber-style in-place
// navigation — deny new windows, load http/https targets inside the
// same webview so target=_blank links don't spawn orphan windows.
// Registered once at module top level: createWindow can run again on the
// show-main-window rebuild path, and a duplicate handler would stack
// setWindowOpenHandlers over destroyed webContents.
app.on("web-contents-created", (_event, contents) => {
	if (contents.getType() !== "webview") return;
	// The managed in-app browser runs its own popup policy on this same
	// `webview` type: control-click / target=_blank becomes a new managed tab
	// (managed-browser.cjs binds the handler when the guest is reported).
	// Loading the target in place here would swallow that and hijack the tab.
	if (contents.session === session.fromPartition("persist:musepi-managed-browser")) return;
	contents.setWindowOpenHandler(({ url }) => {
		if (/^https?:/i.test(url)) contents.loadURL(url);
		return { action: "deny" };
	});
});

// ── IPC: system notifications ───────────────────────────────────────────
// The renderer's HTML5 Notification API is NOT wired to macOS system
// notifications in Electron (long-standing platform gap), so the renderer
// routes every notification through the main-process Notification here —
// the same architecture openchamber uses (web server → onDesktopNotification
// → main-process Notification).
//
// Platform behavior (all through this same main-process path):
//  - Windows: toast via the AppUserModelID set in main() — works in dev.
//  - Linux: org.freedesktop.Notifications (DBus) — works when a notification
//    daemon is running, no authorization concept.
//  - macOS: UNUserNotificationCenter. macOS 26 only grants authorization to
//    apps the user actually opened (Finder/Dock launch); terminal-spawned
//    dev instances get silently denied — no prompt, no delivery. A packaged,
//    signed MusePi.app launched by double-click prompts on first send and
//    then works. (Verified 2026-08: ad-hoc signing + `open` launch still
//    denied; scripteditor2/osascript delivery proves the DB path is fine.)
const activeNotifications = new Set();
ipcMain.handle("notification-show", (_event, { title, body }) => {
	if (!Notification.isSupported()) return { ok: false, reason: "unsupported" };
	try {
		const notification = new Notification({ title, body, silent: false });
		// macOS: losing the JS reference makes click events stop firing
		// after ~1 min (openchamber main.mjs keeps the same Set for the
		// same reason — https://blog.bloomca.me/2025/02/22/electron-mac-notifications).
		activeNotifications.add(notification);
		const release = () => activeNotifications.delete(notification);
		notification.on("click", () => {
			if (mainWindow && !mainWindow.isDestroyed()) {
				// macOS: bring the app to foreground first, or restore/
				// focus calls won't pull the window forward.
				app.focus({ steal: true });
				if (mainWindow.isMinimized()) mainWindow.restore();
				mainWindow.show();
				mainWindow.focus();
			}
			release();
		});
		notification.on("close", release);
		notification.on("failed", (event, error) => {
			// macOS: unsigned/terminal-launched binaries get silently denied
			// (UNNotification requires code signing) — surface the reason to
			// the renderer (Settings → 测试通知) instead of swallowing it.
			const reason = error?.message ?? String(error);
			console.error("[notification] failed:", reason);
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.webContents.send("notification-failed", { title, body, reason });
			}
			release();
		});
		notification.show();
		return { ok: true };
	} catch (err) {
		return { ok: false, reason: err instanceof Error ? err.message : String(err) };
	}
});

// ── IPC: OTA update check (manifest-driven) ───────────────────────────────

ipcMain.handle("updater-check", () => checkForUpdates());
ipcMain.handle("updater-state", () => ({ ...updaterState }));
ipcMain.handle("updater-download", () => downloadUpdate());
ipcMain.handle("updater-notes", () => fetchManifestNotes());
/** Manual install fallback: download the release installer (dmg/exe) to
 *  Downloads and open it. Used when the running build cannot OTA (ad-hoc
 *  signed macOS app — Squirrel's cdhash requirement never matches). */
ipcMain.handle("updater-download-installer", (_event, url) => downloadInstaller(url));
/** Whether electron-updater/Squirrel can install on this build at all. */
ipcMain.handle("updater-ota-capable", () => otaCapable());
ipcMain.handle("updater-install", async () => {
	// Kill the daemon sidecar BEFORE quitting so the installed app can
	// start its own fresh daemon (openchamber killSidecar parity). The
	// daemon holds the ws.port / journal; a live one would be orphaned.
	// killOwnedDaemon also clears the client.pid marker and flags the
	// before-quit handler as already-handled, so the pending quit from
	// quitAndInstall() below is NOT held up by a preventDefault/second-quit
	// cycle — electron-updater registers its install action on `quit`, and
	// swallowing the first quit risks racing that handoff.
	try {
		const { killOwnedDaemon, kill, probe } = require("./daemon.cjs");
		if (killOwnedDaemon) {
			await killOwnedDaemon().catch(() => {});
		} else {
			const port = probe();
			if (port) await kill(port);
		}
		daemonQuitHandled = true;
	} catch (err) {
		console.error("[updater] daemon kill failed:", err?.message ?? err);
	}
	// quitAndInstall resolves once the app is shutting down (install
	// underway) or REJECTS if the installer reports a failure (rejected
	// signature, disabled Squirrel session) — the rejection arrives while
	// the app is still alive, so surface it to the renderer for a retry
	// prompt instead of the install dying silently in the log.
	try {
		await quitAndInstall();
		return { ok: true };
	} catch (err) {
		console.error("[updater] install failed:", err?.message ?? err);
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
});
// OTA/发布一致性:renderer 拿 GUI 版本,与 daemon 的 system.meta
// musepiVersion 比对 —— 不一致说明运行中的 daemon 是旧进程,走
// daemon-restart 刷新(见 app.tsx boot)。
ipcMain.handle("app-version", () => app.getVersion());

// ── IPC: window glass (window-transparency toggle in settings) ────────────
// OFF restores an opaque base (theme-matched) so the desktop never shows
// through; ON re-applies the native under-window material. NOTE: Electron
// 43 exposes no bright vibrancy variant (`light` was removed; `window` etc.
// follow the SYSTEM appearance, which is dark on this machine) — the light
// scheme's clean white glass is achieved in CSS with a heavier white scrim
// (see --gui-glass-overlay derivation in gui.css), not the native layer.
// Haptic feedback (macOS Taptic Engine): NSHapticFeedbackManager through a
// tiny compiled helper (electron/haptic-helper, clang-built from
// haptic-helper.m — `bun run build` compiles it; dev lazily compiles on
// first use). NOT osascript/JXA: the JXA ObjC bridge does not expose
// NSTrackpadHapticFeedbackPerformer's instance methods, so the old
// performOutputPattern call threw and was silently swallowed — haptics
// never fired. A compiled binary also starts ~10× faster (~5ms vs
// ~100ms+), keeping the tap within perception. Patterns: 0 generic,
// 1 alignment, 2 level-change. Throttled (~80ms) so rapid clicks don't
// spawn a process per event.
let hapticHelperPath = null;
let hapticHelperResolved = false;
function resolveHapticHelper() {
	if (hapticHelperResolved) return hapticHelperPath;
	hapticHelperResolved = true;
	const dir = __dirname; // electron/
	const bin = path.join(dir, "haptic-helper");
	const src = path.join(dir, "haptic-helper.m");
	try {
		if (fs.existsSync(bin) && (!fs.existsSync(src) || fs.statSync(bin).mtimeMs >= fs.statSync(src).mtimeMs)) {
			hapticHelperPath = bin;
			return bin;
		}
		if (fs.existsSync(src)) {
			execFileSync(
				"clang",
				["-fobjc-arc", "-framework", "AppKit", "-framework", "Foundation", "-O2", "-o", bin, src],
				{ timeout: 20000, stdio: "ignore" },
			);
			hapticHelperPath = bin;
			return bin;
		}
	} catch (err) {
		console.warn("[haptic] helper unavailable:", err?.message || err);
	}
	return null;
}
let hapticProc = null;
/** Persistent helper process (stdin daemon): spawn once, keep for the
 *  session — per-tap is a stdin write. Respawns on exit/error; the stdin
 *  pipe closing on parent quit exits the child (fgets → EOF). */
function hapticProcess() {
	if (hapticProc && hapticProc.exitCode === null) return hapticProc;
	const helper = resolveHapticHelper();
	if (!helper) return null;
	const proc = spawn(helper, [], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
	proc.on("error", () => {
		hapticProc = null;
	});
	proc.on("exit", () => {
		hapticProc = null;
	});
	hapticProc = proc;
	return proc;
}
let lastHapticAt = 0;
ipcMain.handle("haptic", (_event, pattern = 0) => {
	// macOS Taptic Engine only — no helper on other platforms (build:haptic
	// skips them); short-circuit so we don't run the resolve dance or log.
	if (process.platform !== "darwin") return { ok: false, reason: "unsupported" };
	const now = Date.now();
	if (now - lastHapticAt < 80) return { ok: true, skipped: true };
	lastHapticAt = now;
	const proc = hapticProcess();
	if (!proc) return { ok: false };
	const p = Number.isInteger(pattern) ? Math.min(Math.max(pattern, 0), 2) : 0;
	try {
		proc.stdin.write(`${p}\n`);
	} catch {
		// process just died — next tap respawns it
	}
	return { ok: true };
});
ipcMain.handle("gui-vibrancy", (event, enabled, style) => {	const win = BrowserWindow.fromWebContents(event.sender);
	if (!win) return;
	if (process.platform === "win32") {
		// Windows: glass is DWM-provided (backgroundMaterial) — the whole
		// window becomes real frosted glass over the desktop. Toggling
		// swaps the material and the base color: ON restores the acrylic
		// + transparent base (the page scrims show the frost through),
		// OFF removes the material and paints an opaque theme base (the
		// renderer also forces --gui-glass-overlay:100%, so no trace of
		// the glass remains). Windows 10 has no material API — the
		// transparent frame stands in and the renderer's opaque overlay
		// covers the toggle-off side.
		try {
			win.setBackgroundMaterial(enabled ? "acrylic" : "none");
			if (enabled) win.setBackgroundColor("#00000000");
			else win.setBackgroundColor(style === "light" ? "#f6f6f4" : "#0d0d0f");
		} catch {
			// Windows 10 / unsupported: material API absent — nothing to
			// toggle (the renderer's CSS overlay handles the opaque side).
		}
		return;
	}
	if (enabled) {
		// Light theme on macOS needs a bright vibrancy material (e.g. "light")
		// — under-window dims the backdrop, turning a light translucent
		// scrim into dirty grey, which forced the CSS overlay to 58–76%
		// (almost opaque). Using the theme-appropriate material lets the
		// scrim stay thin and the glass look transparent.
		win.setVibrancy(style === "light" ? "light" : "under-window");
		win.setBackgroundColor("#00000000");
	} else {
		win.setVibrancy(null);
		win.setBackgroundColor(style === "light" ? "#f6f6f4" : "#0d0d0f");
	}
});

// ── IPC: syntax highlighting (tree-sitter via @musepi/pi-natives) ─────────
// The renderer is sandboxed and cannot load native modules. Highlighting
// runs in a dedicated child_process (highlight-worker.cjs): calling the
// native addon synchronously in main froze the whole main event loop for
// large blocks. Returns ANSI-colored lines, or null when the addon is
// unavailable / the worker fails.
const { fork } = require("child_process");
let hlWorker = null;
let hlSeq = 0;
const hlPending = new Map();

function getHlWorker() {
	if (hlWorker) return hlWorker;
	hlWorker = fork(path.join(__dirname, "highlight-worker.cjs"), [], {
		stdio: ["ignore", "inherit", "inherit", "ipc"],
		windowsHide: true,
	});
	hlWorker.on("message", msg => {
		if (!msg || typeof msg.id !== "number") return;
		const pending = hlPending.get(msg.id);
		hlPending.delete(msg.id);
		if (!pending) return;
		if (msg.error) {
			console.error("[highlight-worker] failed:", msg.error);
			pending.resolve(null);
		} else {
			pending.resolve(msg.result);
		}
	});
	hlWorker.on("error", err => {
		console.error("[highlight-worker] spawn error:", err);
	});
	hlWorker.on("exit", () => {
		// Worker died (crash/OOM): fail in-flight requests so the renderer
		// falls back to plain text, and respawn on the next call.
		for (const [, pending] of hlPending) pending.resolve(null);
		hlPending.clear();
		hlWorker = null;
	});
	return hlWorker;
}

ipcMain.handle("gui-highlight", async (_event, code, lang, colors) => {
	try {
		const worker = getHlWorker();
		const id = ++hlSeq;
		const reply = new Promise(resolve => hlPending.set(id, { resolve }));
		worker.send({ id, code, lang, colors });
		// Huge blocks can take seconds to tokenize; don't let the renderer
		// hang on the IPC indefinitely.
		const timer = setTimeout(() => {
			hlPending.delete(id);
		}, 5000);
		const result = await reply;
		clearTimeout(timer);
		return result;
	} catch {
		return null;
	}
});

// Silent auto-check shortly after launch, then every UPDATE_POLL_MS
// (openchamber parity: periodic re-checks so a release published while the
// app idles still surfaces — a single launch-time check misses it until the
// next app restart). Silence entirely with OMP_NO_AUTO_UPDATE. The renderer
// owns dismissal/skip (UpdateToast), so a repeated push for an already-seen
// or skipped version is a no-op there.
const UPDATE_POLL_MS = 60 * 60 * 1000; // 1h
if (process.env.OMP_NO_AUTO_UPDATE !== "1") {
	app.whenReady().then(() => {
		// One line per launch is enough to answer "did the check even run, and
		// can this build install an update?" without attaching a debugger.
		logUpdater("startup: version", app.getVersion(), "otaCapable", otaCapable(), "signing", require("./updater.cjs").detectSigning());
		const poll = () => {
			checkForUpdates()
				.then(result => {
					if (result.enabled && result.newer && mainWindow && !mainWindow.isDestroyed()) {
						mainWindow.webContents.send("update-available", result);
					}
				})
				.catch(() => {});
		};
		setTimeout(poll, 12000);
		setInterval(poll, UPDATE_POLL_MS);
	});
}

// ── IPC: daemon lifecycle (daemon_probe / daemon_start equivalents) ──────

ipcMain.handle("daemon-probe", () => probe());
// A stale listener on the port (an orphaned daemon from a previous GUI
// that wasn't torn down) makes the fresh spawn exit immediately with
// EADDRINUSE — the GUI's daemon-start then reports "daemon exited during
// startup" and the app shows 无法连接本地守护进程. Clear the port first
// (kill has SIGTERM→SIGKILL escalation, so it cannot wedge on a stuck
// process), then spawn.
ipcMain.handle("daemon-start", async (_event, port) => {
	await kill(Number(port)).catch(() => {});
	return start(Number(port), daemonEnv());
});
ipcMain.handle("daemon-restart", (_event, port) => restart(Number(port), daemonEnv()));

/**
 * Relocate the app data root (设置 → 常规 → 数据存储路径).
 * `picked` is the parent folder chosen in the dialog; the actual root is
 * `<picked>/.musepi` (fixed suffix, mirrors the home default so the
 * override always points at a dedicated directory). The daemon is stopped,
 * the current root is copied to the target (logs/ and run/ excluded), the
 * override is persisted, and the daemon is respawned with PI_CONFIG_DIR.
 * Resolves { ok:true, root } or { ok:false, error }.
 */
ipcMain.handle("data-root-apply", async (_event, picked) => {
	try {
		if (typeof picked !== "string" || picked === "") return { ok: false, error: "empty path" };
		const base = path.resolve(picked.trim());
		const target = path.join(base, ".musepi");
		const current = currentDataRoot();
		if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
			return { ok: false, error: `folder does not exist: ${base}` };
		}
		if (target === current) return { ok: false, error: `already the data root: ${target}` };
		if (pathIsInside(target, current) || pathIsInside(current, target)) {
			return { ok: false, error: "cannot nest the data root inside itself" };
		}
		if (fs.existsSync(target)) {
			return { ok: false, error: `target already exists: ${target}` };
		}
		const port = probe();
		if (port !== null) await kill(port);
		// Copy the current root (skip ephemeral logs + daemon runtime dir).
		fs.cpSync(current, target, {
			recursive: true,
			filter: src => {
				const baseName = path.basename(src);
				return baseName !== "logs" && baseName !== "run";
			},
		});
		fs.writeFileSync(path.join(app.getPath("userData"), DATA_ROOT_OVERRIDE_FILE), JSON.stringify({ root: target }, null, 2));
		if (port !== null) await start(port, daemonEnv());
		return { ok: true, root: target };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
});

function pathIsInside(candidate, root) {
	const rel = path.relative(path.resolve(root), path.resolve(candidate));
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// ── IPC: read a local image file as a data URL (markdown ![](/abs/path)
//    parity with bitfun's local-image support). Extension whitelist + size
//    cap keep this from becoming an arbitrary-file reader; `~` expands to
//    the home dir. Returns { dataUrl } or { error }.

const IMAGE_EXT_MIME = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	svg: "image/svg+xml",
	bmp: "image/bmp",
	ico: "image/x-icon",
};
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

ipcMain.handle("gui-read-file-data-url", async (_event, filePath) => {
	try {
		if (typeof filePath !== "string" || filePath === "") return { error: "empty path" };
		const expanded = filePath.startsWith("~/") ? path.join(os.homedir(), filePath.slice(2)) : filePath;
		const ext = path.extname(expanded).slice(1).toLowerCase();
		const mime = IMAGE_EXT_MIME[ext];
		if (!mime) return { error: "unsupported type" };
		const st = await fs.promises.stat(expanded);
		if (!st.isFile()) return { error: "not a file" };
		if (st.size > IMAGE_MAX_BYTES) return { error: "too large" };
		const buf = await fs.promises.readFile(expanded);
		return { dataUrl: `data:${mime};base64,${buf.toString("base64")}` };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
});

// ── IPC: open a directory in a specific app (openchamber OpenInApp) ─────

ipcMain.handle("open-with", async (_event, payload) => {
	const data = payload ?? {};
	const app = typeof data.app === "string" ? data.app : "";
	const dirPath = typeof data.path === "string" ? data.path : "";
	if (!dirPath) return false;
	const { execFile } = require("node:child_process");
	try {
		await new Promise((resolve, reject) => {
			if (process.platform === "darwin") {
				// macOS `open` resolves both app display names and .app
				// paths, and the default handler when no app is given.
				execFile("open", app ? ["-a", app, dirPath] : [dirPath], err => (err ? reject(err) : resolve(null)));
			} else if (app) {
				// win32/linux: `app` is an absolute exe/binary path (see
				// open-in-apps discovery) — spawn it with the folder.
				execFile(app, [dirPath], err => (err ? reject(err) : resolve(null)));
			} else if (process.platform === "win32") {
				execFile("explorer.exe", [dirPath], err => (err ? reject(err) : resolve(null)));
			} else {
				execFile("xdg-open", [dirPath], err => (err ? reject(err) : resolve(null)));
			}
		});
		return true;
	} catch {
		return false;
	}
});

// ── IPC: discover apps the folder can be opened with (openchamber
//    OpenInAppButton parity). Per-platform:
//      darwin — scan standard /Applications locations for .app bundles
//               (real icons via app.getFileIcon).
//      win32  — probe common install dirs for editor/terminal EXEs.
//      linux  — probe PATH (`which`) for common file managers/editors.
//    The returned appName is an ABSOLUTE path on every platform (macOS
//    `open -a` accepts both display names and paths), so open-with can
//    spawn it directly. Empty list → the renderer shows its "no apps"
//    empty state (graceful on exotic setups).

const OPEN_IN_APP_MACOS = [
	{ id: "finder", appName: "Finder", file: "Finder.app", roots: ["/System/Library/CoreServices"] },
	{ id: "terminal", appName: "Terminal", file: "Terminal.app", roots: ["/System/Applications", "/Applications"] },
	{ id: "ghostty", appName: "Ghostty", file: "Ghostty.app", roots: ["/Applications", "/System/Applications", "~/Applications"] },
	{ id: "iterm", appName: "iTerm", file: "iTerm.app", roots: ["/Applications"] },
	{ id: "warp", appName: "Warp", file: "Warp.app", roots: ["/Applications"] },
	{ id: "vscode", appName: "Visual Studio Code", file: "Visual Studio Code.app", roots: ["/Applications"] },
	{ id: "cursor", appName: "Cursor", file: "Cursor.app", roots: ["/Applications"] },
	{ id: "zed", appName: "Zed", file: "Zed.app", roots: ["/Applications"] },
	{ id: "sublime", appName: "Sublime Text", file: "Sublime Text.app", roots: ["/Applications"] },
	{ id: "kate", appName: "Kate", file: "Kate.app", roots: ["/Applications", "~/Applications"] },
	{ id: "bbedit", appName: "BBEdit", file: "BBEdit.app", roots: ["/Applications", "~/Applications"] },
	{ id: "intellij", appName: "IntelliJ IDEA", file: "IntelliJ IDEA.app", roots: ["/Applications", "~/Applications"] },
	{ id: "pycharm", appName: "PyCharm", file: "PyCharm.app", roots: ["/Applications", "~/Applications"] },
	{ id: "goland", appName: "GoLand", file: "GoLand.app", roots: ["/Applications", "~/Applications"] },
	{ id: "rider", appName: "Rider", file: "Rider.app", roots: ["/Applications", "~/Applications"] },
	{ id: "clion", appName: "CLion", file: "CLion.app", roots: ["/Applications", "~/Applications"] },
];

const OPEN_IN_APP_WINDOWS = [
	// explorer needs no path — open-with special-cases it.
	{ id: "explorer", appName: "File Explorer", exe: "explorer.exe", absolute: false },
	{ id: "terminal", appName: "Windows Terminal", exe: "wt.exe", absolute: false },
	{ id: "vscode", appName: "Visual Studio Code", exe: path.join(process.env.LOCALAPPDATA ?? "C:\\Users\\", "Programs\\Microsoft VS Code\\Code.exe"), absolute: true },
	{ id: "cursor", appName: "Cursor", exe: path.join(process.env.LOCALAPPDATA ?? "C:\\Users\\", "Programs\\cursor\\Cursor.exe"), absolute: true },
	{ id: "zed", appName: "Zed", exe: path.join(process.env.LOCALAPPDATA ?? "C:\\Users\\", "Programs\\Zed\\zed.exe"), absolute: true },
	{ id: "intellij", appName: "IntelliJ IDEA", exe: path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "JetBrains\\IntelliJ IDEA\\bin\\idea64.exe"), absolute: true },
	{ id: "pycharm", appName: "PyCharm", exe: path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "JetBrains\\PyCharm\\bin\\pycharm64.exe"), absolute: true },
	{ id: "notepad", appName: "Notepad", exe: path.join(process.env.WINDIR ?? "C:\\Windows", "notepad.exe"), absolute: true },
];

const OPEN_IN_APP_LINUX_BINS = [
	{ id: "nautilus", appName: "Files (Nautilus)", bin: "nautilus" },
	{ id: "dolphin", appName: "Dolphin", bin: "dolphin" },
	{ id: "gnome-terminal", appName: "GNOME Terminal", bin: "gnome-terminal" },
	{ id: "konsole", appName: "Konsole", bin: "konsole" },
	{ id: "vscode", appName: "Visual Studio Code", bin: "code" },
	{ id: "cursor", appName: "Cursor", bin: "cursor" },
	{ id: "zed", appName: "Zed", bin: "zed" },
	{ id: "kate", appName: "Kate", bin: "kate" },
	{ id: "gedit", appName: "gedit", bin: "gedit" },
];

ipcMain.handle("open-in-apps", async () => {
	const home = os.homedir();
	const found = [];
	if (process.platform === "darwin") {
		for (const cand of OPEN_IN_APP_MACOS) {
			let appPath = null;
			for (const root of cand.roots) {
				const p = path.join(root.replace(/^~/, home), cand.file);
				if (fs.existsSync(p)) {
					appPath = p;
					break;
				}
			}
			if (appPath) found.push({ id: cand.id, appName: cand.appName, path: appPath });
		}
	} else if (process.platform === "win32") {
		const { execFileSync } = require("node:child_process");
		for (const cand of OPEN_IN_APP_WINDOWS) {
			if (!cand.absolute) {
				// explorer.exe / wt.exe live on the system PATH — resolve
				// to a real path so app.getFileIcon() below can extract an
				// actual icon (a bare exe name makes getFileIcon fail and
				// the renderer falls back to a letter chip).
				let resolved = cand.exe;
				try {
					const hit = execFileSync("where.exe", [cand.exe], { encoding: "utf8", windowsHide: true }).split(/\r?\n/)[0].trim();
					if (hit) resolved = hit;
				} catch {
					// not on PATH — open-with will still fail later; keep bare name
				}
				found.push({ id: cand.id, appName: cand.appName, path: resolved });
				continue;
			}
			if (fs.existsSync(cand.exe)) found.push({ id: cand.id, appName: cand.appName, path: cand.exe });
		}
	} else {
		const { execFileSync } = require("node:child_process");
		for (const cand of OPEN_IN_APP_LINUX_BINS) {
			try {
				// Resolve to an absolute path once (open-with spawns it
				// directly — avoids any PATH lookup ambiguity).
				const bin = execFileSync("which", [cand.bin], { encoding: "utf8" }).trim();
				if (bin) found.push({ id: cand.id, appName: cand.appName, path: bin });
			} catch {
				// not installed — skip
			}
		}
	}
	const apps = [];
	for (const cand of found) {
		let iconDataUrl = "";
		try {
			iconDataUrl = (await app.getFileIcon(cand.path, { size: "small" })).toDataURL();
		} catch {
			// icon unavailable — renderer falls back to a letter chip
		}
		apps.push({ id: cand.id, label: cand.appName, appName: cand.path, iconDataUrl });
	}
	return { apps };
});

// ── IPC: open a URL in the default browser (project-actions preview) ────

ipcMain.handle("open-external", async (_event, url) => {
	// https/http 外网 + macOS 系统设置深链(权限面板授权跳转)。
	if (typeof url !== "string" || !/^(https?:\/\/|x-apple\.systempreferences:)/i.test(url)) return false;
	try {
		await shell.openExternal(url);
		return true;
	} catch {
		return false;
	}
});

// ── IPC: reveal a directory in the OS file manager (预设设置"打开目录"等)。
// 路径来自 daemon 报告(modeDir/project 等),非任意输入。
ipcMain.handle("shell-open-path", async (_event, dirPath) => {
	if (typeof dirPath !== "string" || dirPath === "") return { ok: false, error: "empty path" };
	try {
		const error = await shell.openPath(dirPath);
		return error ? { ok: false, error } : { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
});

// ── IPC: clipboard (openchamber copy-path) ─────────────────────────────

ipcMain.handle("clipboard-write", (_event, text) => {
	clipboard.writeText(String(text ?? ""));
	return true;
});

// ── IPC: mini chat window (openchamber picture-in-picture) ─────────────

let miniWindow = null;

/** Open (or focus) the picture-in-picture mini chat window — shared by the
 *  header button and the tray's 迷你对话 entry. */
function openMiniChatWindow() {
	if (miniWindow && !miniWindow.isDestroyed()) {
		miniWindow.focus();
		return true;
	}
	miniWindow = new BrowserWindow({
		width: 520,
		height: 640,
		resizable: true,
		titleBarStyle: "hidden",
		trafficLightPosition: { x: 16, y: 17 },
		// Windows/Linux: titleBarStyle "hidden" draws no window controls on
		// its own (traffic lights are macOS-only) — the same problem as the
		// main window. titleBarOverlay puts native min/max/close at the
		// top-right; transparent color lets the page's glass show through,
		// height matches the .gui-mini-drag strip (28px). Ignored on macOS
		// (traffic lights) and on Linux distros that keep the system bar.
		...(process.platform === "win32" || process.platform === "linux"
			? {
					titleBarOverlay: {
						color: "#00000000",
						symbolColor: "#8a8a92",
						height: 28,
					},
				}
			: {}),
		// Native window glass, same as the main window: transparent
		// background + under-window vibrancy, otherwise the rounded chat
		// container corners paint black against an opaque background.
		backgroundColor: "#00000000",
		vibrancy: "under-window",
		webPreferences: {
			preload: path.resolve(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	const devServer = DEV && process.env.MUSEPI_GUI_DEV === "1" ? "http://127.0.0.1:5173/" : null;
	if (devServer) void miniWindow.loadURL(`${devServer}?mini=1`);
	else void miniWindow.loadFile(DIST_DIR + "/index.html", { query: { mini: "1" } });
	miniWindow.on("closed", () => {
		miniWindow = null;
	});
	return true;
}

ipcMain.handle("mini-chat-open", () => openMiniChatWindow());

// ── IPC: native directory picker (ZCode "打开文件夹" project add) ─────────

ipcMain.handle("dialog-open-directory", async () => {
	const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
	if (!win) return null;
	const result = await dialog.showOpenDialog(win, {
		properties: ["openDirectory", "createDirectory"],
		message: "选择项目文件夹",
	});
	return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
});

// ── Startup ───────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
	// Development runs from the stock Electron.app bundle, so the Dock shows
	// the default Atom icon — override it at runtime with our own (packaged
	// builds get the icon from the bundle instead).
	if (process.platform === "darwin" && DEV) {
		try {
			app.dock.setIcon(ICON_DOCK_PATH);
		} catch {
			// Dock icon override is cosmetic; ignore failures.
		}
	}
	// The dist/ build is regenerated frequently in dev — never serve stale
	// file:// resources (the old Tauri webview cached them and confused us).
	await session.defaultSession.clearCache();
	await createWindow();
	// Managed in-app browser (right-pane tool): the renderer mounts the
	// `<webview>` guests; main holds the partition policy and the loopback CDP
	// bridge the browser tool attaches to (browser.gui). The controller needs
	// the main window as its owner. Async: the CDP server binds with a
	// port-retry (managed-browser.cjs) — fire and forget, the renderer learns
	// the bound port from pushed state.
	void managedBrowser.start(mainWindow);
	// Menu-bar tray: session quick-switcher (openchamber parity). Lives
	// past window close on macOS, so create it once at boot.
	ensureTray();
	// Warm the tray menu window at boot (hidden): loadFile is async, so a
	// lazy first-open would show a blank rectangle while tray-menu.html
	// loads — the "delayed menu" on Windows. Pre-created + hidden, the
	// first click reveals an already-rendered menu.
	createTrayMenuWindow();

	// Dev hot-reload: `bun run dev:reload` rebuilds dist/ and touches
	// .dev-reload-trigger (deliberately outside dist/ — the build's
	// `rm -rf dist` would otherwise delete the watched directory and
	// invalidate the fs.watch handle). Every window reloads in place, so
	// renderer edits land without relaunching Electron or losing
	// main-process state. Production builds skip the watcher entirely.
	if (DEV) {
		const trigger = path.join(__dirname, "..", ".dev-reload-trigger");
		try {
			fs.watch(path.join(__dirname, ".."), () => {
				if (!fs.existsSync(trigger)) return;
				fs.rmSync(trigger, { force: true });
				for (const win of BrowserWindow.getAllWindows()) win.webContents.reload();
			});
		} catch {
			// Trigger file unreadable on first run; hot-reload just won't fire.
		}
	}

	// Restore pinned desktop widgets (independent windows; recreate after
	// the main window so launch ordering is stable).
	restorePinWindows();

	app.on("activate", () => {
		// Glow overlays are transparent chrome, not app windows — they
		// must not count toward "a window is open" on re-activate.
		const real = BrowserWindow.getAllWindows().filter(w => !glowWindows.has(w));
		if (real.length === 0) void createWindow();
	});
});


app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
