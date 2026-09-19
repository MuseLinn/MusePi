"use strict";

// ── Windows desktop integration via koffi FFI (2026-09-19) ──────────────
//
// Three things Electron does not expose, all of which the pet needs to stay
// put and stay visible on win32:
//
//  1. FOREGROUND-FULLSCREEN DETECTION. The topmost watchdog re-asserts the
//     pet's z-order band every 5s. Without knowing whether a fullscreen app
//     owns the screen, the watchdog claws that band back over a fullscreen
//     game/video every tick — the single most reported desktop-pet annoyance.
//     Electron's BrowserWindow.isFullScreen() only reports OUR OWN windows.
//
//  2. PER-MONITOR DPI. This is the root of the drag drift: the window APIs
//     speak DIP while the compositor works in physical pixels, so a DIP
//     position is converted and rounded per-monitor. GetDpiForWindow tells us
//     the exact factor for the display the pet is on, converting a guess into
//     a measurement. (Verified on the dev machine: 144 = 150% scaling, the
//     exact configuration where the rounding error is largest.)
//
//  3. DWM CLOAK STATE. DWM can "cloak" a window: isVisible() stays true and
//     WS_VISIBLE stays set, but the compositor stops drawing it. Sources are
//     sleep/wake, RDP reconnects, virtual-desktop moves and app suspension.
//     Every JS-visible signal stays green while the pet is invisible, so
//     without this probe "the pet vanished and I had to restart" is
//     undiagnosable. DwmSetWindowAttribute(CLOAK, FALSE) is the direct
//     un-cloak (hide()/show() cycling is NOT reliable for this).
//
// EVERY rung of this module fails open. A probe failure must never make the
// pet worse than the no-FFI behaviour: if koffi or a DLL is unavailable the
// factory returns a stub whose answers are "not fullscreen" / "no drift" /
// "not cloaked", i.e. exactly the pre-existing behaviour. Nothing here ever
// throws into a caller.
//
// koffi ships prebuilt N-API binaries (optionalDependencies per platform, N-API
// 8 → ABI-stable across Electron releases, no node-gyp step). The build's
// `asarUnpack: ["**/*.node", ...]` already unpacks them.

const IS_WIN = process.platform === "win32";

// ── Win32 constants ─────────────────────────────────────────────────────
const MONITOR_DEFAULTTONEAREST = 2;
const GWL_STYLE = -16;
const WS_MAXIMIZE = 0x01000000;
const WS_POPUP = 0x80000000;
const WS_CAPTION = 0x00c00000;

const DWMWA_CLOAK = 13;
const DWMWA_CLOAKED = 14;
const CLOAK_NONE = 0;
const CLOAK_APP = 1;

// Geometry slack: covers the DPI rounding of a flush edge.
const FULLSCREEN_TOLERANCE_PX = 2;

// Shell window classes that geometrically look fullscreen but are the desktop
// or a shell surface, never an app the pet should hide behind. Clicking the
// desktop makes Progman (or an explorer WorkerW sibling) the foreground
// window; Windows 11's XAML islands (Alt-Tab switcher, Task View, snap
// layouts, IME candidates, emoji panel) are borderless popups that also cover
// the monitor. Treating any of them as "fullscreen" made the pet hide at
// random. UWP apps are unaffected by listing CoreWindow — their foreground
// window is the ApplicationFrameWindow host.
const SHELL_WINDOW_CLASSES = new Set([
	"progman",
	"workerw",
	"xamlexplorerhostislandwindow",
	"windows.ui.core.corewindow",
]);

const CLASS_NAME_BUF_LEN = 256;

/**
 * Pure decision core, exported for tests.
 *
 * A window is "fullscreen" for our purposes when it covers the whole MONITOR
 * (not merely the work area) AND is not a maximized normal window.
 *
 * The distinction matters because on a monitor with no taskbar (a secondary
 * display, or one with an auto-hidden taskbar) rcWork == rcMonitor, so a
 * merely-maximized window passes the geometry test. That is why the style bits
 * are consulted too: a maximized normal window carries WS_MAXIMIZE and a
 * caption, a real fullscreen app is usually a captionless popup (a game) or
 * has dropped the maximize bit (a video player's fullscreen).
 */
function classifyFullscreen({ rect, monitorRect, workRect, style, className }) {
	if (!rect || !monitorRect) return false;
	const T = FULLSCREEN_TOLERANCE_PX;
	const coversMonitor =
		rect.x <= monitorRect.x + T &&
		rect.y <= monitorRect.y + T &&
		rect.x + rect.width >= monitorRect.x + monitorRect.width - T &&
		rect.y + rect.height >= monitorRect.y + monitorRect.height - T;
	if (!coversMonitor) return false;

	const cls = typeof className === "string" ? className.toLowerCase() : "";
	if (SHELL_WINDOW_CLASSES.has(cls)) return false;

	if (!Number.isFinite(style)) {
		// No style bits: fall back to geometry alone, but only when the work
		// area genuinely fails to reach the monitor (a taskbar is reserved),
		// which is what separates "fullscreen" from "maximized" there.
		const workReachesMonitor =
			workRect &&
			workRect.x === monitorRect.x &&
			workRect.y === monitorRect.y &&
			workRect.width === monitorRect.width &&
			workRect.height === monitorRect.height;
		return !workReachesMonitor;
	}

	// A maximized normal window: has the maximize bit and a caption. This is
	// the only reliable separation when rcWork == rcMonitor.
	const isMaximizedNormal = (style & WS_MAXIMIZE) !== 0 && (style & WS_CAPTION) !== 0;
	if (isMaximizedNormal) return false;

	// Borderless popups covering the monitor are the classic fullscreen app.
	if ((style & WS_POPUP) !== 0 && (style & WS_CAPTION) === 0) return true;

	// Otherwise: fullscreen if the window is genuinely bigger than the work
	// area on either axis (it overflowed a reserved taskbar strip).
	if (workRect) {
		const widerThanWork = rect.width > workRect.width + T;
		const tallerThanWork = rect.height > workRect.height + T;
		if (widerThanWork || tallerThanWork) return true;
		const workReachesMonitor =
			workRect.x === monitorRect.x &&
			workRect.y === monitorRect.y &&
			workRect.width === monitorRect.width &&
			workRect.height === monitorRect.height;
		// No taskbar strip reserved → geometry cannot separate them → treat as
		// fullscreen only if it dropped the caption.
		return workReachesMonitor && (style & WS_CAPTION) === 0;
	}
	return true;
}

/** Build the no-op module used off Windows or when koffi is unavailable. */
function stubModule(reason) {
	return {
		available: false,
		reason,
		isForegroundFullscreen: () => false,
		dpiForWindow: () => null,
		readCloakState: () => CLOAK_NONE,
		uncloak: () => false,
		dispose: () => {},
	};
}

function createWindowsNative(options = {}) {
	const log = typeof options.log === "function" ? options.log : () => {};
	if (!IS_WIN) return stubModule("not-win32");

	let koffi;
	let user32;
	let dwmapi;
	let ptrSize;
	let api;
	try {
		koffi = require("koffi");
		ptrSize = koffi.sizeof("void *");
		user32 = koffi.load("user32.dll");
		dwmapi = koffi.load("dwmapi.dll");
		api = {
			GetForegroundWindow: user32.func("void* __stdcall GetForegroundWindow(void)"),
			GetWindowRect: user32.func("int __stdcall GetWindowRect(void* hwnd, _Out_ int* rect)"),
			MonitorFromWindow: user32.func("void* __stdcall MonitorFromWindow(void* hwnd, uint flags)"),
			GetMonitorInfoW: user32.func("int __stdcall GetMonitorInfoW(void* hmon, _Inout_ void* mi)"),
			GetWindowLongW: user32.func("long __stdcall GetWindowLongW(void* hwnd, int index)"),
			GetClassNameW: user32.func("int __stdcall GetClassNameW(void* hwnd, _Out_ void* buf, int n)"),
			DwmGetWindowAttribute: dwmapi.func(
				"int __stdcall DwmGetWindowAttribute(void* hwnd, uint attr, _Out_ void* pv, uint cb)",
			),
			DwmSetWindowAttribute: dwmapi.func(
				"int __stdcall DwmSetWindowAttribute(void* hwnd, uint attr, void* pv, uint cb)",
			),
		};
	} catch (err) {
		log(`win32-native init failed (all probes disabled): ${err && err.message}`);
		return stubModule("init-failed");
	}

	// GetDpiForWindow is Win10 1607+; on anything older the lookup fails and we
	// degrade to "no DPI opinion" rather than guessing 96.
	let GetDpiForWindow = null;
	try {
		GetDpiForWindow = user32.func("uint __stdcall GetDpiForWindow(void* hwnd)");
	} catch {
		GetDpiForWindow = null;
	}

	/** Read a 16-byte RECT out of a Buffer as plain ints. */
	function readRect(buf, offset) {
		return {
			x: buf.readInt32LE(offset),
			y: buf.readInt32LE(offset + 4),
			width: buf.readInt32LE(offset + 8) - buf.readInt32LE(offset),
			height: buf.readInt32LE(offset + 12) - buf.readInt32LE(offset + 4),
		};
	}

	function hwndOf(win) {
		try {
			if (!win || typeof win.isDestroyed !== "function" || win.isDestroyed()) return null;
			const buf = win.getNativeWindowHandle();
			if (!buf || buf.length < ptrSize) return null;
			return koffi.decode(buf, "void *");
		} catch {
			return null;
		}
	}

	/** Fullscreen probe for the CURRENT foreground window. Fail-open → false. */
	function isForegroundFullscreen() {
		try {
			const hwnd = api.GetForegroundWindow();
			if (!hwnd) return false;

			const rectBuf = Buffer.alloc(16);
			if (!api.GetWindowRect(hwnd, rectBuf)) return false;
			const rect = readRect(rectBuf, 0);

			const mon = api.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
			// MONITORINFO: cbSize(4) rcMonitor(16) rcWork(16) dwFlags(4) = 40
			const mi = Buffer.alloc(40);
			mi.writeUInt32LE(40, 0);
			if (!api.GetMonitorInfoW(mon, mi)) return false;
			const monitorRect = readRect(mi, 4);
			const workRect = readRect(mi, 20);

			const style = api.GetWindowLongW(hwnd, GWL_STYLE);

			const clsBuf = Buffer.alloc(CLASS_NAME_BUF_LEN * 2);
			let className = "";
			if (api.GetClassNameW(hwnd, clsBuf, CLASS_NAME_BUF_LEN) > 0) {
				className = clsBuf.toString("ucs2");
				const nul = className.indexOf("\0");
				if (nul >= 0) className = className.slice(0, nul);
			}

			return classifyFullscreen({ rect, monitorRect, workRect, style, className });
		} catch (err) {
			log(`win32-native isForegroundFullscreen threw: ${err && err.message}`);
			return false;
		}
	}

	/** Effective DPI for a window (96 = 100%). Null when unavailable. */
	function dpiForWindow(win) {
		if (!GetDpiForWindow) return null;
		const hwnd = hwndOf(win);
		if (!hwnd) return null;
		try {
			const dpi = GetDpiForWindow(hwnd);
			return Number.isFinite(dpi) && dpi > 0 ? dpi : null;
		} catch {
			return null;
		}
	}

	/** DWM cloak flag: 0 none / 1 app / 2 shell / 4 inherited. Fail-open → 0. */
	function readCloakState(win) {
		const hwnd = hwndOf(win);
		if (!hwnd) return CLOAK_NONE;
		try {
			const out = Buffer.alloc(4);
			const hr = api.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out, 4);
			return hr === 0 ? out.readUInt32LE(0) : CLOAK_NONE;
		} catch {
			return CLOAK_NONE;
		}
	}

	/** Clear a self-inflicted (APP) cloak. Returns whether DWM accepted it. */
	function uncloak(win) {
		const hwnd = hwndOf(win);
		if (!hwnd) return false;
		try {
			const f = Buffer.alloc(4); // BOOL FALSE
			return api.DwmSetWindowAttribute(hwnd, DWMWA_CLOAK, f, 4) === 0;
		} catch {
			return false;
		}
	}

	return {
		available: true,
		reason: "ok",
		isForegroundFullscreen,
		dpiForWindow,
		readCloakState,
		uncloak,
		dispose: () => {},
	};
}

module.exports = {
	createWindowsNative,
	classifyFullscreen,
	CLOAK_NONE,
	CLOAK_APP,
	SHELL_WINDOW_CLASSES,
	FULLSCREEN_TOLERANCE_PX,
};
