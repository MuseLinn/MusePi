/**
 * Electron preload — exposes the daemon lifecycle bridge to the sandboxed
 * renderer as `window.electronAPI` (the renderer checks for it to decide
 * it is running inside the desktop shell, replacing the old isTauri()).
 */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
	/** Port of a running daemon (ws.port file), or null. */
	probeDaemonPort: () => ipcRenderer.invoke("daemon-probe"),
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
	/** Window glass on/off (true = native vibrancy, false = opaque); style is
	 *  "light" | "dark" and selects the bright/dim material + opaque base. */
	setWindowGlass: (enabled, style) => ipcRenderer.invoke("gui-vibrancy", enabled, style),
	/** Haptic tap (macOS Taptic Engine) — pattern 0 generic / 1 alignment /
	 *  2 level-change; no-op on platforms without a haptic device. */
	haptic: (pattern) => ipcRenderer.invoke("haptic", pattern),
	/** OTA: compare the local version against the update manifest. */
	checkUpdates: () => ipcRenderer.invoke("updater-check"),
	/** OTA: listen for an auto-checked update notice. */
	onUpdateAvailable: (cb) => {
		const listener = (_e, result) => cb(result);
		ipcRenderer.on("update-available", listener);
		return () => ipcRenderer.removeListener("update-available", listener);
	},
	/** Agent companion pet window (伙伴): show/hide the floating pet. */
	setPetVisible: (visible) => ipcRenderer.invoke("pet-toggle", visible),
	/** Pet window drag (renderer client coords → main converts to screen
	 *  deltas with the window position; window moves cancel out). */
	movePetWindowByClient: (clientX, clientY) => ipcRenderer.invoke("pet-drag-client", { clientX, clientY }),
	/** Drag finished (resets the main-process delta tracker). */
	petDragEnd: () => ipcRenderer.invoke("pet-drag-end"),
	/** Pet window click → focus the main window. */
	focusMainWindow: () => ipcRenderer.invoke("pet-click"),
	/** Pet panel recent-session click → open the session in the main window. */
	petOpenSession: (sessionId) => ipcRenderer.invoke("pet-open-session", sessionId),
	/** Main window: pet asked to open a session. */
	onPetOpenSession: (cb) => {
		const listener = (_e, sessionId) => cb(sessionId);
		ipcRenderer.on("pet:open-session", listener);
		return () => ipcRenderer.removeListener("pet:open-session", listener);
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
	/** Pet window: answer a tool approval (pet panel 批准/拒绝). */
	petApprove: (requestId, approved) => ipcRenderer.invoke("pet-approve", { requestId, approved }),
	/** Pet window: expand/collapse the interaction panel (window resize). */
	petSetPanel: (open) => ipcRenderer.invoke("pet-set-panel", open),
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
	/** Keep the machine from idle-sleeping (settings 常规 → 保持电脑运行).
	 *  Main process holds a caffeinate -i child while enabled. */
	setKeepAwake: (enabled) => ipcRenderer.invoke("keep-awake-set", enabled),
	/** Import a Petdex zip (dialog + unpack); null when cancelled. */
	importPetdex: () => ipcRenderer.invoke("pet-import"),
	/** Search the petdex.dev catalog (main-process fetch — no CORS). */
	searchPetdex: (query) => ipcRenderer.invoke("pet-search", query),
	/** Download + install a petdex zip by URL (same unpack path as import). */
	installPetdexUrl: (zipUrl) => ipcRenderer.invoke("pet-install-url", zipUrl),
});
