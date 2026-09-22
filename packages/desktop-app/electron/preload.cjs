/**
 * Electron preload — exposes the daemon lifecycle bridge to the sandboxed
 * renderer as `window.electronAPI` (the renderer checks for it to decide
 * it is running inside the desktop shell, replacing the old isTauri()).
 */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
	/** Node platform of the desktop shell ("darwin" | "win32" | "linux") —
	 *  gates macOS-only features (haptics, native window glass). */
	platform: process.platform,
	/** Port of a running daemon (ws.port file), or null. */
	probeDaemonPort: () => ipcRenderer.invoke("daemon-probe"),
	/** GUI package version (OTA/发布一致性比对,见 app.tsx boot)。 */
	getAppVersion: () => ipcRenderer.invoke("app-version"),
	/** Spawn `musepi serve --port` and resolve once the listener is up. */
	startDaemon: (port) => ipcRenderer.invoke("daemon-start", port),
	/** Restart the daemon: kill the current listener, spawn fresh code,
	 *  resolve once the new listener is up (instance menu 重启 daemon). */
	restartDaemon: (port) => ipcRenderer.invoke("daemon-restart", port),
	/** Relocate the app data root (设置 → 常规 → 数据存储路径): picks a
	 *  parent folder, copies the current root into `<picked>/.musepi`,
	 *  persists the override, respawns the daemon with PI_CONFIG_DIR.
	 *  Resolves { ok:true, root } or { ok:false, error }. */
	dataRootApply: (picked) => ipcRenderer.invoke("data-root-apply", picked),
	/** Native folder picker (ZCode "打开文件夹"); resolves the path or null. */
	openDirectory: () => ipcRenderer.invoke("dialog-open-directory"),
	/** Reveal a directory in the OS file manager (路径来自 daemon 报告)。 */
	openPath: (dirPath) => ipcRenderer.invoke("shell-open-path", dirPath),
	/** Clipboard write (openchamber copy-path action). */
	copyText: (text) => ipcRenderer.invoke("clipboard-write", text),
	/** Open a picture-in-picture mini chat window. */
	openMiniChat: () => ipcRenderer.invoke("mini-chat-open"),
	/** Open a directory in a specific app (openchamber open-in). */
	openWith: (app, path) => ipcRenderer.invoke("open-with", { app, path }),
	/** Installed apps for the open-in capsule, with real icons. */
	listOpenInApps: () => ipcRenderer.invoke("open-in-apps"),
	/** Open a URL in the default browser (project-actions preview). */
	openExternal: (url) => ipcRenderer.invoke("open-external", url),
	/** Tree-sitter syntax highlight (main-process natives); ANSI lines or null. */
	highlightCode: (code, lang, colors) => ipcRenderer.invoke("gui-highlight", code, lang, colors),
	/** Local image file → data URL (markdown ![](/abs/path)); { dataUrl } or { error }. */
	readFileDataUrl: (filePath) => ipcRenderer.invoke("gui-read-file-data-url", filePath),
	/** System notification (main-process Notification — the renderer HTML5
	 *  API does not surface on macOS). Resolves { ok } or { ok:false }. */
	showNotification: (title, body) => ipcRenderer.invoke("notification-show", { title, body }),
	/** Main-process delivery failure (macOS unsigned apps). { reason } */
	onNotificationFailed: (cb) => {
		const listener = (_e, detail) => cb(detail);
		ipcRenderer.on("notification-failed", listener);
		return () => ipcRenderer.removeListener("notification-failed", listener);
	},
	/** Window glass on/off (true = native vibrancy, false = opaque); style is
	 *  "light" | "dark" and selects the bright/dim material + opaque base. */
	setWindowGlass: (enabled, style) => ipcRenderer.invoke("gui-vibrancy", enabled, style),
	/** Haptic tap (macOS Taptic Engine) — pattern 0 generic / 1 alignment /
	 *  2 level-change; no-op on platforms without a haptic device. */
	haptic: (pattern) => ipcRenderer.invoke("haptic", pattern),
	/** OTA: check for updates (electron-updater; null result = disabled). */
	checkUpdates: () => ipcRenderer.invoke("updater-check"),
	/** OTA: current updater state (idle/checking/preparing/downloading/downloaded/error). */
	getUpdateState: () => ipcRenderer.invoke("updater-state"),
	/** OTA: download the detected update (progress via onUpdateState). */
	downloadUpdate: () => ipcRenderer.invoke("updater-download"),
	/**
	 * Manual install fallback: download the release installer (dmg on macOS,
	 * exe on Windows) into Downloads and open it. Used when the running build
	 * cannot OTA (ad-hoc signed macOS app).
	 */
	downloadInstaller: (url) => ipcRenderer.invoke("updater-download-installer", url),
	/** Whether this build can install an update through electron-updater at all. */
	updaterOtaCapable: () => ipcRenderer.invoke("updater-ota-capable"),
	/** OTA: release notes from update-manifest.json (main-process fetch, cached). */
	getUpdateNotes: () => ipcRenderer.invoke("updater-notes"),
	/** OTA: kill daemon + quitAndInstall (restart into the new version). */
	installUpdate: () => ipcRenderer.invoke("updater-install"),
	/** OTA: listen for an auto-checked update notice. */
	onUpdateAvailable: (cb) => {
		const listener = (_e, result) => cb(result);
		ipcRenderer.on("update-available", listener);
		return () => ipcRenderer.removeListener("update-available", listener);
	},
	/** OTA: live updater state pushes (checking/downloading/downloaded/error). */
	onUpdateState: (cb) => {
		const listener = (_e, state) => cb(state);
		ipcRenderer.on("updater-state", listener);
		return () => ipcRenderer.removeListener("updater-state", listener);
	},
	/** Agent companion pet window (伙伴): show/hide the floating pet. */
	setPetVisible: (visible) => ipcRenderer.invoke("pet-toggle", visible),
	/** Pet window drag: window-relative client coords + the window's
	 *  on-screen position (screenX/Y — the renderer is the DIP ground
	 *  truth the main process calibrates the drag spaces against). */
	movePetWindowByClient: (clientX, clientY, screenX, screenY) =>
		ipcRenderer.invoke("pet-drag-client", { clientX, clientY, screenX, screenY }),
	/** Pointer down on the pet: keep the window interactive until the drag
	 *  ends (click-through poll must not flip ignore mid-gesture). */
	petDragArm: () => ipcRenderer.invoke("pet-drag-arm"),
	/** Drag finished (resets the main-process delta tracker). */
	petDragEnd: () => ipcRenderer.invoke("pet-drag-end"),
	/** Pet window click → focus the main window. */
	focusMainWindow: () => ipcRenderer.invoke("pet-click"),
	/** Pet right-click → native context menu (main process). */
	petContextMenu: () => ipcRenderer.invoke("pet-context-menu"),
	/** Pet window: sprite-only rect (dock alignment uses the character
	 *  edge, not the larger window). */
	setPetRect: (rect) => ipcRenderer.invoke("pet-set-rect", rect),
	/** Computer-use overlay glow: ring the displays while the agent
	 *  drives the desktop (`computer` tool running). */
	computerGlow: (on) => ipcRenderer.invoke("computer-glow", Boolean(on)),
	/** Computer-use overlay target: highlight one desktop input action
	 *  (window/element frame + action point) on the glow overlay. */
	glowTarget: (event) => ipcRenderer.invoke("glow-target", event),
	/** Pet panel recent-session click → open the session in the main window. */
	petOpenSession: (sessionId) => ipcRenderer.invoke("pet-open-session", sessionId),
	/** Pet bubble × → mark that session read in the main window (it owns
	 *  the unread badge set — dismissing the notification must clear it). */
	petMarkRead: (sessionId) => ipcRenderer.invoke("pet-mark-read", sessionId),
	/** Pet badge click → mark every session read (badge + pet bubbles). */
	petMarkAllRead: () => ipcRenderer.invoke("pet-mark-all-read"),
	/** Pet bubble ■ → abort that (background) working session. */
	petStopSession: (sessionId) => ipcRenderer.invoke("pet-stop-session", sessionId),
	/** Main window: pet asked to open a session. */
	onPetOpenSession: (cb) => {
		const listener = (_e, sessionId) => cb(sessionId);
		ipcRenderer.on("pet:open-session", listener);
		return () => ipcRenderer.removeListener("pet:open-session", listener);
	},
	/** Main window: menu-bar tray session click → open that session. */
	onTrayOpenSession: (cb) => {
		const listener = (_e, sessionId) => cb(sessionId);
		ipcRenderer.on("tray:open-session", listener);
		return () => ipcRenderer.removeListener("tray:open-session", listener);
	},
	/** Main window: menu-bar tray "New Session" → create one. */
	onTrayNewSession: (cb) => {
		const listener = () => cb();
		ipcRenderer.on("tray:new-session", listener);
		return () => ipcRenderer.removeListener("tray:new-session", listener);
	},
	/** Report the interactive rect (pet + bubble, window-relative) that
	 *  drives the main-process click-through cursor poll. */
	setPetHitbox: (rect) => ipcRenderer.invoke("pet-set-hitbox", rect),
	/** Main-window renderer → pet window activity (mood/bubble). */
	petActivity: (payload) => ipcRenderer.invoke("pet-activity", payload),
	/** Pet window: subscribe to activity pushed from the main window. */
	onPetActivity: (cb) => {
		const listener = (_e, payload) => cb(payload);
		ipcRenderer.on("pet:activity", listener);
		return () => ipcRenderer.removeListener("pet:activity", listener);
	},
	/** Pet window: ask the main window for a fresh state snapshot. */
	requestPetState: () => ipcRenderer.invoke("pet-request-state"),
	/** Pet window: main-window state snapshot requested. */
	onPetStateRequest: (cb) => {
		const listener = () => cb();
		ipcRenderer.on("pet:request-state", listener);
		return () => ipcRenderer.removeListener("pet:request-state", listener);
	},
	/** Pet window: main-process hover state (cursor inside the interactive
	 *  hitbox) — drives the petdex hover mood row. */
	onPetHover: (cb) => {
		const listener = (_e, hovering) => cb(hovering === true);
		ipcRenderer.on("pet:hover", listener);
		return () => ipcRenderer.removeListener("pet:hover", listener);
	},
	/** Pet window: normalized gaze vector (cursor offset from the window
	 *  centre, clamped to ±1) — drives eye tracking on the builtin sprite. */
	onPetGaze: (cb) => {
		const listener = (_e, gaze) => cb(gaze);
		ipcRenderer.on("pet:gaze", listener);
		return () => ipcRenderer.removeListener("pet:gaze", listener);
	},
	/** Main window → main process: dock-to-edge preference. */
	setPetDock: (enabled) => ipcRenderer.invoke("pet-dock-set", enabled),
	/** Pet window: dock side after an edge snap ("left" | "right" | null). */
	onPetDock: (cb) => {
		const listener = (_e, payload) => cb(payload?.side ?? null);
		ipcRenderer.on("pet:dock", listener);
		return () => ipcRenderer.removeListener("pet:dock", listener);
	},
	/** Pet window: quick reply — forwards the text to the session (given id,
	 *  or the main window's active session when omitted). */
	petReply: (text, sessionId) => ipcRenderer.invoke("pet-reply", { text, sessionId }),
	/** Pet window: request a session transcript from the main window's
	 *  renderer (it owns the daemon RPC connection); the answer arrives on
	 *  onPetSessionContent. */
	petGetSessionContent: (sessionId) => ipcRenderer.invoke("pet-get-session-content", sessionId),
	/** Pet window: transcript for the requested session. */
	onPetSessionContent: (cb) => {
		const listener = (_e, payload) => cb(payload);
		ipcRenderer.on("pet:session-content", listener);
		return () => ipcRenderer.removeListener("pet:session-content", listener);
	},
	/** Main-window renderer: pet asked for a session transcript. */
	onPetGetSessionContent: (cb) => {
		const listener = (_e, sessionId) => cb(sessionId);
		ipcRenderer.on("pet:get-session-content", listener);
		return () => ipcRenderer.removeListener("pet:get-session-content", listener);
	},
	/** Main-window renderer: answer with the session transcript. */
	petSessionContent: (payload) => ipcRenderer.invoke("pet-session-content", payload),
	/** Pet window: answer a tool approval (bubble hover 批准/拒绝). */
	petApprove: (requestId, approved) => ipcRenderer.invoke("pet-approve", { requestId, approved }),
	/** Pet window: report the height it needs (bubbles grow the
	 *  window upward, bottom edge fixed). LEGACY after the 2026-09-21
	 *  bubbles-window split — nothing calls it anymore; the bubbles
	 *  window reports via setBubblesContentSize. */
	setPetContentSize: (size) => ipcRenderer.invoke("pet-set-content-size", size),
	/** Bubbles window: report its content size — the main process sizes
	 *  the window to exactly this and pins it above the sprite. */
	setBubblesContentSize: (size) => ipcRenderer.invoke("bubbles-set-content-size", size),
	/** Bubbles window: report whether any bubble is showing (empty stack
	 *  → the main process hides the window). */
	setBubblesVisible: (visible) => ipcRenderer.invoke("bubbles-set-visible", visible),
	/** Bubbles window: report the interactive card union (window-relative)
	 *  — the transparent padding ring and the gaps stay click-through. */
	setBubblesHitbox: (rect) => ipcRenderer.invoke("bubbles-set-hitbox", rect),
	/** Pet window: a global hotkey (Ctrl/Cmd+Shift+Y / N) decided a tool
	 *  approval — drop the card without an activity round-trip. */
	onPetApprovalResolved: (cb) => {
		const listener = (_e, payload) => cb(payload);
		ipcRenderer.on("pet:approval-resolved", listener);
		return () => ipcRenderer.removeListener("pet:approval-resolved", listener);
	},
	/** Board card 固定至桌面: opens a small always-on-top window with the
	 *  card payload (kimi parity, M5 skeleton). */
	pinWidget: (payload) => ipcRenderer.invoke("widget-pin", payload),
	pinTopToggle: () => ipcRenderer.invoke("widget-pin-top"),
	/** Pin window: dismiss (close button) — removes the persisted record
	 *  before closing so it is not recreated on next launch. */
	pinDismiss: () => ipcRenderer.invoke("widget-pin-dismiss"),
	/** Main-window renderer: commands forwarded from the pet window
	 *  ({type:"reply", text} | {type:"approve", requestId, approved}). */
	onPetCommand: (cb) => {
		const listener = (_e, cmd) => cb(cmd);
		ipcRenderer.on("pet:command", listener);
		return () => ipcRenderer.removeListener("pet:command", listener);
	},
	/** System sleep/wake: main-process powerMonitor "resume" push. The
	 *  renderer recovers the daemon connection on wake (Electron tears the
	 *  renderer's WebSocket down on sleep — electron#19993). */
	onPowerResume: (cb) => {
		const listener = () => cb();
		ipcRenderer.on("app-power-resume", listener);
		return () => ipcRenderer.removeListener("app-power-resume", listener);
	},
	/** Import a Petdex zip (dialog + unpack); null when cancelled. */
	importPetdex: () => ipcRenderer.invoke("pet-import"),
	/** Import a Codex hatch-pet sprite directory (dialog + pet.json); null when cancelled. */
	importCodexPet: () => ipcRenderer.invoke("pet-import-codex"),
	/** Search the petdex.dev catalog (main-process fetch — no CORS). */
	searchPetdex: (query) => ipcRenderer.invoke("pet-search", query),
	/** Download + install a petdex zip by URL (same unpack path as import). */
	installPetdexUrl: (zipUrl) => ipcRenderer.invoke("pet-install-url", zipUrl),
	/** Import a scrollbar skin zip (dialog + unpack); null when cancelled.
	 *  Shape: { id, displayName, base, colors?, size?, pacGlyph? } or
	 *  { error }. */
	importScrollbarSkin: () => ipcRenderer.invoke("scrollbar-skin-import"),
	/** Scrollbar skin market (reserved skeleton — empty until a site exists). */
	searchScrollbarSkins: () => ipcRenderer.invoke("scrollbar-skin-search"),
	/** Scrollbar skin market install (reserved skeleton). */
	installScrollbarSkinUrl: (zipUrl) => ipcRenderer.invoke("scrollbar-skin-install-url", zipUrl),
	/** Managed in-app browser (right-pane tool): the page is a DOM <webview>
	 *  owned by the renderer (menus/tooltips/handles layer normally); main owns
	 *  the persistent partition + the loopback CDP bridge the agent drives. */
	managedBrowserGetState: () => ipcRenderer.invoke("managed-browser:get-state"),
	/** Address-bar navigation (main normalizes the address + applies policy). */
	managedBrowserNavigate: (input) => ipcRenderer.invoke("managed-browser:navigate", input),
	/** Clear managed-browser cookies ("cookies") or all data ("all"). */
	managedBrowserClearData: (mode) => ipcRenderer.invoke("managed-browser:clear-data", { mode }),
	/** Interrupt the agent's in-flight operation on a tab (optional tabId). */
	managedBrowserStop: (tabId) => ipcRenderer.invoke("managed-browser:stop", tabId),
	/** Device preset + emulated viewport for the active tab
	 *  ("fit" clears the identity and the metrics override). */
	managedBrowserSetDevice: (input) => ipcRenderer.invoke("managed-browser:set-device", input),
	/** Per-tab page zoom factor (0.25–3), independent of device presets. */
	managedBrowserSetZoom: (input) => ipcRenderer.invoke("managed-browser:set-zoom", input),
	/** Renderer answer to a risky-navigation consent request. */
	managedBrowserConfirmResult: (input) => ipcRenderer.invoke("managed-browser:confirm-result", input),
	/** Guest lifecycle → main: the CDP bridge binds `webContents.fromId(id)`. */
	managedBrowserGuestReady: (input) => ipcRenderer.invoke("managed-browser:guest-ready", input),
	managedBrowserGuestGone: (tabId) => ipcRenderer.invoke("managed-browser:guest-gone", tabId),
	managedBrowserActiveTab: (tabId) => ipcRenderer.invoke("managed-browser:active-tab", tabId),
	managedBrowserVisibility: (visible) => ipcRenderer.invoke("managed-browser:visibility", { visible }),
	/** Managed browser state pushed on any change (port/activity/agentActivity). */
	onManagedBrowserState: (cb) => {
		const listener = (_e, state) => cb(state);
		ipcRenderer.on("managed-browser:state", listener);
		return () => ipcRenderer.removeListener("managed-browser:state", listener);
	},
	/** Risky-navigation consent request from the bridge. */
	onManagedBrowserConfirm: (cb) => {
		const listener = (_e, payload) => cb(payload);
		ipcRenderer.on("managed-browser:confirm", listener);
		return () => ipcRenderer.removeListener("managed-browser:confirm", listener);
	},
	/** Agent-created tab (CDP Target.createTarget / popup): mount a <webview>. */
	onManagedBrowserCreateTab: (cb) => {
		const listener = (_e, payload) => cb(payload);
		ipcRenderer.on("managed-browser:create-tab", listener);
		return () => ipcRenderer.removeListener("managed-browser:create-tab", listener);
	},
	onManagedBrowserSelectTab: (cb) => {
		const listener = (_e, payload) => cb(payload);
		ipcRenderer.on("managed-browser:select-tab", listener);
		return () => ipcRenderer.removeListener("managed-browser:select-tab", listener);
	},
	onManagedBrowserCloseTab: (cb) => {
		const listener = (_e, payload) => cb(payload);
		ipcRenderer.on("managed-browser:close-tab", listener);
		return () => ipcRenderer.removeListener("managed-browser:close-tab", listener);
	},
	/** Self-drawn frosted tray menu (tray-menu.html) bridge. */
	trayMenu: {
		onSnapshot: (cb) => {
			const listener = (_e, snapshot) => cb(snapshot);
			ipcRenderer.on("tray-menu:snapshot", listener);
			return () => ipcRenderer.removeListener("tray-menu:snapshot", listener);
		},
		action: (type, params) => ipcRenderer.send("tray-menu:action", { type, ...params }),
	},
});
