// Native menu-bar (tray) controller — openchamber tray parity.
//
// Surfaces MusePi's live state in the macOS menu bar (and Windows/Linux
// tray):
//  1. an activity indicator in the icon: idle (π outline), busy (breathing
//     fill animation), unseen (static fill). All monochrome template images
//     — macOS tints them with the menu bar, so light/dark mode needs no
//     variants. EVERY frame is the same 18pt size and NO title is ever set,
//     so the status-item button never resizes and the icons around it stay
//     put (a 36pt unseen frame / approval-count title both measured ~18px
//     of horizontal shove).
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

const { Tray, Menu, nativeImage } = require("electron");

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

// Monochrome π glyph (36×36 physical = 18pt @2x, black on transparent),
// pre-rendered with Pillow (Georgia serif). nativeImage does NOT decode
// SVG data URLs on macOS — the earlier SVG version rendered as a blank
// icon. Frames are derived at runtime by scaling the premultiplied alpha
// channel (the glyph is pure black, so RGB stays constant).
const PI_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAABBUlEQVR4nO2VsWoCQRBAHyoGRMHGRtJIQPAPDChY2vsNfoB9hIBtPsDCL7C2sLKwSyCdiK2NWlhp0hiI4WCE4/CO3LLrWcyDY5i7Ye/dMTsLiqIoiuKUJvAOnIBzzKtuW6YCfBuIOBN6k4X7QAEoS94J1K3k/t7kJZkYtY/AFBhIng1EK8QROgIfvjwl8TcpoW4gz0v0+soal680oSjRqFdcCD1JXHMnQlXgAOzuRegZ+JQtnrhQGmgAMyxjKtSWph5feWb1j0XxCnwBS5nGk5C6uUh5592DS6Gt71zyxGohdS++uiFQijnv/k1PdtUCaEXU5YCRzKcfYCNHjhMpRVEUhRvzB0SWRr2frJYxAAAAAElFTkSuQmCC";

const PI_SCALE_FACTOR = 2;

/** π glyph at the given fill opacity (0..1), as a macOS template image.
 * EVERY frame goes through createFromBitmap(scaleFactor: PI_SCALE_FACTOR)
 * — the raw data-URL image has no scale metadata and would otherwise
 * render as 36pt (the unseen frame used to return it directly, doubling
 * the tray button width and shoving every status item when an approval
 * arrived: 52px vs 34px measured). */
function piImage(fillOpacity, color = [0, 0, 0]) {
	const base = nativeImage.createFromDataURL(`data:image/png;base64,${PI_PNG_BASE64}`);
	// Windows tray draws nativeImage at PHYSICAL pixels — the 36×36 @2x
	// bitmap (18pt DIP, right for the macOS menu bar) is oversized for the
	// tray cell. 20×20 reads clearly at 1.75× DPI while staying inside the
	// 24px tray cell; macOS keeps the @2x path.
	let img = base;
	if (process.platform === "win32") {
		img = base.resize({ width: 20, height: 20 });
	}
	const size = img.getSize();
	const raw = img.toBitmap();
	const buf = Buffer.from(raw);
	// macOS template images tint with the menu bar, so the glyph must stay
	// black. Windows/Linux do NOT tint — a black glyph is invisible on the
	// dark tray, so paint white there (visible on dark AND light taskbars).
	for (let i = 0; i < buf.length; i += 4) {
		buf[i] = color[0];
		buf[i + 1] = color[1];
		buf[i + 2] = color[2];
		if (fillOpacity < 0.999 && process.platform !== "win32") {
			// Windows: the dark taskbar swallows faint glyphs AND partial
			// alpha is unreliable in Shell_NotifyIcon rendering (the old
			// 0.35→0.84 white π never appeared while a fully-opaque test
			// block did). Paint Windows frames fully opaque — the breath
			// animation stays a macOS menu-bar nicety; Windows gets a
			// static, clearly visible π.
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

const IDLE_OPACITY = 0.35;
const UNSEEN_OPACITY = 1.0;
// Eased breathing frames: dense near the extremes (openchamber parity) so
// the fill fades in/out with a calm, continuous glow.
const BREATH_OPACITIES = [0.35, 0.5, 0.72, 0.9, 1.0, 0.9, 0.72, 0.5];

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

	// Windows/Linux tray has no template tinting: white glyph is visible on
	// both dark and light taskbars (black would vanish on the dark tray).
	const TRAY_RGB = process.platform === "win32" ? [255, 255, 255] : [0, 0, 0];
	const idleFrame = piImage(IDLE_OPACITY, TRAY_RGB);
	const unseenFrame = piImage(UNSEEN_OPACITY, TRAY_RGB);
	const breathFrames = BREATH_OPACITIES.map(o => piImage(o, TRAY_RGB));

	const stopAnim = () => {
		if (animTimer) {
			clearInterval(animTimer);
			animTimer = null;
		}
	};

	const startAnim = () => {
		if (animTimer || !tray || tray.isDestroyed?.()) return;
		if (breathFrames.length < 2) return;
		animIndex = 0;
		animDir = 1;
		animTimer = setInterval(() => {
			if (!tray || tray.isDestroyed?.()) return;
			tray.setImage(breathFrames[animIndex] || idleFrame);
			// Ping-pong for a seamless, infinite in-and-out breath.
			animIndex += animDir;
			if (animIndex >= breathFrames.length - 1) {
				animIndex = breathFrames.length - 1;
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
			if (breathFrames.length > 1) startAnim();
			else tray.setImage(breathFrames[0] || idleFrame);
		} else if (nextState === "unseen") {
			stopAnim();
			tray.setImage(unseenFrame);
		} else {
			stopAnim();
			tray.setImage(idleFrame);
		}
	};

	const ensureTray = () => {
		if (tray && !tray.isDestroyed?.()) return tray;
		tray = new Tray(idleFrame);
		tray.setIgnoreDoubleClickEvents(true);
		tray.setToolTip("MusePi");
		// macOS: click opens the menu (default); Linux: left-click shows the
		// main window; Windows: the native Menu is a classic Win32 menu (no
		// acrylic) so the click toggles the self-drawn frosted menu window
		// (main.cjs) instead — the native menu is never set there.
		if (process.platform === "darwin" || process.platform === "win32") {
			// macOS: the click event's `bounds` is NOT provided (unlike
			// Windows) — tray.getBounds() returns the status-item frame on
			// both platforms, so it is the reliable fallback. Without it the
			// menu fell back to the hardcoded screen corner instead of
			// docking to the icon.
			const iconBounds = () => {
				try {
					if (tray && !tray.isDestroyed()) return tray.getBounds();
				} catch {
					// tray gone mid-click; caller falls back to the corner.
				}
				return null;
			};
			tray.on("click", (event) =>
				onAction({ type: "toggle-tray-menu", bounds: event.bounds ?? iconBounds() }),
			);
			tray.on("right-click", (event) =>
				onAction({ type: "toggle-tray-menu", bounds: event.bounds ?? iconBounds() }),
			);
		} else {
			tray.on("click", () => onAction({ type: "show-main-window" }));
		}
		// Windows: blink the π 3× at startup (proma setTrayFlash parity) so
		// the tray entry is discoverable next to the network/volume icons —
		// and as a self-test: blinking proves the icon is rendering, silence
		// means the Tray never reached the shell.
		if (process.platform === "win32") {
			let n = 0;
			const blink = setInterval(() => {
				n += 1;
				if (n >= 6) {
					clearInterval(blink);
					if (tray && !tray.isDestroyed?.()) tray.setImage(idleFrame);
					return;
				}
				tray?.setImage(n % 2 === 0 ? idleFrame : nativeImage.createEmpty());
			}, 400);
		}
		return tray;
	};

	const approvalItem = (approval) => ({
		label: truncate(`${approval.tool}: ${approval.prompt}`, 48),
		submenu: [
			{
				label: "允许一次",
				click: () => onAction({ type: "respond-approval", id: approval.id, approved: true }),
			},
			{
				label: "始终允许",
				click: () => onAction({ type: "respond-approval", id: approval.id, approved: true, remember: true }),
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
		// state (filled π) + the menu's approval section carry the signal.
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
