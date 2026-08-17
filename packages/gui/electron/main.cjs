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

const { app, BrowserWindow, clipboard, dialog, ipcMain, net, Notification, screen, session, shell } = require("electron");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { probe, restart, start, kill } = require("./daemon.cjs");
const { checkForUpdates } = require("./updater.cjs");

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
if (process.env.OMP_SOFTWARE_GL === "1") {
	app.disableHardwareAcceleration();
} else {
	app.commandLine.appendSwitch("enable-gpu");
	app.commandLine.appendSwitch("ignore-gpu-blocklist");
}

const DEV = !app.isPackaged;
const DIST_DIR = path.resolve(__dirname, "..", "dist");
const ICON_PATH = path.resolve(__dirname, "..", "build", "icon.png");
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
		transparent: true,
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
	// macOS 26). Non-darwin platforms keep the window fully interactive.
	if (process.platform === "darwin") {
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
/** Last ignore state, so the poll only calls setIgnoreMouseEvents on change. */
let petIgnoreState = null;
/** Last hover state pushed to the pet window (drives the hover mood row). */
let petHoverState = null;

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
/** Position the pet window had before the panel expanded — restored on
 *  collapse so the pet never jumps (the panel may grow upward or down). */
let petPrePanelPos = null;
/** 8-frame settle animation handle — cancelled if a drag starts mid-bounce. */
let petSettleTimer = null;

function cancelPetSettle() {
	if (petSettleTimer !== null) {
		clearInterval(petSettleTimer);
		petSettleTimer = null;
	}
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
		if (wx <= wa.x + MARGIN) {
			x = wa.x;
			side = "left";
		} else if (wx + w >= wa.x + wa.width - MARGIN) {
			x = wa.x + wa.width - w;
			side = "right";
		}
		y = Math.min(Math.max(wy, wa.y), wa.y + wa.height - h);
	} else {
		x = Math.min(Math.max(wx, wa.x), wa.x + wa.width - w);
		y = Math.min(Math.max(wy, wa.y), wa.y + wa.height - h);
	}
	if (x !== wx || y !== wy) {
		// Short ease-out bounce to the settle position (180ms, 8 frames).
		const fromX = wx;
		const fromY = wy;
		let frame = 0;
		petSettleTimer = setInterval(() => {
			frame += 1;
			const t = frame / 8;
			const ease = 1 - Math.pow(1 - t, 3);
			petWindow.setPosition(
				Math.round(fromX + (x - fromX) * ease),
				Math.round(fromY + (y - fromY) * ease),
			);
			if (frame >= 8) {
				clearInterval(petSettleTimer);
				petSettleTimer = null;
			}
		}, 20);
	}
	if (side !== petDockSide && !petWindow.isDestroyed()) {
		petDockSide = side;
		petWindow.webContents.send("pet:dock", { side });
	}
}

function updatePetClickThrough() {
	if (!petWindow || petWindow.isDestroyed() || !petVisible || process.platform !== "darwin") return;
	let ignore = true;
	// Never click-through mid-drag: pointer capture depends on the window
	// receiving events. A fast drag lets the cursor outrun the window past
	// the hitbox edge; flipping ignore would drop the pointerup — the
	// renderer's resetDrag then never runs and petDragLast goes stale,
	// making the NEXT drag's first move jump the window by the old delta.
	if (petDragLast === null) {
		if (petHitbox) {
			const cursor = screen.getCursorScreenPoint();
			const [wx, wy] = petWindow.getPosition();
			ignore = !(
				cursor.x >= wx + petHitbox.x &&
				cursor.x <= wx + petHitbox.x + petHitbox.width &&
				cursor.y >= wy + petHitbox.y &&
				cursor.y <= wy + petHitbox.y + petHitbox.height
			);
		}
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

function setPetVisible(visible) {
	if (visible) {
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
	const [x, y] = petWindow.getPosition();
	const next = { x: x + Math.round(dx), y: y + Math.round(dy) };
	petWindow.setPosition(next.x, next.y);
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

ipcMain.handle("pet-toggle", (_event, visible) => {
	setPetVisible(visible === true);
	return { ok: true };
});
ipcMain.handle("pet-drag", (_event, { dx, dy }) => {
	movePetWindow(Number(dx) || 0, Number(dy) || 0);
	return { ok: true };
});
// Drag via window-relative client coords (anchor declared above with the
// click-through state — the poll reads it every tick).
ipcMain.handle("pet-drag-client", (_event, { clientX, clientY }) => {
	if (!petWindow || petWindow.isDestroyed() || !petVisible) return { ok: true };
	// Anchor-based drag (2026-08-06): pin the window to the PHYSICAL
	// cursor (screen.getCursorScreenPoint), never to window-relative
	// client coords. Delta math on clientX accumulates error once the
	// window moves — abs was computed from the MOVED window position but
	// petDragLast stored the PRE-move one, so the window outran the
	// cursor by one window-displacement per frame, overshot it, then
	// oscillated around it (which also flipped the renderer's walk
	// mirror every frame — the "鬼畜" drag).
	const cursor = screen.getCursorScreenPoint();
	cancelPetSettle();
	if (petDragLast === null) {
		petDragLast = {
			cx: cursor.x,
			cy: cursor.y,
			wx: petWindow.getPosition()[0],
			wy: petWindow.getPosition()[1],
		};
		return { ok: true };
	}
	const [wx, wy] = petWindow.getPosition();
	const next = {
		x: petDragLast.wx + (cursor.x - petDragLast.cx),
		y: petDragLast.wy + (cursor.y - petDragLast.cy),
	};
	movePetWindow(next.x - wx, next.y - wy);
	return { ok: true };
});
ipcMain.handle("pet-drag-end", () => {
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
ipcMain.handle("pet-activity", (_event, payload) => {
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
// Main-window renderer → pet window: transcript for the requested session.
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
	return { ok: true };
});
// Panel expand/collapse: the compact pet window (320×290) grows to fit the
// status + quick-reply + approval panel, then shrinks back.
const PET_PANEL_SIZE = { width: 340, height: 540 };
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
/** Expand the pet window to panel size with smart placement: the panel
 *  grows UP by default (window bottom edge fixed → the pet never jumps);
 *  if there is no room above (pet near the screen top), it grows DOWN and
 *  the pet yields. Clamped to the work area either way. */
function expandPetPanel() {
	if (!petWindow || petWindow.isDestroyed()) return;
	const wa = screen.getDisplayMatching(petWindow.getBounds()).workArea;
	const [wx, wy] = petWindow.getPosition();
	const bottomEdge = wy + PET_WINDOW_SIZE.height;
	const grow = PET_PANEL_SIZE.height - PET_WINDOW_SIZE.height;
	let y;
	let height;
	if (wy - wa.y >= grow) {
		y = bottomEdge - PET_PANEL_SIZE.height;
		height = PET_PANEL_SIZE.height;
	} else if (wa.y + wa.height - bottomEdge >= grow) {
		y = wy;
		height = PET_PANEL_SIZE.height;
	} else {
		y = Math.max(wa.y, bottomEdge - PET_PANEL_SIZE.height);
		height = Math.min(PET_PANEL_SIZE.height, bottomEdge - y);
	}
	petWindow.setBounds({ x: wx, y, width: PET_PANEL_SIZE.width, height });
}

ipcMain.handle("pet-set-panel", (_event, open) => {
	if (petWindow && !petWindow.isDestroyed()) {
		if (open) {
			if (petPrePanelPos === null) {
				const [px, py] = petWindow.getPosition();
				petPrePanelPos = { x: px, y: py };
			}
			expandPetPanel();
		} else {
			cancelPetSettle();
			if (petPrePanelPos !== null) {
				// Restore the pre-panel spot so the pet doesn't jump back.
				petWindow.setBounds({
					x: petPrePanelPos.x,
					y: petPrePanelPos.y,
					width: PET_WINDOW_SIZE.width,
					height: PET_WINDOW_SIZE.height,
				});
				petPrePanelPos = null;
			} else {
				petWindow.setSize(PET_WINDOW_SIZE.width, PET_WINDOW_SIZE.height);
			}
			// Drop any stale dock highlight while collapsed.
			if (petDockSide !== null && !petWindow.isDestroyed()) {
				petDockSide = null;
				petWindow.webContents.send("pet:dock", { side: null });
			}
		}
		// The click-through hitbox must cover the whole panel while open —
		// the renderer reports the union via pet-set-hitbox as the layout
		// settles; forcing a poll refresh now keeps it responsive.
		petIgnoreState = null;
		updatePetClickThrough();
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

// ── Petdex import (Petdex zip → unpack → pet.json + spritesheet) ────────
// Unpacks with the system bsdtar (`tar -xf`) which handles zip on macOS,
// Linux and Windows alike. Returns the package without image dimensions —
// the renderer decodes the data URL to fill width/height.
const { execFile, spawn } = require("node:child_process");

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

// Keep-awake (settings 常规 → 保持电脑运行): hold a `caffeinate -i`
// child while enabled so idle system sleep never fires; the user can
// still sleep manually / close the lid. macOS only — other platforms
// report ok:false (the toggle still renders, harmlessly inert).
let keepAwakeChild = null;
ipcMain.handle("keep-awake-set", (_event, enabled) => {
	if (process.platform !== "darwin") return { ok: false };
	if (enabled === true && !keepAwakeChild) {
		keepAwakeChild = spawn("caffeinate", ["-i"]);
		keepAwakeChild.on("exit", () => {
			keepAwakeChild = null;
		});
	} else if (enabled !== true && keepAwakeChild) {
		keepAwakeChild.kill("SIGTERM");
		keepAwakeChild = null;
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


function createWindow() {
	mainWindow = new BrowserWindow({
		title: "MusePi",
		width: 1280,
		height: 800,
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
		// Native window glass (macOS 26 Tahoe renders this as the current
		// system material): transparent background + under-window vibrancy so
		// the desktop shows through the shell; the page paints translucent
		// scrims over it. The renderer toggles this off via `gui-vibrancy`.
		backgroundColor: "#00000000",
		vibrancy: "under-window",
	});

	// Dev hot-reload renderer: with MUSEPI_GUI_DEV=1 (bun run desktop:dev)
	// load the Vite dev server so component edits HMR in place; otherwise
	// serve the built dist bundle.
	const devServer = DEV && process.env.MUSEPI_GUI_DEV === "1" ? "http://127.0.0.1:5173/" : null;
	if (devServer) mainWindow.loadURL(devServer);
	else mainWindow.loadFile(path.join(DIST_DIR, "index.html"));

	mainWindow.on("closed", () => {
		mainWindow = null;
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
		notification.on("failed", (_event, error) => {
			// Electron 42+ on macOS: unsigned apps fail silently here
			// (UNNotification requires code signing) — surface the reason
			// instead of swallowing it.
			console.error("[notification] failed:", error?.message ?? error);
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

// ── IPC: window glass (window-transparency toggle in settings) ────────────
// OFF restores an opaque base (theme-matched) so the desktop never shows
// through; ON re-applies the native under-window material. NOTE: Electron
// 43 exposes no bright vibrancy variant (`light` was removed; `window` etc.
// follow the SYSTEM appearance, which is dark on this machine) — the light
// scheme's clean white glass is achieved in CSS with a heavier white scrim
// (see --gui-glass-overlay derivation in gui.css), not the native layer.
// Haptic feedback (macOS Taptic Engine): NSHapticFeedbackManager via
// osascript JXA — no native module needed. Patterns: 0 generic, 1
// alignment, 2 level-change. Throttled (~80ms) so rapid clicks queue one
// tap instead of spawning an osascript per event.
let lastHapticAt = 0;
ipcMain.handle("haptic", (_event, pattern = 0) => {
	const now = Date.now();
	if (now - lastHapticAt < 80) return { ok: true, skipped: true };
	lastHapticAt = now;
	execFile(
		"osascript",
		[
			"-l",
			"JavaScript",
			"-e",
			`ObjC.import("AppKit"); $.NSHapticFeedbackManager.defaultPerformer.performOutputPattern(${Number.isInteger(pattern) ? pattern : 0}, 0)`,
		],
		() => {},
	);
	return { ok: true };
});
ipcMain.handle("gui-vibrancy", (event, enabled, style) => {	const win = BrowserWindow.fromWebContents(event.sender);
	if (!win) return;
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
ipcMain.handle("daemon-start", (_event, port) => start(Number(port), daemonEnv()));
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
	const appName = typeof data.app === "string" ? data.app : "";
	const dirPath = typeof data.path === "string" ? data.path : "";
	if (!dirPath) return false;
	const { execFile } = require("node:child_process");
	try {
		// No app name → open in the system default application (macOS `open`).
		await new Promise((resolve, reject) => {
			const args = appName ? ["-a", appName, dirPath] : [dirPath];
			execFile("open", args, err => (err ? reject(err) : resolve(null)));
		});
		return true;
	} catch {
		return false;
	}
});

// ── IPC: discover apps the folder can be opened with (openchamber
//    OpenInAppButton parity) — scan the standard macOS app locations and
//    read each app's real .icns via app.getFileIcon (base64 data URL so the
//    renderer can <img> it without fs access).

const OPEN_IN_APP_CANDIDATES = [
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

ipcMain.handle("open-in-apps", async () => {
	if (process.platform !== "darwin") return { apps: [] };
	const apps = [];
	const home = os.homedir();
	for (const cand of OPEN_IN_APP_CANDIDATES) {
		let appPath = null;
		for (const root of cand.roots) {
			const p = path.join(root.replace(/^~/, home), cand.file);
			if (fs.existsSync(p)) {
				appPath = p;
				break;
			}
		}
		if (!appPath) continue;
		let iconDataUrl = "";
		try {
			iconDataUrl = (await app.getFileIcon(appPath, { size: "small" })).toDataURL();
		} catch {
			// icon unavailable — renderer falls back to a letter chip
		}
		apps.push({ id: cand.id, label: cand.appName, appName: cand.appName, iconDataUrl });
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

ipcMain.handle("mini-chat-open", () => {
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
});

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
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});


app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
