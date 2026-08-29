/**
 * Managed in-app browser (Proma 吸收, browser-controller.ts + browser-policy).
 *
 * The desktop GUI's right-pane browser becomes the SAME instance the agent
 * drives:
 *
 * - Electron main owns one `WebContentsView` per tab on a persistent
 *   partition (`persist:omp-managed-browser`), so login state survives
 *   restarts and is shared between the user and the agent — one instance,
 *   two operators.
 * - A loopback HTTP+WS server impersonates Chrome's CDP discovery endpoint
 *   (the relay bridge's emulation, minus extension/grouping machinery) so
 *   the browser tool's `connected` kind (`browser.gui` setting) attaches via
 *   plain `puppeteer.connect({ browserURL })` and drives the same views the
 *   user sees. Web contents and CDP never leave the main process.
 * - The renderer only projects layout (`managed-browser:set-layout`) and
 *   reads projected state; it never touches WebContents/CDP directly
 *   (Proma's `assertMainRenderer` posture).
 *
 * Safety: loopback-only bind, ws Origin rejected (a web page cannot drive
 * the managed browser), permission requests denied outright, URL bar
 * navigation restricted to http/https, navigation state redacted of URL
 * credentials, and a sanitized activity ledger (never page text, cookies or
 * script source).
 */
"use strict";

const { BrowserWindow, ipcMain, net, protocol, session: electronSession, shell, WebContentsView } = require("electron");
const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createHash } = require("node:crypto");

const DEFAULT_PORT = Number(process.env.MUSEPI_MANAGED_BROWSER_PORT || 9230);
const MAX_PORT_TRIES = 10;
const PARTITION = "persist:omp-managed-browser";
const MAX_ACTIVITY_ITEMS = 12;
const CDP_ERROR_METHOD_NOT_FOUND = -32601;
const CDP_ERROR_SERVER = -32000;
/** URLs the tool must never see as targets (mirrors the relay's ineligible set). */
const INELIGIBLE_URL = /^(chrome|devtools|edge|view-source|chrome-extension|chrome-untrusted|chrome-search):/i;
/** Sanctioned local-preview scheme: `omp-file://<urlencoded absolute path>`
 *  serves agent-generated artifacts through the managed session. */
const LOCAL_PREVIEW_SCHEME = "omp-file";
/** Timeout for the renderer's risky-navigation consent dialog (auto-deny). */
const CONFIRM_TIMEOUT_MS = 30_000;

// Must run before app ready (main.cjs requires this module at top level).
// registerSchemesAsPrivileged can only be called once per process.
if (!process.env.MUSEPI_MANAGED_BROWSER_SCHEMES_REGISTERED) {
	process.env.MUSEPI_MANAGED_BROWSER_SCHEMES_REGISTERED = "1";
	protocol.registerSchemesAsPrivileged([
		{
			scheme: LOCAL_PREVIEW_SCHEME,
			privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
		},
	]);
}

function tabTargetId(tabId) {
	return `TAB${tabId}`;
}

function pageTargetId(tabId) {
	return `PAGE${tabId}`;
}

/** Puppeteer's CdpBrowser.target() looks this id up in discovered targets. */
const BROWSER_TARGET_ID = "browser";

/** The browser-level target (real Chrome parity): type "browser", attached
 *  via the connection root, never via a tab session. */
function browserTargetInfo() {
	return {
		targetId: BROWSER_TARGET_ID,
		type: "browser",
		title: "",
		url: "",
		attached: true,
		canAccessOpener: false,
	};
}

// ── minimal WebSocket frame codec (no `ws` dep in the Electron main) ──────

const WS_OP_TEXT = 0x1;
const WS_OP_CLOSE = 0x8;
const WS_OP_PING = 0x9;
const WS_OP_PONG = 0xa;

/** Server → client frame (unmasked). */
function encodeWsFrame(payload) {
	const len = payload.length;
	let header;
	if (len < 126) {
		header = Buffer.from([0x81, len]);
	} else if (len < 65536) {
		header = Buffer.alloc(4);
		header[0] = 0x81;
		header[1] = 126;
		header.writeUInt16BE(len, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x81;
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(len), 2);
	}
	return Buffer.concat([header, payload]);
}

/**
 * Incremental client → server frame decoder. Handles masking, 7/16/64-bit
 * lengths, fragmentation (continuation frames), ping/pong and close; emits
 * complete text payloads via `onMessage` and control events via `onControl`.
 */
class WsFrameDecoder {
	constructor(onMessage, onControl) {
		this.buf = Buffer.alloc(0);
		this.onMessage = onMessage;
		this.onControl = onControl;
		this.fragment = null;
	}

	push(chunk) {
		this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
		for (;;) {
			const frame = this.tryFrame();
			if (!frame) return;
			if (frame.opcode === WS_OP_TEXT) {
				this.fragment = this.fragment === null ? frame.payload : Buffer.concat([this.fragment, frame.payload]);
				if (frame.fin) {
					const complete = this.fragment;
					this.fragment = null;
					this.onMessage(complete);
				}
			} else {
				this.onControl(frame.opcode, frame.payload);
			}
		}
	}

	tryFrame() {
		if (this.buf.length < 2) return null;
		const b0 = this.buf[0];
		const b1 = this.buf[1];
		const fin = (b0 & 0x80) !== 0;
		const opcode = b0 & 0x0f;
		const masked = (b1 & 0x80) !== 0;
		let len = b1 & 0x7f;
		let offset = 2;
		if (len === 126) {
			if (this.buf.length < 4) return null;
			len = this.buf.readUInt16BE(2);
			offset = 4;
		} else if (len === 127) {
			if (this.buf.length < 10) return null;
			len = Number(this.buf.readBigUInt64BE(2));
			offset = 10;
		}
		let maskKey = null;
		if (masked) {
			if (this.buf.length < offset + 4) return null;
			maskKey = this.buf.subarray(offset, offset + 4);
			offset += 4;
		}
		if (this.buf.length < offset + len) return null;
		let payload = this.buf.subarray(offset, offset + len);
		if (masked && maskKey) {
			payload = Buffer.from(payload);
			for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
		}
		this.buf = this.buf.subarray(offset + len);
		return { fin, opcode, payload };
	}
}

/** Reverse of tabTargetId/pageTargetId; null for foreign ids. */
function parseTargetId(targetId) {
	const match = /^(TAB|PAGE)(\d+)$/.exec(String(targetId));
	if (!match) return null;
	return { kind: match[1] === "TAB" ? "tab" : "page", tabId: Number(match[2]) };
}

/** Strip credentials from a URL for display/state (never leak user:pass). */
function redactUrl(url) {
	try {
		const parsed = new URL(url);
		if (parsed.username || parsed.password) {
			parsed.username = "";
			parsed.password = "";
			return parsed.toString();
		}
	} catch {
		// non-URL (about:blank etc.) — leave as-is
	}
	return url;
}

/** Address-bar normalization: bare hostnames default to https; http/https or
 *  omp-file (local preview) are accepted. */
function normalizeAddressBarUrl(input) {
	const value = String(input).trim();
	if (!value) return null;
	if (value.startsWith("//")) return null;
	if (/^omp-file:/i.test(value)) {
		// Local preview, canonical form `omp-file://localhost<absolute path>`.
		// An empty host is unstable: Chromium canonicalizes `omp-file:///tmp/x`
		// into `omp-file://tmp/x`, folding the first path segment into the
		// host. With a real host the pathname IS the absolute path.
		try {
			const parsed = new URL(value);
			const filePath = path.normalize(decodeURIComponent(parsed.pathname));
			if (!path.isAbsolute(filePath)) return null;
			return `omp-file://localhost${encodeURI(filePath)}`;
		} catch {
			return null;
		}
	}
	let candidate = value;
	if (!/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)) candidate = `https://${value}`;
	try {
		const parsed = new URL(candidate);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
		return parsed.toString();
	} catch {
		return null;
	}
}

/** One managed tab: an Electron WebContentsView + its CDP debugger session. */
/**
 * Element-picker page script (injected via executeJavaScript). Hover shows a
 * highlight overlay; click captures the target's unique CSS selector; Esc
 * cancels. Resolves with the selector string (or null on cancel). Cleanup
 * is stashed on window.__ompPickerCleanup so a host-side timeout can sweep
 * it even when the promise never settles.
 */
const PICK_ELEMENT_SCRIPT = `(() => {
	if (window.__ompPickerActive) return null;
	window.__ompPickerActive = true;
	let overlay = null;
	const cleanup = () => {
		window.__ompPickerActive = false;
		document.removeEventListener("mousemove", onMove, true);
		document.removeEventListener("mouseout", onOut, true);
		document.removeEventListener("click", onClick, true);
		document.removeEventListener("keydown", onKey, true);
		if (overlay) { overlay.remove(); overlay = null; }
		window.__ompPickerCleanup = null;
	};
	window.__ompPickerCleanup = cleanup;
	const showOverlay = (el) => {
		if (!overlay) {
			overlay = document.createElement("div");
			overlay.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #8b5cf6;background:rgba(139,92,246,.14);border-radius:2px;transition:left 90ms ease,top 90ms ease,width 90ms ease,height 90ms ease;";
			document.documentElement.appendChild(overlay);
		}
		const r = el.getBoundingClientRect();
		overlay.style.display = "block";
		overlay.style.left = r.left + "px";
		overlay.style.top = r.top + "px";
		overlay.style.width = r.width + "px";
		overlay.style.height = r.height + "px";
	};
	const cssPath = (el) => {
		if (!(el instanceof Element) || el === document.documentElement || el === document.body) return null;
		if (el.id) return "#" + CSS.escape(el.id);
		const parts = [];
		let node = el;
		while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
			if (node.id) { parts.unshift("#" + CSS.escape(node.id)); break; }
			let sel = node.tagName.toLowerCase();
			const cls = Array.from(node.classList).slice(0, 2).map((c) => "." + CSS.escape(c)).join("");
			if (cls) sel += cls;
			const sameTag = Array.from(node.parentElement ? node.parentElement.children : []).filter((s) => s.tagName === node.tagName);
			if (sameTag.length > 1) sel += ":nth-child(" + (sameTag.indexOf(node) + 1) + ")";
			parts.unshift(sel);
			node = node.parentElement;
		}
		return parts.join(" > ");
	};
	const onMove = (e) => {
		const el = e.target;
		if (el && el.nodeType === 1 && el !== document.documentElement && el !== document.body) showOverlay(el);
	};
	const onOut = () => { if (overlay) overlay.style.display = "none"; };
	const onClick = (e) => {
		e.preventDefault();
		e.stopPropagation();
		const selector = cssPath(e.target);
		cleanup();
		if (window.__ompPickerResolve) { window.__ompPickerResolve(selector); window.__ompPickerResolve = null; }
	};
	const onKey = (e) => {
		if (e.key === "Escape") {
			cleanup();
			if (window.__ompPickerResolve) { window.__ompPickerResolve(null); window.__ompPickerResolve = null; }
		}
	};
	document.addEventListener("mousemove", onMove, true);
	document.addEventListener("mouseout", onOut, true);
	document.addEventListener("click", onClick, true);
	document.addEventListener("keydown", onKey, true);
	return new Promise((resolve) => {
		window.__ompPickerResolve = resolve;
	});
})()`;

class ManagedTab {
	constructor(controller, url, openedByAgent) {
		this.controller = controller;
		this.id = ++controller.tabSeq;
		this.openedByAgent = openedByAgent;
		this.url = "about:blank";
		this.title = "";
		this.loading = false;
		this.visible = false;
		this.bounds = null;
		this.lastLayoutRevision = 0;
		this.view = new WebContentsView({
			webPreferences: {
				partition: PARTITION,
				nodeIntegration: false,
				contextIsolation: true,
				sandbox: true,
				// A hidden, idle view's renderer is background-throttled and
				// never becomes CDP-debuggable until a navigation forces it
				// to run. Keep it alive so the agent can drive the tab even
				// before the panel projects a visible layout.
				backgroundThrottling: false,
			},
		});
		const wc = this.view.webContents;
		// The initial about:blank document does not boot a debuggable
		// renderer on its own; loadURL forces it up.
		void wc.loadURL("about:blank").catch(() => {});
		wc.setWindowOpenHandler(({ url: targetUrl }) => {
			// target=_blank / window.open become managed tabs instead of
			// escaping the app (deny would silently drop user clicks).
			if (/^https?:/i.test(targetUrl)) controller.createTab(targetUrl);
			return { action: "deny" };
		});
		wc.on("will-navigate", (event, targetUrl) => {
			if (!/^https?:/i.test(targetUrl)) event.preventDefault();
		});
		wc.on("did-start-loading", () => {
			this.loading = true;
			this.refreshState();
			controller.notifyLifecycle(this);
		});
		wc.on("did-stop-loading", () => {
			this.loading = false;
			this.refreshState();
			controller.notifyLifecycle(this);
			controller.markActivityComplete(this);
		});
		wc.on("did-navigate", (_e, targetUrl) => {
			this.refreshState(targetUrl);
			controller.notifyLifecycle(this);
		});
		wc.on("did-navigate-in-page", (_e, targetUrl) => {
			this.refreshState(targetUrl);
			controller.notifyLifecycle(this);
		});
		wc.on("page-title-updated", (_e, title) => {
			this.title = title;
			controller.notifyLifecycle(this);
		});
		wc.on("destroyed", () => {
			controller.handleTabDestroyed(this);
		});
		this.view.setVisible(false);
		controller.owner.contentView.addChildView(this.view);
		// CDP: the debugger is attached LAZILY after the renderer finishes its
		// initial load (attaching to a booting renderer wedges it — every
		// command hangs until a navigation). whenDebuggerReady() bridges the
		// remaining race for clients that attach mid-load.
		this.cdpOk = false;
		wc.once("did-finish-load", () => this.ensureDebugger());
		if (url && url !== "about:blank") void this.navigate(url);
	}

	/** Attach the CDP debugger on demand; true once commands can flow. */
	ensureDebugger() {
		if (this.cdpOk) return true;
		const wc = this.view.webContents;
		if (wc.isDestroyed()) return false;
		try {
			wc.debugger.attach("1.3");
			this.cdpOk = true;
			wc.debugger.on("message", (_event, method, params) => {
				this.controller.onCdpEvent(this, method, params);
			});
			wc.debugger.on("detach", () => {
				this.cdpOk = false;
			});
			return true;
		} catch {
			this.cdpOk = false;
			return false;
		}
	}

	/** Resolve once the debugger is attachable (waits out the initial load). */
	whenDebuggerReady(timeoutMs = 4000) {
		if (this.cdpOk) return Promise.resolve(true);
		const wc = this.view.webContents;
		if (wc.isDestroyed()) return Promise.resolve(false);
		if (!wc.isLoading()) {
			this.ensureDebugger();
			return Promise.resolve(this.cdpOk);
		}
		return new Promise((resolve) => {
			const done = () => {
				clearTimeout(timer);
				wc.removeListener("did-finish-load", done);
				this.ensureDebugger();
				resolve(this.cdpOk);
			};
			const timer = setTimeout(() => {
				wc.removeListener("did-finish-load", done);
				this.ensureDebugger();
				resolve(this.cdpOk);
			}, timeoutMs);
			wc.once("did-finish-load", done);
		});
	}

	refreshState(navigatedUrl) {
		const wc = this.view.webContents;
		if (wc.isDestroyed()) return;
		if (navigatedUrl) this.url = redactUrl(navigatedUrl);
		else this.url = redactUrl(wc.getURL()) || this.url;
		this.title = wc.getTitle() || this.title;
	}

	async navigate(url) {
		const target = normalizeAddressBarUrl(url);
		if (!target) return { ok: false, error: "Only http/https or omp-file:// URLs are allowed" };
		try {
			await this.view.webContents.loadURL(target);
			return { ok: true, url: target };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async goBack() {
		const wc = this.view.webContents;
		if (wc.navigationHistory?.canGoBack()) wc.navigationHistory.goBack();
		else if (wc.canGoBack()) wc.goBack();
	}

	async goForward() {
		const wc = this.view.webContents;
		if (wc.navigationHistory?.canGoForward()) wc.navigationHistory.goForward();
		else if (wc.canGoForward()) wc.goForward();
	}

	async reload() {
		this.view.webContents.reload();
	}

	/** Hard reload: bypass caches (ReloadIgnoringCache). */
	async hardReload() {
		const wc = this.view.webContents;
		if (wc.isDestroyed()) return;
		if (wc.reloadIgnoringCache) wc.reloadIgnoringCache();
		else wc.reload();
	}

	/**
	 * Element picker: inject a capture-mode script (hover highlight + click
	 * to select + Esc to cancel). resolve with the unique CSS selector, or
	 * null on cancel/timeout. The script is self-cleaning — a timeout leaves
	 * `__ompPickerCleanup` behind so the next pick (or the cleanup pass in
	 * `pickElement`) removes its overlay/listeners.
	 */
	async pickElement(timeoutMs = 60000) {
		const wc = this.view.webContents;
		if (wc.isDestroyed()) return { cancelled: true };
		let timer;
		try {
			const result = await Promise.race([
				wc.executeJavaScript(PICK_ELEMENT_SCRIPT, true).then(selector => ({
					selector: typeof selector === "string" && selector.length > 0 ? selector : null,
				})),
				new Promise(resolve => {
					timer = setTimeout(() => resolve({ cancelled: true }), timeoutMs);
				}),
			]);
			return result;
		} catch {
			return { cancelled: true };
		} finally {
			clearTimeout(timer);
			// Sweep any picker state left behind (timeout path).
			try {
				if (!wc.isDestroyed()) {
					await wc
						.executeJavaScript(
							`if (window.__ompPickerCleanup) { window.__ompPickerCleanup(); window.__ompPickerCleanup = null; }`,
							true,
						)
						.catch(() => {});
				}
			} catch {
				// webContents gone — nothing to sweep
			}
		}
	}

	dispose() {
		try {
			if (this.view.webContents.debugger.isAttached()) this.view.webContents.debugger.detach();
		} catch {
			// already destroyed
		}
		try {
			this.controller.owner.contentView.removeChildView(this.view);
		} catch {
			// owner gone
		}
		if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
	}
}

class ManagedBrowserController {
	constructor() {
		this.owner = null;
		this.tabs = new Map();
		this.activeTabId = null;
		this.tabSeq = 0;
		this.conns = new Map();
		this.connSeq = 0;
		this.sessionSeq = 0;
		this.ledger = [];
		this.server = null;
		this.port = DEFAULT_PORT;
		this.layoutRevision = 0;
		this.partitionGuarded = false;
		/** Dedicated tab the agent drives (browser.gui); user tabs untouched. */
		this.agentTabId = null;
		/** In-flight risky-navigation consent request ({requestId, timer, resolve}). */
		this.pendingConfirm = null;
		this.confirmSeq = 0;
	}

	// ── lifecycle ────────────────────────────────────────────────────────

	/**
	 * Re-point the controller at the current main window. The GUI can
	 * recreate the window (show-main-window path: pet/tray reopen after a
	 * close), and the old owner stays destroyed — a stale `this.owner`
	 * makes the next `createTab()` throw "Object has been destroyed" at
	 * `owner.contentView.addChildView` (the managed-browser:navigate crash
	 * the user hit). Same window: no-op; a different window drops the old
	 * tabs and re-arms the closed handler.
	 */
	setOwner(ownerWindow) {
		if (this.owner === ownerWindow) return;
		for (const tab of [...this.tabs.values()]) tab.dispose();
		this.tabs.clear();
		this.activeTabId = null;
		this.agentTabId = null;
		this.owner = ownerWindow;
		this.owner.on("closed", () => {
			for (const tab of [...this.tabs.values()]) tab.dispose();
			this.tabs.clear();
			this.activeTabId = null;
			this.agentTabId = null;
			this.closeServer();
		});
	}

	async start(ownerWindow) {
		this.setOwner(ownerWindow);
		this.guardPartition();
		this.registerIpc();
		await this.startServer();
		return this.port;
	}

	guardPartition() {
		if (this.partitionGuarded) return;
		this.partitionGuarded = true;
		try {
			const ses = electronSession.fromPartition(PARTITION);
			// Proma posture: the managed browser never asks for permissions
			// (camera/mic/notifications/…) — deny outright so pages cannot
			// hang on or abuse prompts.
			ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
			// Local artifact preview: `omp-file://<urlencoded absolute path>`.
			// Absolute paths only; navigation to it from renderer-initiated
			// non-http(s) links is blocked by will-navigate.
			ses.protocol.handle(LOCAL_PREVIEW_SCHEME, (request) => {
				let filePath;
				try {
					filePath = path.normalize(decodeURIComponent(new URL(request.url).pathname));
				} catch {
					return new Response("bad request", { status: 400 });
				}
				if (!path.isAbsolute(filePath) || path.basename(filePath) === "") {
					return new Response("not found", { status: 404 });
				}
				return net.fetch(pathToFileURL(filePath).toString());
			});
		} catch {
			// session unavailable (tests / headless) — best effort
		}
	}

	// ── tabs ─────────────────────────────────────────────────────────────

	createTab(url = "about:blank", openedByAgent = false) {
		if (!this.owner || this.owner.isDestroyed()) return null;
		const tab = new ManagedTab(this, url, openedByAgent);
		this.tabs.set(String(tab.id), tab);
		if (!this.activeTabId) this.activeTabId = String(tab.id);
		void this.announceTabCreated(tab);
		this.recordActivity(tab, "open", tab.url, "opened");
		this.emitState({ agentActivity: openedByAgent });
		// The agent's work must stay visible: creating an agent tab shows it.
		if (openedByAgent) this.activateDisplayTab(tab);
		return tab;
	}

	/** The dedicated agent tab; creates it on first use. */
	ensureAgentTab() {
		const existing = this.agentTabId ? this.tabs.get(this.agentTabId) : null;
		if (existing) return existing;
		const tab = this.createTab("about:blank", true);
		this.agentTabId = String(tab.id);
		return tab;
	}

	ensureTab(url = "about:blank", openedByAgent = false) {
		if (!this.owner || this.owner.isDestroyed()) return null;
		if (this.tabs.size > 0) return this.tabs.get(this.activeTabId);
		return this.createTab(url, openedByAgent);
	}

	handleTabDestroyed(tab) {
		if (!this.tabs.has(String(tab.id))) return;
		this.tabs.delete(String(tab.id));
		if (this.agentTabId === String(tab.id)) this.agentTabId = null;
		if (this.activeTabId === String(tab.id)) {
			const next = [...this.tabs.values()][0];
			this.activeTabId = next ? String(next.id) : null;
			if (next) this.activateDisplayTab(next);
		}
		this.announceTabDestroyed(tab);
		this.emitState({});
	}

	selectTab(tabId) {
		const tab = this.tabs.get(String(tabId));
		if (!tab) return null;
		this.activateDisplayTab(tab);
		this.emitState({});
		return this.state();
	}

	activateDisplayTab(tab) {
		for (const other of this.tabs.values()) {
			if (other !== tab && other.visible) {
				other.visible = false;
				other.view.setVisible(false);
			}
		}
		this.activeTabId = String(tab.id);
		if (tab.bounds) {
			tab.view.setBounds(tab.bounds);
			tab.view.setVisible(true);
			tab.visible = true;
		}
	}

	closeTab(tabId) {
		const tab = this.tabs.get(String(tabId));
		if (!tab) return null;
		tab.dispose();
		this.handleTabDestroyed(tab);
		return this.state();
	}

	closeAll() {
		for (const tab of [...this.tabs.values()]) tab.dispose();
		this.tabs.clear();
		this.activeTabId = null;
		this.emitState({});
	}

	// ── renderer-facing state + layout ───────────────────────────────────

	state() {
		const active = this.activeTabId ? this.tabs.get(this.activeTabId) : null;
		return {
			port: this.server ? this.port : null,
			activeTabId: this.activeTabId,
			tabs: [...this.tabs.values()].map((tab) => ({
				id: String(tab.id),
				url: tab.url,
				title: tab.title || "新建标签页",
				loading: tab.loading,
				openedByAgent: tab.openedByAgent,
			})),
			canGoBack: active ? this.canGoBack(active) : false,
			canGoForward: active ? this.canGoForward(active) : false,
			activity: this.ledger[this.ledger.length - 1] ?? null,
		};
	}

	canGoBack(tab) {
		try {
			const wc = tab.view.webContents;
			return wc.navigationHistory?.canGoBack() ?? wc.canGoBack();
		} catch {
			return false;
		}
	}

	canGoForward(tab) {
		try {
			const wc = tab.view.webContents;
			return wc.navigationHistory?.canGoForward() ?? wc.canGoForward();
		} catch {
			return false;
		}
	}

	emitState(extra) {
		if (!this.owner || this.owner.isDestroyed()) return;
		const payload = { ...this.state(), ...extra };
		this.owner.webContents.send("managed-browser:state", payload);
	}

	/** Renderer-projected layout: the slot's CSS rect (× zoom) becomes the
	 *  native view bounds; stale revisions are dropped (React cleanup and a
	 *  new slot's IPC can interleave). */
	applyLayout({ tabId, bounds, visible, revision }) {
		if (!Number.isSafeInteger(revision) || revision <= this.layoutRevision) return;
		this.layoutRevision = revision;
		const tab = tabId ? this.tabs.get(String(tabId)) : this.tabs.get(this.activeTabId);
		if (!tab) return;
		const width = Number(bounds?.width) || 0;
		const height = Number(bounds?.height) || 0;
		// Blank tabs (about:blank, no URL yet) render a React start page in
		// the slot; hiding the native view lets it show through. Real pages
		// project normally.
		const isBlank = !tab.url || tab.url === "about:blank";
		// `visible` (renderer-projected: slot mounted, no blocking overlay,
		// real URL) is the authority. owner.isVisible() is NOT gated on: a
		// window that is merely occluded/minimized mid-transition must not
		// leave the view permanently hidden — the next projection re-shows
		// it (user: 内置浏览器还是不显示内容, blank white slot).
		const show = !isBlank && visible && width > 4 && height > 4 && this.owner && !this.owner.isDestroyed();
		const zoom = this.owner?.webContents.getZoomFactor() ?? 1;
		const adjusted = {
			x: Math.round((Number(bounds?.x) || 0) * zoom),
			y: Math.round((Number(bounds?.y) || 0) * zoom),
			width: Math.round(width * zoom),
			height: Math.round(height * zoom),
		};
		for (const other of this.tabs.values()) {
			if (other !== tab && other.visible) {
				other.visible = false;
				other.view.setVisible(false);
			}
		}
		if (show && (!tab.bounds || Object.entries(adjusted).some(([key, value]) => tab.bounds?.[key] !== value))) {
			tab.view.setBounds(adjusted);
			tab.bounds = adjusted;
		}
		tab.view.setVisible(show);
		tab.visible = show;
		if (show && this.activeTabId !== String(tab.id)) {
			this.activeTabId = String(tab.id);
			this.emitState({});
		}
	}

	// ── activity ledger (sanitized — never page text, cookies or scripts) ─

	recordActivity(tab, action, url, status) {
		let domain = null;
		try {
			domain = new URL(url).host || null;
		} catch {
			// about:blank etc.
		}
		this.ledger.push({
			id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			action,
			summary: this.activitySummary(action, tab, url),
			domain,
			status,
			tabId: String(tab.id),
			at: Date.now(),
		});
		if (this.ledger.length > MAX_ACTIVITY_ITEMS) this.ledger.shift();
	}

	/** An agent-initiated action on `tab` finished loading — drop its
	 *  in-flight ledger entry so the renderer hides the "Agent 活动" row
	 *  (it is transient: visible only while the agent is working). */
	markActivityComplete(tab) {
		const id = String(tab.id);
		for (let i = this.ledger.length - 1; i >= 0; i--) {
			const entry = this.ledger[i];
			if (entry.tabId === id && entry.status === "dispatched") {
				entry.status = "completed";
				this.emitState({});
				return;
			}
		}
	}

	activitySummary(action, tab, url) {
		switch (action) {
			case "navigate":
				return `导航到 ${url}`;
			case "click":
				return `点击元素`;
			case "fill":
				return `填写表单字段`;
			case "press":
				return `按键输入`;
			case "evaluate":
				return `执行页面脚本`;
			case "screenshot":
				return `截取页面`;
			case "open":
				return tab.openedByAgent ? "Agent 新建标签" : "打开新标签";
			case "observe":
				return "读取页面结构";
			default:
				return action;
		}
	}

	// ── risky-navigation consent gate (agent lane only) ──────────────────

	/**
	 * Agent-driven navigations to sanctioned destinations (http/https, the
	 * local preview scheme) pass without asking. Raw file://, credentials in
	 * the URL, and exotic schemes need explicit user consent (default deny).
	 */
	async gateAgentNavigation(url) {
		if (!url || url === "about:blank") return true;
		let parsed;
		try {
			parsed = new URL(url);
		} catch {
			return false;
		}
		if (
			parsed.protocol === "http:" ||
			parsed.protocol === "https:" ||
			parsed.protocol === `${LOCAL_PREVIEW_SCHEME}:`
		) {
			return true;
		}
		return await this.askUserForConsent(url);
	}

	/** Ask the renderer to confirm a risky navigation; one dialog at a time,
	 *  auto-deny on timeout or when the window is gone. */
	askUserForConsent(url) {
		if (this.pendingConfirm) return Promise.resolve(false);
		if (!this.owner || this.owner.isDestroyed()) return Promise.resolve(false);
		return new Promise((resolve) => {
			const requestId = `c${++this.confirmSeq}`;
			const timer = setTimeout(() => {
				if (this.pendingConfirm && this.pendingConfirm.requestId === requestId) {
					this.pendingConfirm = null;
				}
				resolve(false);
			}, CONFIRM_TIMEOUT_MS);
			this.pendingConfirm = { requestId, timer, resolve };
			this.owner.webContents.send("managed-browser:confirm", {
				requestId,
				url: redactUrl(url),
			});
		});
	}

	// ── operation status + stop (executionSource 停止按钮) ───────────────

	/** Flip the latest dispatched ledger entry for a tab to a terminal status. */
	markOpStatus(tabId, status) {
		for (let i = this.ledger.length - 1; i >= 0; i--) {
			const entry = this.ledger[i];
			if (entry.tabId === tabId && entry.status === "dispatched") {
				entry.status = status;
				break;
			}
		}
	}

	/** Interrupt the agent's in-flight operation on a tab: stop the loading
	 *  navigation; for the dedicated agent tab, close it so the pending CDP
	 *  call rejects as the target dies (Electron's debugger accepts
	 *  Runtime.terminateExecution but never aborts the running script — the
	 *  daemon's browser tool then fails fast either way). */
	stopOp(tabId) {
		const tab = tabId ? this.tabs.get(String(tabId)) : this.tabs.get(this.activeTabId);
		if (!tab) return null;
		const wc = tab.view.webContents;
		if (!wc.isDestroyed()) {
			try {
				wc.stop();
			} catch {
				// already stopped/destroyed
			}
		}
		if (tab.openedByAgent) this.closeTab(String(tab.id));
		this.markOpStatus(String(tab.id), "canceled");
		this.emitState({});
		return this.state();
	}

	/**
	 * Clear managed-browser browsing data for the shared partition.
	 * `mode: "cookies"` clears cookies/storage; `"all"` also wipes cache.
	 * Returns `{ ok: boolean }`.
	 */
	async clearBrowserData(mode) {
		try {
			const ses = electronSession.fromPartition(PARTITION);
			if (mode === "all") {
				await ses.clearCache();
				await ses.clearStorageData();
			} else {
				await ses.clearStorageData({
					storages: ["cookies", "localstorage", "indexdb", "serviceworkers", "cachestorage"],
				});
			}
			return { ok: true };
		} catch {
			return { ok: false };
		}
	}

	/** Open a URL in the user's default system browser (shell.openExternal). */
	openExternal(url) {
		const target = String(url || "").trim();
		if (!/^https?:/i.test(target)) return { ok: false };
		void shell.openExternal(target).catch(() => {});
		return { ok: true };
	}

	// ── CDP lifecycle announcements ──────────────────────────────────────

	async announceTabCreated(tab) {
		for (const conn of this.conns.values()) {
			if (!conn.discover) continue;
			this.emit(conn, "Target.targetCreated", { targetInfo: this.tabInfo(tab, tab.cdpOk) });
			this.emit(conn, "Target.targetCreated", { targetInfo: this.pageInfo(tab, tab.cdpOk) });
		}
		// Clients already connected (autoAttach done) still need the attach
		// event once the fresh tab's renderer is debuggable — mirror the
		// setAutoAttach handler's wait so a tab created mid-session is
		// adoptable (browser.targets() only lists ATTACHED page targets).
		for (const conn of this.conns.values()) {
			if (!conn.autoAttach) continue;
			if (await tab.whenDebuggerReady()) this.emitTabAttached(conn, tab);
		}
	}

	announceTabDestroyed(tab) {
		for (const conn of this.conns.values()) {
			if (!conn.discover) continue;
			this.emit(conn, "Target.targetDestroyed", { targetId: tabTargetId(tab.id) });
			this.emit(conn, "Target.targetDestroyed", { targetId: pageTargetId(tab.id) });
		}
	}

	notifyLifecycle(tab) {
		for (const conn of this.conns.values()) {
			if (!conn.discover) continue;
			this.emit(conn, "Target.targetInfoChanged", { targetInfo: this.tabInfo(tab, tab.cdpOk) });
			this.emit(conn, "Target.targetInfoChanged", { targetInfo: this.pageInfo(tab, tab.cdpOk) });
		}
		this.emitState({});
	}

	tabInfo(tab, attached) {
		return {
			targetId: tabTargetId(tab.id),
			type: "tab",
			title: tab.title,
			url: tab.url || "about:blank",
			attached,
			canAccessOpener: false,
		};
	}

	pageInfo(tab, attached) {
		return {
			targetId: pageTargetId(tab.id),
			type: "page",
			title: tab.title,
			url: tab.url || "about:blank",
			attached,
			canAccessOpener: false,
		};
	}

	// ── CDP server (browser-level emulation, relay-bridge subset) ─────────

	async startServer() {
		// httpServer.listen() reports EADDRINUSE asynchronously via the
		// 'error' event — a try/catch around listen() can never see it, and
		// an http.Server cannot be re-listened after a failed bind. Each
		// candidate therefore gets a FRESH server with its own error
		// handler; the first one that actually binds wins. Without this, a
		// second GUI instance on the same machine (or a dev/test instance
		// next to the real one) crashed with an uncaught EADDRINUSE modal.
		for (let i = 0; i < MAX_PORT_TRIES; i++) {
			const candidate = DEFAULT_PORT + i;
			const httpServer = http.createServer((req, res) => {
				if (req.method === "GET" && (req.url === "/json/version" || req.url === "/json/version/")) {
					this.writeJson(res, {
						Browser: "Chrome/138.0.0.0 (MusePi managed)",
						"Protocol-Version": "1.3",
						"User-Agent": "MusePiManaged/1.0",
						webSocketDebuggerUrl: `ws://127.0.0.1:${candidate}/devtools/browser`,
					});
					return;
				}
				if (req.method === "GET" && (req.url === "/json" || req.url === "/json/list")) {
					const pages = [...this.tabs.values()]
						.filter((tab) => !INELIGIBLE_URL.test(tab.url))
						.map((tab) => ({
							description: "",
							devtoolsFrontendUrl: "",
							id: pageTargetId(tab.id),
							title: tab.title,
							type: "page",
							url: tab.url,
							webSocketDebuggerUrl: `ws://127.0.0.1:${candidate}/devtools/page/${pageTargetId(tab.id)}`,
						}));
					this.writeJson(res, pages);
					return;
				}
				res.writeHead(404);
				res.end("not found");
			});
			httpServer.on("upgrade", (req, socket) => {
				// Loopback only + reject browser Origins: a web page must never
				// drive the managed browser (relay server parity).
				const addr = socket.address();
				if (typeof addr === "object" && addr.address !== "127.0.0.1" && addr.address !== "::1") {
					socket.destroy();
					return;
				}
				if (req.headers.origin) {
					socket.destroy();
					return;
				}
				this.acceptWs(socket, req);
			});
			const bound = await new Promise((resolve) => {
				httpServer.once("error", () => resolve(false));
				httpServer.once("listening", () => resolve(true));
				httpServer.listen(candidate, "127.0.0.1");
			});
			if (bound) {
				this.port = candidate;
				this.server = httpServer;
				return candidate;
			}
			// Candidate busy — the failed server is dead; try the next one.
		}
		this.server = null;
		return null;
	}

	closeServer() {
		if (this.server) {
			try {
				this.server.close();
			} catch {
				// already closed
			}
			this.server = null;
		}
		for (const conn of [...this.conns.values()]) {
			try {
				conn.ws.close();
			} catch {
				// already closed
			}
		}
		this.conns.clear();
	}

	writeJson(res, payload) {
		res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
		res.end(JSON.stringify(payload));
	}

	acceptWs(socket, req) {
		const conn = {
			id: ++this.connSeq,
			socket,
			ws: null,
			sessions: new Map(),
			discover: false,
			autoAttach: false,
		};
		const headers = [
			"HTTP/1.1 101 Switching Protocols",
			"Upgrade: websocket",
			"Connection: Upgrade",
			`Sec-WebSocket-Accept: ${createHash("sha1")
				.update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
				.digest("base64")}`,
			"Sec-WebSocket-Version: 13",
		];
		socket.write(headers.join("\r\n") + "\r\n\r\n");
		conn.ws = socket;
		this.conns.set(conn.id, conn);
		const decoder = new WsFrameDecoder(
			(payload) => {
				const text = payload.toString("utf8");
				if (text.startsWith("{")) this.handleMessage(conn, text);
			},
			(opcode, payload) => {
				if (opcode === WS_OP_PING) {
					this.sendRaw(conn, Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
				} else if (opcode === WS_OP_CLOSE) {
					this.sendRaw(conn, Buffer.from([0x88, 0]));
					socket.destroy();
				}
				// pong frames are ignored
			},
		);
		socket.on("data", (chunk) => decoder.push(chunk));
		socket.on("close", () => this.handleClose(conn));
		socket.on("error", () => this.handleClose(conn));
		// The browser tool expects at least one page target on connect
		// (pickElectronTarget / browser.pages()); mirror a real Chrome that
		// always has a tab. The debugger attaches once the renderer is up
		// (whenDebuggerReady in the attach paths).
		this.ensureTab("about:blank", false);
	}

	handleClose(conn) {
		if (!this.conns.has(conn.id)) return;
		this.conns.delete(conn.id);
	}

	handleMessage(conn, raw) {
		let msg;
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}
		if (typeof msg.id !== "number" || typeof msg.method !== "string") return;
		void this.route(conn, msg).catch((error) => {
			this.replyError(conn, msg, error instanceof Error ? error.message : String(error));
		});
	}

	async route(conn, msg) {
		const sessionId = msg.sessionId;
		if (!sessionId) {
			await this.handleBrowserCommand(conn, msg);
			return;
		}
		const ref = conn.sessions.get(sessionId);
		if (!ref) {
			this.replyError(conn, msg, `Unknown session id ${sessionId}`);
			return;
		}
		if (ref.kind === "browser") {
			// Browser-target session (browser.target().createCDPSession()): commands
			// route exactly like browser-level ones; the sessionId is bookkeeping.
			await this.handleBrowserCommand(conn, msg);
			return;
		}
		const tab = this.tabs.get(String(ref.tabId));
		if (!tab) {
			this.replyError(conn, msg, `Tab ${ref.tabId} is gone`);
			return;
		}
		if (ref.kind === "tab") {
			this.handleTabSessionCommand(conn, msg, tab);
			return;
		}
		await this.forwardToPage(conn, msg, tab);
	}

	async handleBrowserCommand(conn, msg) {
		switch (msg.method) {
			case "Browser.getVersion":
				this.reply(conn, msg, {
					protocolVersion: "1.3",
					product: "Chrome/138.0.0.0 (MusePi managed)",
					revision: "",
					userAgent: "MusePiManaged/1.0",
					jsVersion: "",
				});
				return;
			case "Target.getBrowserContexts":
				this.reply(conn, msg, { browserContextIds: [] });
				return;
			case "Target.setDiscoverTargets":
				conn.discover = true;
				// The browser target first: puppeteer's TargetManager treats
				// type "browser" + attached as the connection root and needs
				// it to resolve `browser.target()`.
				this.emit(conn, "Target.targetCreated", { targetInfo: browserTargetInfo() });
				for (const tab of this.tabs.values()) {
					if (INELIGIBLE_URL.test(tab.url)) continue;
					this.emit(conn, "Target.targetCreated", { targetInfo: this.tabInfo(tab, tab.cdpOk) });
					this.emit(conn, "Target.targetCreated", { targetInfo: this.pageInfo(tab, tab.cdpOk) });
				}
				this.reply(conn, msg, {});
				return;
			case "Target.setAutoAttach": {
				conn.autoAttach = true;
				const tabs = [...this.tabs.values()].filter((tab) => !INELIGIBLE_URL.test(tab.url));
				for (const tab of tabs) {
					if (await tab.whenDebuggerReady()) this.emitTabAttached(conn, tab);
				}
				this.reply(conn, msg, {});
				return;
			}
			case "Target.getTargets": {
				const targetInfos = [browserTargetInfo()];
				for (const tab of this.tabs.values()) {
					if (INELIGIBLE_URL.test(tab.url)) continue;
					targetInfos.push(this.tabInfo(tab, tab.cdpOk));
					targetInfos.push(this.pageInfo(tab, tab.cdpOk));
				}
				this.reply(conn, msg, { targetInfos });
				return;
			}
			case "Target.attachToTarget": {
				const rawTargetId = typeof msg.params?.targetId === "string" ? msg.params.targetId : "";
				// Browser target: attach through the connection root (real
				// Chrome parity). Its commands route to handleBrowserCommand.
				if (rawTargetId === BROWSER_TARGET_ID) {
					const sessionId = this.mintSession(conn, "browser", null);
					this.emit(conn, "Target.attachedToTarget", {
						sessionId,
						targetInfo: browserTargetInfo(),
						waitingForDebugger: false,
					});
					this.reply(conn, msg, { sessionId });
					return;
				}
				const parsed = parseTargetId(rawTargetId);
				const tab = parsed ? this.tabs.get(String(parsed.tabId)) : undefined;
				if (!parsed || !tab) {
					this.replyError(conn, msg, `No target with id ${rawTargetId}`);
					return;
				}
				if (!(await tab.whenDebuggerReady())) {
					this.replyError(conn, msg, `Cannot attach to tab ${tab.id} (debugger unavailable)`);
					return;
				}
				const sessionId = this.mintSession(conn, parsed.kind, tab.id);
				const info = parsed.kind === "tab" ? this.tabInfo(tab, true) : this.pageInfo(tab, true);
				this.emit(conn, "Target.attachedToTarget", {
					sessionId,
					targetInfo: info,
					waitingForDebugger: false,
				});
				this.reply(conn, msg, { sessionId });
				return;
			}
			case "Target.detachFromTarget": {
				const sessionId = typeof msg.params?.sessionId === "string" ? msg.params.sessionId : undefined;
				if (sessionId) this.releaseSession(conn, sessionId);
				this.reply(conn, msg, {});
				return;
			}
			case "Target.createTarget": {
				const url =
					typeof msg.params?.url === "string" && msg.params.url.length > 0 ? msg.params.url : "about:blank";
				if (!(await this.gateAgentNavigation(url))) {
					this.replyError(conn, msg, "Navigation blocked by the user");
					return;
				}
				const tab = this.createTab(url, true);
				// The agent's working tab is the one it created last.
				this.agentTabId = String(tab.id);
				this.recordActivity(tab, "navigate", url, "dispatched");
				this.reply(conn, msg, { targetId: pageTargetId(tab.id) });
				return;
			}
			case "Target.closeTarget": {
				const parsed = typeof msg.params?.targetId === "string" ? parseTargetId(msg.params.targetId) : null;
				if (parsed) this.closeTab(String(parsed.tabId));
				this.reply(conn, msg, { success: true });
				return;
			}
			case "Target.activateTarget": {
				const parsed = typeof msg.params?.targetId === "string" ? parseTargetId(msg.params.targetId) : null;
				if (parsed) {
					const tab = this.tabs.get(String(parsed.tabId));
					if (tab) this.activateDisplayTab(tab);
				}
				this.reply(conn, msg, {});
				return;
			}
			case "Target.getTargetInfo": {
				const raw = typeof msg.params?.targetId === "string" ? msg.params.targetId : undefined;
				const parsed = raw ? parseTargetId(raw) : null;
				const tab = parsed ? this.tabs.get(String(parsed.tabId)) : undefined;
				this.reply(conn, msg, {
					targetInfo:
						raw === BROWSER_TARGET_ID
							? browserTargetInfo()
							: parsed && tab
								? parsed.kind === "tab"
									? this.tabInfo(tab, tab.cdpOk)
									: this.pageInfo(tab, tab.cdpOk)
								: { targetId: "managed-browser", type: "browser", title: "", url: "", attached: true, canAccessOpener: false },
				});
				return;
			}
			case "Browser.close":
				// Never close the app; acknowledge and ignore (relay parity).
				this.reply(conn, msg, {});
				return;
			case "Browser.setDownloadBehavior":
				this.reply(conn, msg, {});
				return;
			case "ManagedBrowser.ensureAgentTab": {
				// Daemon-side contract (tab-supervisor requestAgentTabTargetId):
				// return the DEDICATED agent tab's page target id, creating it
				// on first use so the agent never adopts the user's tab.
				const tab = this.ensureAgentTab();
				this.reply(conn, msg, { targetId: pageTargetId(tab.id) });
				return;
			}
			default:
				this.replyError(conn, msg, `'${msg.method}' wasn't found`, CDP_ERROR_METHOD_NOT_FOUND);
		}
	}

	/** Tab pseudo-sessions only exist to satisfy puppeteer's Target hierarchy. */
	handleTabSessionCommand(conn, msg, tab) {
		switch (msg.method) {
			case "Target.setAutoAttach": {
				// Emit before replying: puppeteer counts page children attached
				// before the setAutoAttach response resolves. The event MUST be
				// scoped to the TAB session (message-level sessionId) so puppeteer
				// resolves the tab's init — a browser-level event never finishes
				// its `#targetsIdsForInit`.
				const pageSession = this.mintSession(conn, "page", tab.id);
				this.emit(conn, "Target.attachedToTarget", {
					sessionId: pageSession,
					targetInfo: this.pageInfo(tab, true),
					waitingForDebugger: false,
				}, msg.sessionId);
				this.reply(conn, msg, {});
				return;
			}
			case "Runtime.runIfWaitingForDebugger":
				this.reply(conn, msg, {});
				return;
			case "Target.detachFromTarget": {
				const child = typeof msg.params?.sessionId === "string" ? msg.params.sessionId : undefined;
				if (child) this.releaseSession(conn, child);
				this.reply(conn, msg, {});
				return;
			}
			default:
				this.replyError(conn, msg, `'${msg.method}' is not supported on a tab target`, CDP_ERROR_METHOD_NOT_FOUND);
		}
	}

	async forwardToPage(conn, msg, tab) {
		if (msg.method === "Browser.close") {
			this.reply(conn, msg, {});
			return;
		}
		if (msg.method === "MusePi.claimTarget") {
			this.reply(conn, msg, {});
			return;
		}
		// Session-control commands MUST NOT reach the real webContents
		// debugger: Electron's single-session debugger has no child targets,
		// and a forwarded `Target.setAutoAttach` with waitForDebuggerOnStart
		// wedges it (every later command hangs). Answer locally — puppeteer
		// only sends these for OOPIF bookkeeping.
		if (msg.method === "Target.setAutoAttach" || msg.method === "Target.setDiscoverTargets") {
			this.reply(conn, msg, {});
			return;
		}
		if (msg.method === "Runtime.runIfWaitingForDebugger") {
			// We never pause targets; nothing to resume.
			this.reply(conn, msg, {});
			return;
		}
		if (msg.method === "Page.captureScreenshot") {
			// Electron's webContents debugger does not answer
			// Page.captureScreenshot (puppeteer's screenshot path times
			// out); capturePage() is the supported route (Proma parity).
			try {
				const image = await tab.view.webContents.capturePage();
				const params = msg.params ?? {};
				const format = params.format === "jpeg" ? "jpeg" : "png";
				const quality = typeof params.quality === "number" ? params.quality : 80;
				const buffer = format === "jpeg" ? image.toJPEG(quality) : image.toPNG();
				this.reply(conn, msg, { data: buffer.toString("base64") });
			} catch (error) {
				this.replyError(
					conn,
					msg,
					error instanceof Error ? error.message : String(error),
					typeof error?.code === "number" ? error.code : CDP_ERROR_SERVER,
				);
			}
			return;
		}
		if (!tab.ensureDebugger()) {
			this.replyError(conn, msg, "Managed tab debugger is unavailable (DevTools may be attached)");
			return;
		}
		// The CDP path is the agent's lane: record sanitized activity and
		// surface the panel when the agent drives a hidden tab.
		const activityAction = this.activityForMethod(msg.method);
		if (msg.method === "Page.navigate") {
			const navUrl = typeof msg.params?.url === "string" ? msg.params.url : "";
			if (!(await this.gateAgentNavigation(navUrl))) {
				this.recordActivity(tab, "navigate", navUrl, "canceled");
				this.replyError(conn, msg, "Navigation blocked by the user");
				return;
			}
		}
		if (activityAction) {
			this.recordActivity(tab, activityAction, tab.url, "dispatched");
			if (!tab.visible) this.emitState({ agentActivity: true });
		}
		try {
			const result = (await tab.view.webContents.debugger.sendCommand(msg.method, msg.params)) ?? {};
			// Detach (e.g. a stopOp tab close) resolves pending commands instead
			// of rejecting — do not overwrite the canceled mark the stop applied.
			if (this.tabs.has(String(tab.id))) this.markOpStatus(String(tab.id), "completed");
			this.reply(conn, msg, result);
		} catch (error) {
			this.markOpStatus(String(tab.id), "failed");
			this.replyError(
				conn,
				msg,
				error instanceof Error ? error.message : String(error),
				typeof error?.code === "number" ? error.code : CDP_ERROR_SERVER,
			);
		}
	}

	/** CDP page method → sanitized ledger action (never page text/scripts). */
	activityForMethod(method) {
		switch (method) {
			case "Page.navigate":
				return "navigate";
			case "Page.captureScreenshot":
				return "screenshot";
			case "Accessibility.getFullAXTree":
			case "Accessibility.getPartialAXTree":
				return "observe";
			case "Input.dispatchMouseEvent":
				return "click";
			case "Input.insertText":
			case "Input.dispatchKeyEvent":
				return "fill";
			case "Runtime.evaluate":
			case "Runtime.callFunctionOn":
				return "evaluate";
			default:
				return null;
		}
	}

	/** Debugger event from one tab → fan out to every page session on it. */
	onCdpEvent(tab, method, params) {
		if (method === "Target.attachedToTarget") {
			// OOPIF children of the managed view: nothing to multiplex — the
			// webContents debugger exposes a single session.
			return;
		}
		for (const conn of this.conns.values()) {
			for (const [sessionId, ref] of conn.sessions) {
				if (ref.kind === "page" && ref.tabId === tab.id) {
					this.send(conn, JSON.stringify({ sessionId, method, params }));
				}
			}
		}
	}

	// ── session bookkeeping ──────────────────────────────────────────────

	mintSession(conn, kind, tabId) {
		const sessionId = `s${++this.sessionSeq}`;
		conn.sessions.set(sessionId, { kind, tabId });
		return sessionId;
	}

	releaseSession(conn, sessionId) {
		conn.sessions.delete(sessionId);
	}

	emitTabAttached(conn, tab) {
		for (const ref of conn.sessions.values()) {
			if (ref.kind === "tab" && ref.tabId === tab.id) return;
		}
		const sessionId = this.mintSession(conn, "tab", tab.id);
		this.emit(conn, "Target.attachedToTarget", {
			sessionId,
			targetInfo: this.tabInfo(tab, true),
			waitingForDebugger: false,
		});
	}

	emit(conn, method, params, sessionId) {
		const payload = sessionId ? { sessionId, method, params } : { method, params };
		this.send(conn, JSON.stringify(payload));
	}

	reply(conn, msg, result) {
		this.send(conn, JSON.stringify({ id: msg.id, result }));
	}

	replyError(conn, msg, message, code = CDP_ERROR_SERVER) {
		this.send(conn, JSON.stringify({ id: msg.id, error: { code, message } }));
	}

	send(conn, payload) {
		try {
			conn.ws.write(encodeWsFrame(Buffer.from(payload)));
		} catch {
			// socket closed
		}
	}

	sendRaw(conn, frame) {
		try {
			conn.ws.write(frame);
		} catch {
			// socket closed
		}
	}

	// ── IPC (renderer projection + controls) ─────────────────────────────

	registerIpc() {
		ipcMain.handle("managed-browser:open", () => {
			this.ensureTab("about:blank", false);
			return this.state();
		});
		ipcMain.handle("managed-browser:close", () => {
			this.closeAll();
			return {};
		});
		ipcMain.handle("managed-browser:get-state", () => this.state());
		ipcMain.handle("managed-browser:set-layout", (_e, layout) => {
			this.applyLayout(layout ?? {});
			return {};
		});
		ipcMain.handle("managed-browser:navigate", async (_e, input) => {
			const tab = this.ensureTab();
			if (!tab) return { ok: false, error: "browser window unavailable" };
			const result = await tab.navigate(input?.url ?? "");
			// Do NOT record user-initiated navigation into the agent activity
			// ledger — that ledger is the agent's browser lane (user: 浏览器里
			// 多出个无法点击的 agent 行). Agent navs go through the CDP path.
			this.emitState({});
			return result;
		});
		ipcMain.handle("managed-browser:go-back", async () => {
			const tab = this.tabs.get(this.activeTabId);
			if (tab) await tab.goBack();
			return {};
		});
		ipcMain.handle("managed-browser:go-forward", async () => {
			const tab = this.tabs.get(this.activeTabId);
			if (tab) await tab.goForward();
			return {};
		});
		ipcMain.handle("managed-browser:reload", async () => {
			const tab = this.tabs.get(this.activeTabId);
			if (tab) await tab.reload();
			return {};
		});
		ipcMain.handle("managed-browser:reload-hard", async () => {
			const tab = this.tabs.get(this.activeTabId);
			if (tab) await tab.hardReload();
			return {};
		});
		ipcMain.handle("managed-browser:clear-data", (_e, input) =>
			this.clearBrowserData(input?.mode),
		);
		ipcMain.handle("managed-browser:open-external", (_e, input) =>
			this.openExternal(input?.url),
		);
		ipcMain.handle("managed-browser:pick-element", async () => {
			const tab = this.tabs.get(this.activeTabId);
			if (!tab) return { cancelled: true };
			return tab.pickElement();
		});
		ipcMain.handle("managed-browser:new-tab", () => {
			this.createTab("about:blank", false);
			return this.state();
		});
		ipcMain.handle("managed-browser:select-tab", (_e, tabId) => this.selectTab(tabId));
		ipcMain.handle("managed-browser:close-tab", (_e, tabId) => this.closeTab(tabId));
		ipcMain.handle("managed-browser:stop", (_e, tabId) => this.stopOp(tabId));
		ipcMain.handle("managed-browser:confirm-result", (_e, input) => {
			const pending = this.pendingConfirm;
			if (!pending || !input || pending.requestId !== input.requestId) return { ok: false };
			clearTimeout(pending.timer);
			this.pendingConfirm = null;
			pending.resolve(Boolean(input.allow));
			return { ok: true };
		});
	}
}

module.exports = { ManagedBrowserController, DEFAULT_PORT };
