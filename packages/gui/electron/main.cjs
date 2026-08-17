/**
 * Electron main process — the MusePi GUI shell (replaces the Tauri shell).
 *
 * Window: macOS hiddenInset title bar keeps the native traffic lights and
 * the window full-bleed, matching the previous Tauri Overlay layout. The
 * renderer's toolbar already drags via -webkit-app-region (Electron honors
 * the same CSS as Tauri did), and its left padding clears the traffic
 * lights (88px), so no window chrome work is needed in here.
 *
 * Loads the built SPA (packages/gui/dist) over file:// — no dev static
 * server required. The daemon (musepi serve) is probed/spawned over IPC
 * from the renderer, identical semantics to the removed Tauri commands.
 */
"use strict";

const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, Notification, powerSaveBlocker, screen, session, shell } = require("electron");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { probe, restart, start, kill, portOpen } = require("./daemon.cjs");
const { createTrayController } = require("./tray.cjs");
const { checkForUpdates } = require("./updater.cjs");
const { ManagedBrowserController } = require("./managed-browser.cjs");

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
// Explicit Cmd+Q (defensive): macOS should quit on Cmd+Q by default, but a
// restart-in-flight (IPC awaiting kill/start) made it appear dead. A
// before-quit log plus the standard accelerator keep the escape hatch
// observable.
app.on("before-quit", () => console.error("[main] before-quit"));
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
//   pet-drag  {dx, dy}          move by delta (renderer pointer drag)
//   pet-click                    focus the main window
//   pet-activity {mood, bubble}  main-window store → pet window
//   pet-import                   pick a Petdex zip, unpack, return package
// Height 290: the pet anchors at bottom:52px in pet-window.css with 52px of
// transparent room below — rest shadow (0 6px 16px ≈ 22px) and hover shadow
// (0 10px 22px ≈ 32px, + bump ≈ 2px) all fade inside the window instead of
// being hard-cut at the bottom edge.
const PET_WINDOW_SIZE = { width: 320, height: 290 };
let petWindow = null;
let petVisible = false;

function petPosFile() {
	return path.join(app.getPath("userData"), "pet-pos.json");
}

function loadPetPosition() {
	try {
		const raw = fs.readFileSync(petPosFile(), "utf8");
		const pos = JSON.parse(raw);
		if (pos.dock === true || pos.dock === false) petDockEnabled = pos.dock;
		if (Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
			// The persisted position must be fully inside some display's work
			// area — macOS clamps out-of-bounds frames at show time, which
			// desyncs the stored position from the real one (and, worse,
			// makes the window jump back to the stale frame when the
			// click-through toggles). Fall back to the default otherwise.
			const visible = screen.getAllDisplays().some(d => {
				const b = d.workArea;
				return (
					pos.x >= b.x &&
					pos.x + PET_WINDOW_SIZE.width <= b.x + b.width &&
					pos.y >= b.y &&
					pos.y + PET_WINDOW_SIZE.height <= b.y + b.height
				);
			});
			if (visible) return { x: pos.x, y: pos.y };
		}
	} catch {
		// first run — default below
	}
	// Default: bottom-right of the primary display's work area.
	const work = screen.getPrimaryDisplay().workArea;
	return { x: work.x + work.width - PET_WINDOW_SIZE.width - 16, y: work.y + work.height - PET_WINDOW_SIZE.height - 16 };
}

function createPetWindow() {
	if (petWindow && !petWindow.isDestroyed()) return petWindow;
	const pos = loadPetPosition();
	petWindow = new BrowserWindow({
		...PET_WINDOW_SIZE,
		x: pos.x,
		y: pos.y,
		title: "MusePi Pet",
		frame: false,
		// Pure transparent (no vibrancy): vibrancy + transparent:true
		// renders the WHOLE window as an opaque glass panel (verified —
		// the desktop pet became a solid dark rectangle). The bubbles fake
		// the glass with a translucent surface + highlight edge instead.
		transparent: true,
		// Explicit transparent background: on Windows a transparent window
		// without backgroundColor can composite with an opaque default
		// (white/black block around the pet); the bubble window already
		// uses this exact pattern. No-op on macOS.
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
	petWindow.setAlwaysOnTop(true, "floating");
	petWindow.loadFile(path.join(DIST_DIR, "pet.html"));
	watchPetMove();
	// Windows: probe whether setPosition speaks DIP or physical px (see
	// probeSetPositionSpace) — safeSetPosition multiplies by scaleFactor
	// when physical, so drag travel matches the cursor at any scaling.
	void probeSetPositionSpace();
	// Any renderer navigation (reload, crash-reload) resets the drag
	// anchor — the fresh renderer starts with no pressed state, so a
	// stale petDragLast would make its first hover move drag the window
	// (openpets' resetForNavigation pattern).
	petWindow.webContents.on("did-finish-load", () => {
		petDragLast = null;
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
 *  Round + normalize here, drop the call when still not int32-safe. */
//
// Windows DPI-awareness: whether setPosition() speaks DIP or PHYSICAL
// pixels is not contractual (per-monitor DPI awareness / virtualized
// sessions disagree; Electron issue #10862 family). Probe once after the
// pet window exists: nudge +7px, read back 150ms later (win setPosition is
// async), restore. read == set+7 → DIP; read ≈ (set+7)×scale → PHYSICAL.
let petSetPositionIsPhysical = false;
async function probeSetPositionSpace() {
	const win = petWindow;
	if (!win || win.isDestroyed()) return;
	try {
		const [bx, by] = win.getPosition();
		win.setPosition(bx + 7, by);
		await new Promise(r => setTimeout(r, 150));
		const [ax] = win.getPosition();
		win.setPosition(bx, by); // restore
		const disp = screen.getDisplayMatching(win.getBounds());
		const scale = disp && disp.scaleFactor > 0 ? disp.scaleFactor : 1;
		petSetPositionIsPhysical = Math.abs(ax - (bx + 7) * scale) < Math.abs(ax - (bx + 7));
		console.log(
			"[dpi] setPosition probe: set=", bx + 7, "read=", ax, "scale=", scale,
			petSetPositionIsPhysical ? "→ PHYSICAL (×scale before set)" : "→ DIP",
		);
	} catch (err) {
		console.error("[dpi] setPosition probe failed:", err?.message || err);
	}
}
function safeSetPosition(win, x, y) {
	const nx = intCoord(x);
	const ny = intCoord(y);
	if (!Number.isFinite(nx) || !Number.isFinite(ny) || Math.abs(nx) > 1e7 || Math.abs(ny) > 1e7) {
		console.error("[pet] dropped invalid setPosition:", { x, y });
		return;
	}
	// Same-value guard: on Windows setPosition of an identical coordinate
	// still walks the window (WM_WINDOWPOSCHANGING), which feeds back into
	// the drag loop — window micro-move → synthetic pointermove in the
	// renderer → new pet-drag-client frame → setPosition again — reading as
	// "keeps drifting while I hold the mouse still". Skip the write when
	// the window is already exactly there.
	const [cx, cy] = win.getPosition();
	if (cx === nx && cy === ny) return;
	// Windows DPI-awareness quirk (probed at startup): setPosition() can
	// interpret its args as PHYSICAL pixels while getCursorScreenPoint()
	// returns DIP — dragging then scales the window's travel by 1/scaleFactor
	// ("lags / overruns at non-100% scaling", observed at 125% on the local
	// machine). Multiply DIP targets by the window display's scaleFactor.
	let sx = nx;
	let sy = ny;
	if (petSetPositionIsPhysical) {
		const disp = screen.getDisplayMatching(win.getBounds());
		const scale = disp && disp.scaleFactor > 0 ? disp.scaleFactor : 1;
		sx = Math.round(nx * scale);
		sy = Math.round(ny * scale);
	}
	win.setPosition(sx, sy);
}

/** Dock or clamp the pet window inside the work area after a drag. */
function settlePetWindow() {
	if (!petWindow || petWindow.isDestroyed()) return;
	cancelPetSettle();
	const wa = screen.getDisplayMatching(petWindow.getBounds()).workArea;
	const [wx, wy] = petWindow.getPosition();
	// Use the ACTUAL window size — a stale 320×290 assumption would let a
	// 340-wide (panel-open) window hang 20px past the right edge.
	const { width: w, height: h } = petWindow.getBounds();
	let x = wx;
	let y = wy;
	let side = null;
	if (petDockEnabled) {
		const MARGIN = 32;
		// Judge and align by the CHARACTER's edge (sprite rect), not the
		// window's — the 320×290 window is much wider than the centered
		// sprite, so window-edge tests would snap the window flush while
		// the pet still floats ~90px off the screen edge.
		const leftEdge = wx + petCharLeft();
		const rightEdge = wx + petCharRight();
		if (leftEdge <= wa.x + MARGIN) {
			x = wa.x - petCharLeft();
			side = "left";
		} else if (rightEdge >= wa.x + wa.width - MARGIN) {
			x = wa.x + wa.width - petCharRight();
			side = "right";
		}
		y = Math.min(Math.max(wy, wa.y), wa.y + wa.height - h);
	} else {
		x = Math.min(Math.max(wx, wa.x), wa.x + wa.width - w);
		y = Math.min(Math.max(wy, wa.y), wa.y + wa.height - h);
	}
	if (x !== wx || y !== wy) {
		// Short ease-out bounce to the settle position (180ms, 8 frames).
		// safeSetPosition drops any frame whose value is not int32-safe
		// (coordinate-flip garbage) instead of crashing the main process.
		// Windows: no glide — the release slide reads as "keeps moving
		// after I stopped" (the OS window move is less tight than macOS's,
		// so the bounce is far more visible); snap to the settle position.
		if (process.platform === "win32") {
			safeSetPosition(petWindow, x, y);
		} else {
			const fromX = wx;
			const fromY = wy;
			let frame = 0;
			petSettleTimer = setInterval(() => {
				frame += 1;
				const t = frame / 8;
				const ease = 1 - Math.pow(1 - t, 3);
				safeSetPosition(petWindow, fromX + (x - fromX) * ease, fromY + (y - fromY) * ease);
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
		const cursor = screen.getCursorScreenPoint();
		const [wx, wy] = petWindow.getPosition();
		ignore = !(
			cursor.x >= wx + petHitbox.x &&
			cursor.x <= wx + petHitbox.x + petHitbox.width &&
			cursor.y >= wy + petHitbox.y &&
			cursor.y <= wy + petHitbox.y + petHitbox.height
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
}

// BitFun's pointer poll interval; cheap and bounded.
setInterval(updatePetClickThrough, 120);

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
	} else if (petWindow && !petWindow.isDestroyed()) {
		petWindow.hide();
		petVisible = false;
		// A hide mid-drag can drop the pointerup; a stale anchor would
		// jump the window on the first move of the next drag.
		petDragLast = null;
	}
	// The bubble window follows the pet's visibility (and its content is
	// cleared by the next state push).
	if (bubbleWindow && !bubbleWindow.isDestroyed()) {
		if (visible) syncBubbleWindow();
		else if (bubbleWindow.isVisible()) bubbleWindow.hide();
	}
}

// Position persistence is throttled: a sync fs write per pointermove
// (~60-125Hz during a drag) would jank the main process. At most one
// write per 150ms while dragging; the final position is flushed by
// pet-drag-end (and pet-drag-client's anchor lives in petDragLast).
let petLastPosWrite = 0;
let petPosDirty = false;

function persistPetPos() {
	if (!petWindow || petWindow.isDestroyed()) return;
	try {
		fs.writeFileSync(petPosFile(), JSON.stringify({ x: petWindow.getPosition()[0], y: petWindow.getPosition()[1] }));
	} catch {
		// position persistence is best-effort
	}
}

function movePetWindow(dx, dy) {
	if (!petWindow || petWindow.isDestroyed() || !petVisible) return;
	// safeSetPosition drops NaN/garbage (multi-display coordinate flips)
	// instead of crashing — the drag simply skips that frame.
	const [x, y] = petWindow.getPosition();
	safeSetPosition(petWindow, x + Math.round(dx), y + Math.round(dy));
	const now = Date.now();
	if (now - petLastPosWrite >= 150) {
		petLastPosWrite = now;
		petPosDirty = false;
		persistPetPos();
	} else {
		petPosDirty = true;
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

// ── Bubble/panel window (双窗口) ────────────────────────────────────────
// The activity bubbles + interaction panel live in their OWN window so it
// can use real vibrancy glass (the pet window must stay transparent —
// vibrancy + transparent:true renders the whole window as an opaque panel).
// The bubble window is sized to EXACTLY its content (the renderer reports
// the content box; see bubble-set-size) and parked above the pet window,
// following it on every move/snap/settle.
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
		transparent: !(process.platform === "win32" && IS_WIN11),
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
	if (!bounds) {
		const work = screen.getPrimaryDisplay().workArea;
		win.setPosition(work.x + work.width - width - 12, work.y + work.height - height - 12);
		return;
	}
	const display = screen.getDisplayNearestPoint({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
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

let bubbleWindow = null;
let bubbleSize = null;
/** Last pet:activity payload — replayed to the bubble window when it
 *  loads (the first bubble can arrive before the window's renderer
 *  subscribed; without the replay it is silently dropped). */
let lastPetActivity = null;

function createBubbleWindow() {
	if (bubbleWindow && !bubbleWindow.isDestroyed()) return bubbleWindow;
	bubbleWindow = new BrowserWindow({
		width: 220,
		height: 120,
		title: "MusePi Bubbles",
		frame: false,
		// Platform-native frosted glass for the bubble/panel surface:
		// - macOS: under-window vibrancy + transparent background, the main
		//   window's recipe (transparent + vibrancy would render the whole
		//   window as an opaque panel instead).
		// - Windows/Linux: TRANSPARENT per-pixel window — the panel/bubbles
		//   are rounded shapes, and DWM Acrylic (backgroundMaterial) only
		//   works on opaque windows, which would paint a full RECTANGLE of
		//   frosted glass around the rounded cards (observed: visible glass
		//   band outside the panel corners). The cards self-draw their glass
		//   (.pet-glass-native: translucent surface + highlight edge, the
		//   clawd-on-desk double-layer pattern) so the window shape hugs the
		//   content exactly and everything outside stays transparent.
		transparent: process.platform !== "darwin",
		...(process.platform === "darwin" ? { vibrancy: "under-window" } : {}),
		backgroundColor: "#00000000",
		alwaysOnTop: true,
		skipTaskbar: true,
		resizable: false,
		fullscreenable: false,
		// Window shadow: on a transparent window (Win/Linux) macOS-style
		// rectangle shadows are unavailable/ugly — the cards draw their own
		// rounded shadow (CSS box-shadow). On the macOS vibrancy window the
		// native shadow follows the rounded glass rect and gives the card
		// its float depth, so enable it there.
		hasShadow: process.platform === "darwin",
		show: false,
		webPreferences: {
			preload: path.join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			backgroundThrottling: false,
		},
	});
	bubbleWindow.setAlwaysOnTop(true, "floating");
	bubbleWindow.loadFile(path.join(DIST_DIR, "bubble.html"));
	// Replay the last activity (bubbles/approvals/state/recent) once the
	// renderer is listening — the window may be created BY an activity
	// push. webContents.send is dropped when it races the React effect
	// subscription (module scripts + passive effects run after
	// did-finish-load), so delay the replay a beat past load.
	bubbleWindow.webContents.on("did-finish-load", () => {
		if (!lastPetActivity) return;
		setTimeout(() => {
			if (!bubbleWindow.isDestroyed()) bubbleWindow.webContents.send("pet:activity", lastPetActivity);
		}, 150);
	});
	bubbleWindow.on("closed", () => {
		bubbleWindow = null;
		bubbleSize = null;
	});
	return bubbleWindow;
}

/** Park the bubble window above the sprite, horizontally centered on it. */
function syncBubbleWindow() {
	if (!bubbleWindow || bubbleWindow.isDestroyed()) return;
	if (!petWindow || petWindow.isDestroyed() || !petVisible || bubbleSize === null) {
		if (bubbleWindow.isVisible()) bubbleWindow.hide();
		return;
	}
	const [px, py] = petWindow.getPosition();
	const [bw, bh] = bubbleWindow.getSize();
	// Anchor on the SPRITE, not the window: the 320×290 window is much
	// wider than the centered sprite and hangs off-screen when docked —
	// window-centering would clip the bubble at the screen edge and park
	// it ~140px above the character's head.
	const cx = px + (petRect ? petRect.x + petRect.width / 2 : PET_WINDOW_SIZE.width / 2);
	const cy = py + (petRect ? petRect.y : 0);
	// The bubble content sits at PAD=24px inside the window (renderer's
	// .pet-bubble-window margin; bubble-set-size reports content + PAD*2).
	// Anchor the CONTENT 6px above the sprite, not the window box — with
	// the margin the window is 48px taller/wider than the card.
	const BUBBLE_WINDOW_PAD = 24;
	let x = Math.round(cx - bw / 2);
	let y = Math.round(cy - bh - 6 + BUBBLE_WINDOW_PAD);
	// Clamp inside the work area: at a docked edge the bubble is wider
	// than the sprite, so pure centering would push it off-screen.
	const wa = screen.getDisplayMatching(petWindow.getBounds()).workArea;
	x = Math.min(Math.max(x, wa.x + 4), wa.x + wa.width - bw - 4);
	y = Math.max(y, wa.y + 4);
	safeSetPosition(bubbleWindow, x, y);
	if (!bubbleWindow.isVisible()) bubbleWindow.showInactive();
}

// Pet window moves must drag the bubble window along (drag, snap, settle).
function watchPetMove() {
	if (!petWindow || petWindow.isDestroyed()) return;
	petWindow.on("move", syncBubbleWindow);
}

function syncBubbleVisibility() {
	if (!bubbleWindow || bubbleWindow.isDestroyed()) return;
	if (petVisible && bubbleSize !== null) syncBubbleWindow();
	else if (bubbleWindow.isVisible()) bubbleWindow.hide();
}

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
			if (!mainWindow || mainWindow.isDestroyed()) createWindow();
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
		let port = probe();
		// ws.port can be STALE — a previous daemon's port that no longer
		// listens (a daemon that fails its writeFile leaves the old value;
		// observed: ws.port said 8741 while the daemon bound 8300). A dead
		// port must count as "no daemon": otherwise the tray WS never opens,
		// update() never runs, and the tray icon is never created.
		if (port && !(await portOpen(port))) port = null;
		// Fall back to the renderer's DEFAULT_URL port (gui/src/app.tsx) —
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
ipcMain.handle("pet-drag", (_event, { dx, dy }) => {
	movePetWindow(Number(dx) || 0, Number(dy) || 0);
	return { ok: true };
});
// Renderer pointerdown: keep the window interactive (no click-through
// flip) until the drag ends — the 120ms poll would otherwise drop the
// pointer stream between down and the first move, or after a click.
ipcMain.handle("pet-drag-arm", () => {
	petDragArmed = true;
	return { ok: true };
});
// Drag via window-relative client coords (anchor declared above with the
// click-through state — the poll reads it every tick).
//
// Windows DPI: under a virtualized session (UU remote / RDP) at non-100%
// scaling, screen.getCursorScreenPoint() can report PHYSICAL pixels while
// setPosition() talks DIP — the pet then drifts while the mouse holds
// still (user-observed at 175% scaling). The renderer's clientX is a
// Chromium window coordinate (always DIP), so winPos + client = screen-DIP
// is ground truth to probe the cursor API's coordinate space with. Probed
// once per anchor (window is stationary then, so getPosition is reliable);
// re-probed on re-anchor, which the 500px coordinate-flip guard triggers.
let petCursorIsPhysical = false;
let petCursorScale = 1;
function probeCursorSpace(clientX) {
	if (!Number.isFinite(clientX)) return;
	const raw = screen.getCursorScreenPoint();
	const disp = screen.getDisplayMatching(petWindow.getBounds());
	const scale = disp && disp.scaleFactor > 0 ? disp.scaleFactor : 1;
	const winPos = petWindow.getPosition();
	const expectedDip = winPos[0] + clientX;
	const errDip = Math.abs(raw.x - expectedDip);
	const errPhys = Math.abs(raw.x - expectedDip * scale);
	petCursorIsPhysical = errPhys < errDip;
	petCursorScale = scale;
	console.log(
		"[dpi] raw=", raw.x, raw.y, "scale=", scale,
		"win=", winPos[0], winPos[1], "client=", clientX,
		"errDip=", errDip.toFixed(1), "errPhys=", errPhys.toFixed(1),
		petCursorIsPhysical ? "→ PHYSICAL (÷scale)" : "→ DIP",
	);
}
function petDragCursor() {
	const raw = screen.getCursorScreenPoint();
	return petCursorIsPhysical
		? { x: raw.x / petCursorScale, y: raw.y / petCursorScale }
		: { x: raw.x, y: raw.y };
}
ipcMain.handle("pet-drag-client", (_event, { clientX, clientY }) => {
	if (!petWindow || petWindow.isDestroyed() || !petVisible) return { ok: true };
	// Anchor-based drag: pin the window to the (DPI-normalized) cursor. The
	// window is set DIRECTLY to anchor-position + cursor-travel, never
	// diffed against a fresh getPosition() read: on Windows setPosition is
	// asynchronous, so getPosition() right after returns the OLD position
	// and dx = next - old repeats the same travel every frame, overrunning
	// the cursor and making the pet "keep moving after the mouse stops".
	cancelPetSettle();
	if (petDragLast === null) {
		probeCursorSpace(clientX);
	}
	const cursor = petDragCursor();
	if (petDragLast === null) {
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
	// A drag moves the window by (roughly) the cursor's travel since the
	// anchor — at most a few hundred px per frame. A delta far larger
	// (observed +1680px, a full display width, when the window straddles
	// two differently-scaled displays) is the coordinate-space flip:
	// re-anchor instead, preserving the window↔cursor offset so the drag
	// continues seamlessly.
	if (Math.abs(deltaX) > 500 || Math.abs(deltaY) > 500) {
		petDragLast = {
			cx: cursor.x,
			cy: cursor.y,
			wx: petDragLast.wx + deltaX,
			wy: petDragLast.wy + deltaY,
		};
		return { ok: true };
	}
	safeSetPosition(petWindow, petDragLast.wx + deltaX, petDragLast.wy + deltaY);
	// Persist (throttled) — same cadence movePetWindow used.
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
// Pet double-click: quick-show/hide of the main window. Visible → minimize;
// hidden or minimized → restore + show + focus.
ipcMain.handle("pet-toggle-main", () => {
	if (mainWindow && !mainWindow.isDestroyed()) {
		if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
			mainWindow.minimize();
		} else {
			focusMainFromPet();
		}
	}
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
	// Cache for bubble-window replay (the window may load after this push).
	lastPetActivity = payload;
	// Both windows consume pet:activity: the pet window uses mood/scale/
	// unread/theme; the bubble window uses bubble/approval/state/recent
	// sessions/theme.
	if (petWindow && !petWindow.isDestroyed() && petVisible) {
		petWindow.webContents.send("pet:activity", payload);
	}
	// If the payload carries bubble/panel content, make sure the bubble
	// window exists — a first bubble arriving before any interaction must
	// not be dropped.
	const needsBubble =
		payload &&
		typeof payload === "object" &&
		Boolean(payload.bubble || payload.approval || Array.isArray(payload.recentSessions));
	if (needsBubble && petWindow && !petWindow.isDestroyed() && petVisible) {
		createBubbleWindow();
	}
	if (bubbleWindow && !bubbleWindow.isDestroyed()) {
		bubbleWindow.webContents.send("pet:activity", payload);
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
				if (bubbleWindow && !bubbleWindow.isDestroyed()) bubbleWindow.webContents.send("pet:panel-toggle");
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
					// subsequent drops near an edge keep snapping.
					const wa = screen.getDisplayMatching(petWindow.getBounds()).workArea;
					const [wx, wy] = petWindow.getPosition();
					const { width: w } = petWindow.getBounds();
					const leftDist = wx + petCharLeft() - wa.x;
					const rightDist = wa.x + wa.width - (wx + petCharRight());
					const toLeft = leftDist <= rightDist;
					const x = toLeft ? wa.x - petCharLeft() : wa.x + wa.width - petCharRight();
					safeSetPosition(petWindow, x, wy);
					const side = toLeft ? "left" : "right";
					if (side !== petDockSide && !petWindow.isDestroyed()) {
						petDockSide = side;
						petWindow.webContents.send("pet:dock", { side });
					}
					try {
						const f = petPosFile();
						const raw = JSON.parse(fs.readFileSync(f, "utf8"));
						fs.writeFileSync(f, JSON.stringify({ ...raw, x, y: wy, dock: true }));
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
// Main-window renderer → bubble window: transcript for the requested
// session (the panel lives in the bubble window now).
ipcMain.handle("pet-session-content", (_event, payload) => {
	if (bubbleWindow && !bubbleWindow.isDestroyed() && payload && typeof payload.sessionId === "string") {
		bubbleWindow.webContents.send("pet:session-content", payload);
	}
	return { ok: true };
});
ipcMain.handle("pet-approve", (_event, { requestId, approved }) => {
	if (mainWindow && !mainWindow.isDestroyed() && typeof requestId === "string") {
		mainWindow.webContents.send("pet:command", { type: "approve", requestId, approved: approved === true });
	}
	return { ok: true };
});
// Pet bubble ×: the user acknowledged that notification — clear the
// session's unread badge in the main window (it owns the unread set; the
// bubble itself is already removed by the bubble window).
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
ipcMain.handle("pet-set-panel", (_event, open) => {
	// The panel now lives in the BUBBLE window (双窗口) — this IPC is kept
	// for the bubble renderer's toggle; the window itself is sized by the
	// bubble-set-size content reports. Just make sure the bubble window
	// exists so an open panel is never dropped.
	if (open === true) {
		createBubbleWindow();
		syncBubbleWindow();
	}
	return { ok: true };
});
// Pet window asks the main window's renderer for a fresh activity snapshot
// when it (re)appears — the renderer answers via pet-activity on mount.
ipcMain.handle("pet-request-state", () => {
	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.webContents.send("pet:request-state");
	}
	return { ok: true };
});
// Pet window single click → toggle the BUBBLE window's interaction panel.
ipcMain.handle("pet-toggle-panel", () => {
	if (!bubbleWindow || bubbleWindow.isDestroyed()) return { ok: true };
	if (bubbleWindow.webContents.isLoading()) {
		// The window is still loading (first click after creation): a send
		// now would race the React subscription and be dropped. Replay once
		// it settles — same delay as the activity replay.
		setTimeout(() => {
			if (bubbleWindow && !bubbleWindow.isDestroyed()) bubbleWindow.webContents.send("pet:panel-toggle");
		}, 200);
	} else {
		bubbleWindow.webContents.send("pet:panel-toggle");
	}
	return { ok: true };
});
// Bubble window reports its content box (CSS px) → size the OS window to
// exactly that (a glass card), parked above the pet.
ipcMain.handle("bubble-set-size", (_event, rect) => {
	if (rect && Number.isFinite(rect.width) && Number.isFinite(rect.height)) {
		bubbleSize = { width: Math.max(8, Math.round(rect.width)), height: Math.max(8, Math.round(rect.height)) };
	} else {
		bubbleSize = null;
	}
	if (!bubbleWindow || bubbleWindow.isDestroyed()) return { ok: true };
	const [bw, bh] = bubbleWindow.getSize();
	if (bubbleSize && (bw !== bubbleSize.width || bh !== bubbleSize.height)) {
		bubbleWindow.setSize(bubbleSize.width, bubbleSize.height);
	}
	syncBubbleWindow();
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
		execFile("tar", ["-xf", zipPath, "-C", dest], (err) => (err ? reject(err) : resolve()));
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

// Keep-awake (settings 常规 → 保持电脑运行): hold a powerSaveBlocker
// assertion while enabled so idle system sleep never fires; the user can
// still sleep manually / close the lid. Cross-platform: Electron maps
// "prevent-app-suspension" to kIOPMAssertionTypePreventUserIdleSystemSleep
// (same as `caffeinate -i`) on macOS, ES_SYSTEM_REQUIRED on Windows and
// org.freedesktop.ScreenSaver Inhibit on Linux. Assertions release
// automatically on process exit.
let keepAwakeId = null;
ipcMain.handle("keep-awake-set", (_event, enabled) => {
	if (enabled === true && keepAwakeId === null) {
		keepAwakeId = powerSaveBlocker.start("prevent-app-suspension");
	} else if (enabled !== true && keepAwakeId !== null) {
		powerSaveBlocker.stop(keepAwakeId);
		keepAwakeId = null;
	}
	return { ok: true };
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
		execFile("tar", ["-xf", zipPath, "-C", dest], (err) => (err ? reject(err) : resolve()));
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

function createWindow() {
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
		// - Windows: TRANSPARENT window + CSS glass layer. DWM Acrylic
		//   (backgroundMaterial) has no per-window tint-opacity API, so the
		//   磨砂玻璃透明度 slider could only change the page tint's depth,
		//   never the background see-through (user report). A transparent
		//   frame lets the CSS --gui-glass-alpha drive real see-through;
		//   the glass layer self-draws (blur + translucent scrim, same
		//   recipe as the bubble window). Cost: per-surface redraws on
		//   transparent frames — the reason acrylic was chosen before —
		//   mitigated by keeping the main scrim blur-free (alpha only).
		...(process.platform === "darwin"
			? { backgroundColor: "#00000000", vibrancy: "under-window" }
			: { backgroundColor: "#00000000" }),
	});

	// Dev hot-reload renderer: with MUSEPI_GUI_DEV=1 (bun run desktop:dev)
	// load the Vite dev server so component edits HMR in place; otherwise
	// serve the built dist bundle.
	const devServer = DEV && process.env.MUSEPI_GUI_DEV === "1" ? "http://127.0.0.1:5173/" : null;
	if (devServer) mainWindow.loadURL(devServer);
	else mainWindow.loadFile(path.join(DIST_DIR, "index.html"));

	// Renderer crash (OOM / fatal page error): the WebSocket to the daemon
	// dies with the renderer, leaving the window dead and the session turn
	// orphaned ("前后端掉线"). Auto-reload — the app's boot/reconnect path
	// re-attaches and reopens the active session (rpc onStatus open →
	// openSession), so a crash recovers without a manual relaunch.
	mainWindow.webContents.on("render-process-gone", (_event, details) => {
		if (details.reason === "clean-exit") return;
		console.error("[main] renderer process gone:", details.reason, "exitCode:", details.exitCode);
		if (!mainWindow.isDestroyed()) mainWindow.webContents.reload();
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

	// Webview popups (embedded browser): openchamber-style in-place
	// navigation — deny new windows, load http/https targets inside the
	// same webview so target=_blank links don't spawn orphan windows.
	app.on("web-contents-created", (_event, contents) => {
		if (contents.getType() !== "webview") return;
		contents.setWindowOpenHandler(({ url }) => {
			if (/^https?:/i.test(url)) contents.loadURL(url);
			return { action: "deny" };
		});
	});
}

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
	const proc = spawn(helper, [], { stdio: ["pipe", "ignore", "ignore"] });
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
		// Windows: glass is DWM-provided (backgroundMaterial). Toggle the
		// material instead of window transparency — transparent:true on
		// Windows flickers per-surface under GPU and would cover the Mica.
		try {
			win.setBackgroundMaterial(enabled ? "acrylic" : "none");
		} catch {
			// Windows 10 / unsupported: material API absent — opaque
			// background stands, nothing to do.
		}
		return;
	}
	if (enabled) {
		win.setVibrancy("under-window");
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

// Silent auto-check shortly after launch (silence with OMP_NO_AUTO_UPDATE).
if (process.env.OMP_NO_AUTO_UPDATE !== "1") {
	app.whenReady().then(() => {
		setTimeout(() => {
			checkForUpdates()
				.then(result => {
					if (result.enabled && result.newer && mainWindow) {
						mainWindow.webContents.send("update-available", result);
					}
				})
				.catch(() => {});
		}, 12000);
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
					const hit = execFileSync("where.exe", [cand.exe], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
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
	if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return false;
	try {
		await shell.openExternal(url);
		return true;
	} catch {
		return false;
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
	createWindow();
	// Managed in-app browser (right-pane tool): WebContentsView tabs + the
	// loopback CDP bridge the browser tool attaches to (browser.gui). The
	// controller needs the main window as its view owner. Async: the CDP
	// server binds with a port-retry (managed-browser.cjs) — fire and
	// forget, the renderer learns the bound port from pushed state.
	void managedBrowser.start(mainWindow);
	// Menu-bar tray: session quick-switcher (openchamber parity). Lives
	// past window close on macOS, so create it once at boot.
	ensureTray();

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
		if (real.length === 0) createWindow();
	});
});


app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
