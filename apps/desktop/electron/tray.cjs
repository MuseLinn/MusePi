// Native menu-bar (tray) controller — openchamber tray parity.
//
// Surfaces MusePi's live state in the macOS menu bar (and Windows/Linux
// tray):
//  1. an activity indicator in the icon: idle (hollow ring), busy (breathing
//     fill animation), unseen (solid fill). macOS uses monochrome template
//     images — the menu bar tints them, so light/dark mode needs no
//     variants there. Windows does NOT tint template images and partial
//     alpha is unreliable in Shell_NotifyIcon, so Windows frames are fully
//     opaque and carry state by SHAPE (hollow idle / solid unseen); the
//     glyph COLOR flips with the taskbar theme (white on the dark
//     taskbar, near-black on the light one — a hardcoded white glyph is
//     invisible on light Windows themes).
//     EVERY frame is the same 18pt size and NO title is ever set, so the
//     status-item button never resizes and the icons around it stay put
//     (a 36pt unseen frame / approval-count title both measured ~18px of
//     horizontal shove).
//  2. pending approvals (permission requests blocking agents) with inline
//     Allow/Deny actions;
//  3. the recent session list (title + relative time, paused marker), click
//     to focus that session in the main window;
//  4. usage summary (tokens + cost + top models);
//  5. quick actions: New Session, Show MusePi, Quit.
//
// State is polled from the daemon in main.cjs (one `tray.state` RPC per
// poll); this module owns only presentation. Tray clicks call back through
// `onAction`, which main.cjs routes to the renderer (focus session,
// respond approval, new session) or handles natively (show window, quit).
// Menu labels are Chinese, matching the pet context menu convention.
"use strict";

const childProcess = require("child_process");
const { Tray, Menu, nativeImage, nativeTheme } = require("electron");

const MAX_SESSIONS = 8;
const MAX_APPROVALS = 10;
// Busy "breathing" animation cadence (eased frame set, slower tick reads as
// a calm glow rather than a blink).
const ANIM_INTERVAL_MS = 75;

/** Left-truncate long text so the menu stays readable. */
function truncate(value, max) {
	const s = String(value ?? "");
	if (s.length <= max) return s;
	return `…${s.slice(s.length - max + 1)}`;
}

/** Relative time label for the menu (same compact style as the GUI list). */
function timeLabel(iso) {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	const diff = Date.now() - d.getTime();
	if (diff < 60_000) return "刚刚";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`;
	return `${d.getMonth() + 1}/${d.getDate()}`;
}

// Monochrome brand-orb frames (36×36 physical = 18pt @2x, black on
// transparent). The shape is the brand master — sphere, headband, ear cups,
// eyes and smile — so the tray carries the same identity as the app icon
// rather than an earlier featureless sphere.
//
// Two states, distinguished by SHAPE because Windows cannot rely on partial
// alpha:
//   solid  (unseen / busy) — filled ball, face knocked out
//   hollow (idle)          — the orb as line art
//
// nativeImage does NOT decode SVG data URLs on macOS — the earlier SVG
// version rendered as a blank icon — so these ship as PNG data URLs. Frames
// are recolored at runtime by rewriting RGB, which means every detail must
// live in the ALPHA channel: markImage() flattens colour, so a face drawn
// in a second colour would vanish. Both frames therefore carry their detail
// as holes in a single-channel mask.
const TRAY_GLYPH_SOLID_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAAEP0lEQVR4nLWY26sVdRTHP7P3Ph7JJEkrybKXMkODgqis8CHLSLtJ9SQVpEgo0VOBPQU9BPXgH5D1ZA9dULo8CEaIpUVhRRe7GZ2E9KRiUWFZ5+yJdfiuw/LH/GZmb3TB3rP3zPqt9f2t+2+K+fMXUEEF0AEm9f8a4H7gbmAxMEM8TiXwN/AVsEOf7/SsJznG00hFBSAD0tfvm4AngTuBUdrTX8B24AWBTOVmyZgidbXoPOBFYC9wn8BMthDYF9+5wMPAfuA5Wakv+a0t1JWwJcDrwFUycytBCZWSZUDQxh4EjgQ9tRZyphuA9wTmP8XJoGCmNiowpeTcDOwGLpeeTh0gD15jfgu4EJgARoYAUgVsRKAWSf7coLsSUKEY2R7AuKnPFDkos/wrCoOYpdPk1nkGuFqLei1igyF4HNQdwEbxdKuC2lB/LiBFDnlCnm3ZWMgkhK/7QyFyIvBOC3xWha6sAVPq+ivwUYg9T/PI8yfwfkiIyONr5gCbtOY0KxnDmqoHGYvsB5YphfdqfTcBNAYsB24HdiU8rtN41wPnpPHkO21yU6nrD7q+AdwCrAR2Av8G0D9K3rt6HnnKAOhSdYJ+wDH1tSuxQh19r+uodm1rHwk1y0GXGR7kvkIV/BCwQLr7DsgaJw1W6uj6ra4TIQEeB2YFhQcSxZHHi2Iht+8Rv4XCCrtvDy9oAFSG8mDx4TQpJY/qvxfSgzU8MTwsyy4CZgPXAjeaLvdnGzoCHA6CS+3yYlnM3PNPAF0kPLmWYXwvA8/bc689ddSXsjEpdGt15Iq4ocMCTg2P/z4GvKR2YqVkinryfV3fKhNXGO8p4FaZOqbtmIB4VY48nvr++2Pg6WDx6aD2HTW57kDy/4lQjX3tN0FBypNu8BcZZDQ+7wRFubQvdP1JO7OdXwms0v3Y+3I8VUX3S8XeaX2vozklR2Uo//vC1PhYMiu7RT4IPJsCT4xTB/dhlSGsuV4BfBFm5nR4LxQzrwEzgYUa5LzCRl6bNI3mqQrPTHqkx5vVs6XBfWU6wr4N3JUbCRL6RNl0bxjobYZuQz5rPaUDQE/3psl3aDWgKbBPafEeHYmuU3HbrOeT+nhcpLLcosdUd4qqucks5PP0NmBtw8RYStAhWdXcd70mzaZ65uVlnQB1c4DcSucDn6oL17mu3zCY1YF5R4fN7MkjHt6OAw8AJxuOKh2tybkmB+Zr4KHQdrLC0+q5WoHq9aTMrOuJp64p++nFTq+3Ab8HfbWACG7arYnPCuaIFE4M0ITden42e1Pyxtscp9NYcFCfaRzYoknPm7Arc3fFzJpIrDeu04UdxX9re7avetlAsngpsAG4B7ishYWsyL4KbAWOhpgZ+u1H7pXMLFnN0tyq+yVhBvpZjXWfMtWV157jBwXk5FPeIIIHeieULmyifmKxouJ+vOfZNRQNcoYvBzX/MDRoxT3r9D9BjEtE/pS/TwAAAABJRU5ErkJggg==";
const TRAY_GLYPH_HOLLOW_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAAFQUlEQVR4nMWYeYzdUxTHP7/fezPTNJGKP7RmiLHUVGspYgkVRCkSqQQl4g9iS/APUSmJLbZE7UtSNLZqFEmlDZoi0jJqtLHvWyJojVijtunMvJ8c+Z7mvPt+73WeECd57/d79557z/ee/b5s0qQeSigDcmBUv6cDJwLHA31AR8maIeA94Cl9PtZ4VfsUZYIaBJcAMiA1vR8MzAWOAcYxdtooUPMFMt13zIAqOs0E4Gbg7JI1fwJfA98Aw8B4YDtge62PtAm4FbgCGAn7jwmQM08DngR21++KzLFUn3XAeglwMu3tBBwKzAGO1LivfwU4WYdoCcoBOdOBwHJgW6k3BxYBNwAfJWttDvlG6h9HANcIoGmpE/gUOA74rJX5DJBP7qqTGBij74Fz5QsOOgIokiDwQKgFYZcB18u0nTrUDOAnzTeAyrVRl8zhmhkEDheYaoi4Uc2nGik0PqJnRWtuBE5TVJrZpwCLxWNyG8gFXQ3sqZP8BhwNvK+NXIhrInXcBq0HkKaVJcCZOrQFxCzg/OBfDSYz531Lk/Y5FXhcYIabCHX/aRXGbsJc+9wTgGyUi/wYwG/e+FqdxMA8LTDVBEym50TgoOAneTil82wlZy6Cie1wlyo6jW9r4ELx1GnJNjwh+MBVWlA00ch+wKtKC4dozWgCqBd4CXgeOErz7grztZftf5ZyWJ0/+QltYDXwht7TPJHpaWo2OgnoB55TFu8MoHeRwJmat8+x4nlEZrL9dlAlcE3/vd6+Vmijx+JEE9pNzyGBNg08LJO4VidLYOR5SMnTwn2l+K4DvgR6Yqow4fuKob9JSEfntQBAPua56C6ZwwvuVD0rgedO4BeNmyVcy2baD4DXld2zXI5aqOZMKMkRWcgt5h9OFQF5QL+HE7NGHtMiKi8XSN4UybYg2EfBUriDIV+YXeb5Iiug3Xp30ObcG0KLMS6ALgKPFWOjM5Tvoo9mOtRNZrGqBn6V6p8pcepcv3sl0LVV05qozW4BJ+Hxfe5TNTgP+A5YqNo5EIWNqG5dDvwQThdPEE0xrHWrgDeTNNErICmPl6j1Kif2/ppkDsRAspdv5endzepL4qxOd4Rs7OvML2IQRB70vpfev5Kpu2LGz1U2OkL+SMO+CA45Kl5rT5/VeOyLdm7B46Ad0Nsar8t5JvxFvc8Mp3DKtCBXEvMqvkCn8oToJ5wReO4OXaJrrVCSJPhNLS2uppkPFQl94cQeJYXUOkfV2lqTlxMtOnjrCpFPrhF/7JP61GN/AuwRtL/ZZ82Gn0u1syV0scYNmDMOqXNELe4CRc9ERcu7EvxECdB4sEuksfsF0OXUaQiZo1/t5XQBSLN2l8y3SC2K0wq1ptVEuK/39nhvRdbPOlRD6xGL6xoJmqzbhm3gOcppk8bn6haxUqZ7QfPeUbqjeoC4yRfqOU/pJSblOg15VG0DrFU0XQTcLlCxR26HPDEWcgNrZZep3Wl684gRYo54irq524CLQ/satZWF32UtbR5KSYc0b2DeUeko1UxcTCgH63Rdtsp8izbrDg7uba6bw/2lEi4D3uzvr2p+unLOLPmPy2sJiNB0r9aNw8LTN5unGhV9xNtT7xpdm9PUP6/VPW+p7mmDY7lOl93t3b7WFlwp09lGv8uRV+lGskEgrA3tUV9lyfUw7TOo28y9Je7RFqB08VTgHCW9UuaELCc9CjyoHOU+84///Wj2l8x4+cUByrg7av4P4AtpbUDV3WmLfy60A8jJnbedjdv6TyhduCWq6Zm2GnE8jhVpOfi3ASHyi99/Sq2uPP8L/QVi95NHRhTqZAAAAABJRU5ErkJggg==";

/** Orb frame at the given fill opacity (0..1) in the given RGB. EVERY frame
 * goes through createFromBitmap from the same base geometry so all frames
 * render at the identical size — returning the raw data-URL image instead
 * renders at 36pt on macOS (the unseen frame used to do exactly that,
 * doubling the tray button width and shoving every status item: 52px vs
 * 34px measured). Windows tray draws at PHYSICAL pixels, so the 36×36 @2x
 * bitmap (18pt DIP, right for the macOS menu bar) is resized to 20×20
 * there — reads clearly at 1.75× DPI while staying inside the 24px cell. */
function markImage({ glyph, color = [0, 0, 0], fillOpacity = 1 }) {
	const base = nativeImage.createFromDataURL(`data:image/png;base64,${glyph}`);
	let img = base;
	if (process.platform === "win32") {
		img = base.resize({ width: 20, height: 20 });
	}
	const size = img.getSize();
	const raw = img.toBitmap();
	const buf = Buffer.from(raw);
	for (let i = 0; i < buf.length; i += 4) {
		buf[i] = color[0];
		buf[i + 1] = color[1];
		buf[i + 2] = color[2];
		if (fillOpacity < 0.999 && process.platform !== "win32") {
			buf[i + 3] = Math.min(255, Math.round(buf[i + 3] * fillOpacity));
		}
	}
	const created = nativeImage.createFromBitmap(buf, size);
	return process.platform === "win32" ? created : withTemplate(created);
}

function withTemplate(img) {
	img.setTemplateImage(true);
	return img;
}

// Windows taskbar color follows the "Windows mode" personalization setting
// (SystemUsesLightTheme), NOT the app mode behind nativeTheme
// .shouldUseDarkColors — a hardcoded white glyph vanished on light
// taskbars. Read the registry directly; fall back to nativeTheme (close
// enough on old Win10 builds without the key).
const TASKBAR_THEME_REG = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize";
const LIGHT_TASKBAR_RGB = [24, 24, 27];
const DARK_TASKBAR_RGB = [255, 255, 255];

/** true = light taskbar, false = dark taskbar, null = unknown. */
function windowsTaskbarPrefersLight() {
	try {
		const out = childProcess.execFileSync("reg", ["query", TASKBAR_THEME_REG, "/v", "SystemUsesLightTheme"], {
			timeout: 1500,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return /SystemUsesLightTheme\s+REG_DWORD\s+0x1/.test(String(out));
	} catch {
		return null;
	}
}

/** Glyph color for the Windows tray, from the live taskbar theme. */
function windowsTrayRgb() {
	const light = windowsTaskbarPrefersLight();
	if (light === null) return nativeTheme.shouldUseDarkColors ? DARK_TASKBAR_RGB : LIGHT_TASKBAR_RGB;
	return light ? LIGHT_TASKBAR_RGB : DARK_TASKBAR_RGB;
}

// Opacity states on the macOS menu bar (template images tint with the bar,
// so only alpha varies). Eased breathing frames: dense near the extremes
// (openchamber parity) so the fill fades in/out with a calm glow.
const IDLE_OPACITY = 0.35;
const UNSEEN_OPACITY = 1.0;
const BREATH_OPACITIES = [0.35, 0.5, 0.72, 0.9, 1.0, 0.9, 0.72, 0.5];

/** Frame set for one tray color. macOS keeps template images (opacity
 * carries the state). Windows does NOT tint and partial alpha never showed
 * up reliably in Shell_NotifyIcon (the old 0.35→0.84 white glyph was invisible
 * while a fully-opaque test block appeared), so Windows frames are fully
 * opaque and the state is carried by SHAPE: idle = hollow outline,
 * unseen/busy = solid. */
function buildFrameSet(color) {
	if (process.platform === "win32") {
		const solid = markImage({ glyph: TRAY_GLYPH_SOLID_B64, color });
		return {
			idle: markImage({ glyph: TRAY_GLYPH_HOLLOW_B64, color }),
			unseen: solid,
			breath: [solid],
		};
	}
	return {
		idle: markImage({ glyph: TRAY_GLYPH_SOLID_B64, color, fillOpacity: IDLE_OPACITY }),
		unseen: markImage({ glyph: TRAY_GLYPH_SOLID_B64, color, fillOpacity: UNSEEN_OPACITY }),
		breath: BREATH_OPACITIES.map(o => markImage({ glyph: TRAY_GLYPH_SOLID_B64, color, fillOpacity: o })),
	};
}

/**
 * Create the tray controller. `update(snapshot)` takes
 * `{ sessions, activeCount, approvals, usage }` from the daemon;
 * `onAction` receives `{ type }` where type is one of "focus-session"
 * (sessionId set), "respond-approval" (id + approved), "new-session",
 * "show-main-window", "quit".
 */
function createTrayController({ onAction, onSnapshot }) {
	let tray = null;
	let lastKey = null;
	let iconState = null;
	let animTimer = null;
	let animIndex = 0;
	let animDir = 1;
	let themeTimer = null;

	// macOS template images ignore the glyph color (the menu bar tints
	// them); Windows picks white/black from the live taskbar theme.
	const initialRgb = process.platform === "win32" ? windowsTrayRgb() : [0, 0, 0];
	let frameRgb = initialRgb;
	let frames = buildFrameSet(initialRgb);

	const stopAnim = () => {
		if (animTimer) {
			clearInterval(animTimer);
			animTimer = null;
		}
	};

	const startAnim = () => {
		if (animTimer || !tray || tray.isDestroyed?.()) return;
		if (frames.breath.length < 2) return;
		animIndex = 0;
		animDir = 1;
		animTimer = setInterval(() => {
			if (!tray || tray.isDestroyed?.()) return;
			tray.setImage(frames.breath[animIndex] || frames.idle);
			// Ping-pong for a seamless, infinite in-and-out breath.
			animIndex += animDir;
			if (animIndex >= frames.breath.length - 1) {
				animIndex = frames.breath.length - 1;
				animDir = -1;
			} else if (animIndex <= 0) {
				animIndex = 0;
				animDir = 1;
			}
		}, ANIM_INTERVAL_MS);
	};

	const applyIconState = (nextState) => {
		if (nextState === iconState) return;
		iconState = nextState;
		if (!tray || tray.isDestroyed?.()) return;
		if (nextState === "busy") {
			if (frames.breath.length > 1) startAnim();
			else tray.setImage(frames.breath[0] || frames.idle);
		} else if (nextState === "unseen") {
			stopAnim();
			tray.setImage(frames.unseen);
		} else {
			stopAnim();
			tray.setImage(frames.idle);
		}
	};

	// Rebuild the Windows frames when the taskbar flips between light and
	// dark, then re-apply the current state against the new frames.
	const refreshThemeFrames = () => {
		if (process.platform !== "win32") return;
		const rgb = windowsTrayRgb();
		if (rgb[0] === frameRgb[0] && rgb[1] === frameRgb[1] && rgb[2] === frameRgb[2]) return;
		frameRgb = rgb;
		frames = buildFrameSet(rgb);
		if (animTimer) {
			stopAnim();
			if (iconState === "busy") startAnim();
		}
		const state = iconState;
		iconState = null; // force applyIconState past its early return
		if (state) applyIconState(state);
	};

	const ensureTray = () => {
		if (tray && !tray.isDestroyed?.()) return tray;
		tray = new Tray(frames.idle);
		tray.setToolTip("MusePi");
		// macOS: click opens the menu (default); Linux: left-click shows the
		// main window; Windows: left-click / double-click shows the main
		// window, right-click toggles the self-drawn frosted menu window.
		if (process.platform === "darwin") {
			tray.setIgnoreDoubleClickEvents(true);
			// macOS: the click event's `bounds` is NOT provided (unlike
			// Windows) — tray.getBounds() returns the status-item frame on
			// both platforms, so it is the reliable fallback. The click point
			// rides along too: it picks the display the icon was clicked on
			// (tray bounds can describe the primary display's menu bar).
			const iconBounds = () => {
				try {
					if (tray && !tray.isDestroyed()) return tray.getBounds();
				} catch {
					// tray gone mid-click; the pointer still anchors the menu.
				}
				return null;
			};
			tray.on("click", (event, _bounds, position) =>
				onAction({ type: "toggle-tray-menu", bounds: event.bounds ?? iconBounds(), point: position }),
			);
			tray.on("right-click", (event, _bounds, position) =>
				onAction({ type: "toggle-tray-menu", bounds: event.bounds ?? iconBounds(), point: position }),
			);
		} else if (process.platform === "win32") {
			tray.setIgnoreDoubleClickEvents(false);
			const iconBounds = () => {
				try {
					if (tray && !tray.isDestroyed()) return tray.getBounds();
				} catch {}
				return null;
			};
			tray.on("click", () => onAction({ type: "show-main-window" }));
			tray.on("double-click", () => onAction({ type: "show-main-window" }));
			tray.on("right-click", (event, _bounds, position) =>
				onAction({ type: "toggle-tray-menu", bounds: event.bounds ?? iconBounds(), point: position }),
			);
		} else {
			tray.setIgnoreDoubleClickEvents(true);
			tray.on("click", () => onAction({ type: "show-main-window" }));
		}
		// Windows: blink the tray glyph 3× at startup (proma setTrayFlash parity) so
		// the tray entry is discoverable next to the network/volume icons —
		// and as a self-test: blinking proves the icon is rendering, silence
		// means the Tray never reached the shell.
		if (process.platform === "win32") {
			let n = 0;
			const blink = setInterval(() => {
				n += 1;
				if (n >= 6) {
					clearInterval(blink);
					if (tray && !tray.isDestroyed?.()) tray.setImage(frames.idle);
					return;
				}
				tray?.setImage(n % 2 === 0 ? frames.idle : nativeImage.createEmpty());
			}, 400);
		}
		return tray;
	};

	// Windows: watch theme flips. nativeTheme "updated" fires when the
	// Personalize registry key changes (Electron observes the key, so a
	// SystemUsesLightTheme flip triggers it even though shouldUseDarkColors
	// tracks the app mode); the slow interval is a safety net for changes
	// the watcher can miss (e.g. while the machine was suspended).
	if (process.platform === "win32") {
		nativeTheme.on("updated", refreshThemeFrames);
		themeTimer = setInterval(refreshThemeFrames, 60_000);
		themeTimer.unref?.();
	}

	const approvalItem = (approval) => ({
		label: truncate(`${approval.tool}: ${approval.prompt}`, 48),
		submenu: [
			{
				label: "允许一次",
				click: () => onAction({ type: "respond-approval", id: approval.id, approved: true }),
			},
			{
				label: "始终允许",
				click: () =>
					onAction({
						type: "respond-approval",
						id: approval.id,
						approved: true,
						remember: true,
						// Policy key for the persisted rule (main.cjs).
						tool: approval.tool,
					}),
			},
			{ type: "separator" },
			{
				label: "拒绝",
				click: () => onAction({ type: "respond-approval", id: approval.id, approved: false }),
			},
			{ type: "separator" },
			{
				label: "在应用中打开",
				click: () => onAction({ type: "focus-session", sessionId: approval.sessionId }),
			},
		],
	});

	const sessionItem = (session, overflow) => {
		const title = truncate(session.title || "未命名会话", overflow ? 36 : 40);
		const time = timeLabel(session.timestamp);
		return {
			label: time ? `${title}  ${time}` : title,
			...(session.paused ? { sublabel: "已暂停" } : {}),
			click: () => onAction({ type: "focus-session", sessionId: session.id }),
		};
	};

	const buildMenu = (snapshot) => {
		const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
		const approvals = Array.isArray(snapshot.approvals) ? snapshot.approvals : [];
		const usage = snapshot.usage && typeof snapshot.usage === "object" ? snapshot.usage : null;

		const template = [
			{ label: "MusePi", enabled: false },
			{ type: "separator" },
		];

		if (approvals.length > 0) {
			template.push({ label: "需要你的关注", enabled: false });
			for (const approval of approvals.slice(0, MAX_APPROVALS)) {
				template.push(approvalItem(approval));
			}
			const overflow = approvals.slice(MAX_APPROVALS);
			if (overflow.length > 0) {
				template.push({ label: `${overflow.length} 更多…`, submenu: overflow.map(approvalItem) });
			}
			template.push({ type: "separator" });
		}

		if (sessions.length > 0) {
			template.push({ label: "会话", enabled: false });
			for (const session of sessions.slice(0, MAX_SESSIONS)) {
				template.push(sessionItem(session, false));
			}
			const overflow = sessions.slice(MAX_SESSIONS);
			if (overflow.length > 0) {
				template.push({
					label: `${overflow.length} 更多…`,
					submenu: overflow.map(session => sessionItem(session, true)),
				});
			}
		} else {
			template.push({ label: "暂无会话", enabled: false });
		}

		if (usage) {
			const cost = Number.isFinite(usage.totalCost) ? usage.totalCost : 0;
			const tokens = Number.isFinite(usage.totalTokens) ? usage.totalTokens : 0;
			const usageSubmenu = [
				{ label: `Token 总量: ${formatTokens(tokens)}`, enabled: false },
				{ label: `费用: $${cost.toFixed(4)}`, enabled: false },
			];
			// /usage-style subscription summary (planType per reporting
			// account) — only when the daemon could fetch report metadata.
			const plans = Array.isArray(usage.plans) ? usage.plans : [];
			if (plans.length > 0) {
				usageSubmenu.push({ type: "separator" });
				for (const p of plans) {
					usageSubmenu.push({
						label: `    ${truncate(p.provider, 16)} — ${truncate(p.label, 24)}`,
						enabled: false,
					});
				}
			}
			const models = Array.isArray(usage.topModels) ? usage.topModels : [];
			if (models.length > 0) {
				usageSubmenu.push({ type: "separator" });
				for (const m of models) {
					usageSubmenu.push({
						label: `    ${truncate(m.name, 30)}  —  $${(Number.isFinite(m.cost) ? m.cost : 0).toFixed(4)}`,
						enabled: false,
					});
				}
			}
			template.push({ type: "separator" }, { label: "用量", submenu: usageSubmenu });
		}

		template.push(
			{ type: "separator" },
			{ label: "新建会话", click: () => onAction({ type: "new-session" }) },
			{ label: "迷你对话", click: () => onAction({ type: "mini-chat" }) },
			{ label: "显示 MusePi", click: () => onAction({ type: "show-main-window" }) },
			{ type: "separator" },
			{ label: "退出 MusePi", click: () => onAction({ type: "quit" }) },
		);
		return Menu.buildFromTemplate(template);
	};

	/** Cheap signature of menu-affecting content — avoids rebuilds per poll. */
	const menuKey = (snapshot) =>
		JSON.stringify({
			s: (snapshot.sessions ?? []).map(s => `${s.id}|${s.title}|${s.paused ? 1 : 0}|${s.timestamp}`),
			a: (snapshot.approvals ?? []).map(a => `${a.id}|${a.sessionId}|${a.tool}|${a.prompt}`),
			u: snapshot.usage ? `${snapshot.usage.totalTokens}|${snapshot.usage.totalCost}` : "",
		});

	const update = (rawSnapshot) => {
		const snapshot = rawSnapshot && typeof rawSnapshot === "object" ? rawSnapshot : {};
		const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
		const approvals = Array.isArray(snapshot.approvals) ? snapshot.approvals : [];
		const activeCount = Number.isFinite(snapshot.activeCount) ? snapshot.activeCount : 0;

		const widget = ensureTray();
		const counts = {
			busy: activeCount,
			approvals: approvals.length,
		};
		// NO setTitle: a variable-width title (approval count) resizes the
		// status-item button and shoves every icon left of it. The unseen
		// state (solid sphere / badge shape) + the menu's approval section carry
		// the signal.
		applyIconState(counts.busy > 0 ? "busy" : counts.approvals > 0 ? "unseen" : "idle");
		if (process.platform === "win32" || process.platform === "darwin") {
			// Self-drawn frosted menu window renders the snapshot (the
			// native Menu would be a classic Win32 menu — no acrylic).
			// macOS: 统一用自绘 frosted 菜单(2026-08-17,用户要求与
			// Windows 新写菜单一致),native Menu 不再构建。
			onSnapshot?.(snapshot);
			return;
		}
		const key = menuKey(snapshot);
		if (key !== lastKey) {
			widget.setContextMenu(buildMenu(snapshot));
			lastKey = key;
		}
	};

	const destroy = () => {
		stopAnim();
		if (themeTimer) {
			clearInterval(themeTimer);
			themeTimer = null;
		}
		if (process.platform === "win32") nativeTheme.removeListener("updated", refreshThemeFrames);
		if (tray && !tray.isDestroyed?.()) tray.destroy();
		tray = null;
		lastKey = null;
		iconState = null;
	};

	return { update, destroy };
}

/** Compact token count (K/M suffixes — en-US style, matching the GUI). */
function formatTokens(n) {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

module.exports = { createTrayController };
