/**
 * Managed in-app browser (Proma 吸收, browser-controller.ts + browser-policy).
 *
 * The desktop GUI's right-pane browser is the SAME instance the agent
 * drives, but the page itself is a DOM `<webview>` guest owned by the
 * renderer:
 *
 * - The renderer mounts one `<webview>` per tab on an Electron-managed
 *   partition (`persist:musepi-managed-browser`), so login state survives
 *   restarts and is shared between the user and the agent — one instance,
 *   two operators. Because the guest is a DOM element, menus, tooltips,
 *   drag handles and overlays layer normally over it (no more "native view
 *   always above the DOM").
 * - Main keeps what the renderer cannot own: the partition policy (deny-all
 *   permissions, `omp-file://` previews), the CDP bridge, and the sanitized
 *   activity ledger. A loopback HTTP+WS server impersonates Chrome's CDP
 *   discovery endpoint (the relay bridge's emulation, minus
 *   extension/grouping machinery) so the browser tool's `connected` kind
 *   (`browser.gui` setting) attaches via plain
 *   `puppeteer.connect({ browserURL })` and drives the same guests the user
 *   sees. Guests are bound by webContents id; CDP never leaves main.
 * - Renderer → main: guest lifecycle (`guest-ready` / `guest-gone`), active
 *   tab, panel visibility. Main → renderer: `create-tab` / `select-tab` /
 *   `close-tab` (CDP-driven), consent prompts, projected state.
 *
 * Safety: loopback-only bind, ws Origin rejected (a web page cannot drive
 * the managed browser), permission requests denied outright, URL bar
 * navigation restricted to http/https, navigation state redacted of URL
 * credentials, and a sanitized activity ledger (never page text, cookies or
 * script source).
 */
"use strict";

const { ipcMain, net, protocol, session: electronSession, webContents } = require("electron");
const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createHash } = require("node:crypto");

const DEFAULT_PORT = Number(process.env.MUSEPI_MANAGED_BROWSER_PORT || 9230);
const MAX_PORT_TRIES = 10;
const PARTITION = "persist:musepi-managed-browser";
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
/** Renderer guest-attach deadline for a main-initiated tab (10s renderer-side
 *  attach timeout + margin); a miss fails the CDP call instead of hanging. */
const GUEST_READY_TIMEOUT_MS = 15_000;
/** capturePage() never settles for an uncomposited guest — cap the wait. */
const CAPTURE_TIMEOUT_MS = 1_500;
/** Gap before the single screenshot retry (cold guest first-frame miss). */
const CAPTURE_RETRY_MS = 220;

/** Agent-action highlight lifetime (proma parity: a blue box on the element
 *  the agent is about to act on, cleared automatically). */
const AGENT_HIGHLIGHT_MS = 900;
/** Translucent fill + border drawn by Blink's inspector overlay — nothing is
 *  injected into the page. */
const AGENT_HIGHLIGHT_CONFIG = {
	contentColor: { r: 59, g: 130, b: 246, a: 0.16 },
	borderColor: { r: 59, g: 130, b: 246, a: 0.95 },
	showInfo: false,
};

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
const WS_OP_BINARY = 0x2;
const WS_OP_CLOSE = 0x8;
const WS_OP_PING = 0x9;
const WS_OP_PONG = 0xa;
/** WebSocket continuation frame (opcode 0x0): payload fragments of a
 *  split TEXT or BINARY message. */
const WS_OP_CONTINUATION = 0x0;

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
			if (frame.opcode === WS_OP_TEXT || frame.opcode === WS_OP_CONTINUATION) {
				this.fragment = this.fragment === null ? frame.payload : Buffer.concat([this.fragment, frame.payload]);
				if (frame.fin) {
					const complete = this.fragment;
					this.fragment = null;
					this.onMessage(complete);
				}
			} else if (frame.opcode === WS_OP_BINARY) {
				// Binary frames not expected on the CDP bridge; pass through
				// as complete messages (binary CDP payloads are rare).
				this.onMessage(frame.payload);
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

/** Reverse of tabTargetId/pageTargetId; null for foreign ids.
 *
 *  Tab ids are opaque: main mints numeric ones for tabs it creates (agent
 *  lanes) and adopts the renderer's own ids (`local-N`) for tabs the user
 *  opened — the id only has to round-trip through `this.tabs`. */
function parseTargetId(targetId) {
	const match = /^(TAB|PAGE)(.+)$/.exec(String(targetId));
	if (!match) return null;
	return { kind: match[1] === "TAB" ? "tab" : "page", tabId: match[2] };
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

/** Minimal deferred (`Promise.withResolvers()` without a runtime floor). */
function deferred() {
	let resolve;
	const promise = new Promise((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/**
 * Device identity for the pane's viewport presets.
 *
 * Identity, not layout: the pane already sizes the box to the preset, but a
 * phone-width box leaves UA-sniffing sites on their desktop document
 * (measured: bing.com at 393px, desktop UA), so a preset has to carry a
 * device user agent (plus client hints and touch) — which only main can
 * apply, on the guest's debugger session.
 */
function deviceIdentity(preset) {
	if (preset !== "phone" && preset !== "tablet") return null;
	const mobile = preset === "phone";
	return {
		mobile,
		model: mobile ? "Pixel 8" : "Pixel Tablet",
		platformVersion: mobile ? "14.0.0" : "13.0.0",
		android: mobile ? "Android 14" : "Android 13",
	};
}

function deviceUserAgent(identity, chromeMajor) {
	const mobileToken = identity.mobile ? "Mobile " : "";
	return `Mozilla/5.0 (Linux; ${identity.android}; ${identity.model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 ${mobileToken}Safari/537.36`;
}

/** Client hints: sites increasingly read `Sec-CH-UA-*` / `userAgentData`
 *  instead of the UA string, so the override has to carry the same identity. */
function deviceUserAgentMetadata(identity, chromeMajor) {
	const version = `${chromeMajor}.0.0.0`;
	return {
		brands: [
			{ brand: "Chromium", version: chromeMajor },
			{ brand: "Google Chrome", version: chromeMajor },
		],
		fullVersionList: [
			{ brand: "Chromium", version },
			{ brand: "Google Chrome", version },
		],
		fullVersion: version,
		platform: "Android",
		platformVersion: identity.platformVersion,
		architecture: "",
		model: identity.model,
		mobile: identity.mobile,
	};
}

/** The engine's own Chromium major, so the emulated UA stays consistent with
 *  the renderer behind it (feature detection then agrees with the UA). */
function chromeMajorVersion() {
	const major = String(process.versions.chrome ?? "").split(".")[0];
	return major === "" ? "130" : major;
}

/** Where an agent action lands, when it is worth flashing. Press only: the
 *  matching release carries the same point, and a hover probe would flash
 *  constantly. */
function agentHighlightPoint(method, params) {
	if (method !== "Input.dispatchMouseEvent" || params?.type !== "mousePressed") return null;
	if (typeof params.x !== "number" || typeof params.y !== "number") return null;
	return { x: params.x, y: params.y };
}

/**
 * One managed tab: metadata + the renderer-owned `<webview>` guest it binds
 * to once the renderer reports the element attached (`guest-ready`). Main
 * never owns the view — only the guest webContents' CDP debugger session and
 * the partition policy that governs it.
 */
class ManagedTab {
	constructor(controller, url, openedByAgent, explicitId) {
		this.controller = controller;
		/** Opaque tab id: main mints numeric ones for the tabs it creates
		 *  (agent lanes, prewarm), the renderer's own (`local-N`) for tabs the
		 *  user opened. It only has to round-trip through `tabs`. */
		this.id = explicitId ?? ++controller.tabSeq;
		this.openedByAgent = openedByAgent;
		this.url = "about:blank";
		this.title = "";
		this.loading = false;
		/** Guest webContents; null until the renderer's element attaches. */
		this.wc = null;
		/** Guest-ready handshake: resolves with this tab on bind, null when the
		 *  tab dies (or is disposed) first. */
		this.guestReady = deferred();
		/** CDP debugger attached (lazily, after the initial load finishes). */
		this.cdpOk = false;
		/** Device preset currently applied to the guest (null = engine default). */
		this.devicePreset = null;
		/** Pending agent-highlight auto-hide. */
		this.highlightTimer = null;
	}

	/**
	 * Bind the renderer's guest. The session check is the security boundary:
	 * a webContents outside the managed partition must never join the CDP
	 * bridge (the renderer could otherwise hand us an arbitrary guest).
	 */
	bindGuest(wc) {
		if (!wc || wc.isDestroyed()) return false;
		if (wc.session !== electronSession.fromPartition(PARTITION)) return false;
		if (this.wc && this.wc !== wc) this.detachDebugger();
		this.wc = wc;
		wc.setWindowOpenHandler(({ url: targetUrl }) => {
			// target=_blank / window.open become managed tabs instead of
			// escaping the app (deny would silently drop user clicks).
			// User-initiated opens (window.open via click) are NOT agent tabs;
			// only Target.createTarget from the CDP side sets openedByAgent=true.
			if (/^https?:/i.test(targetUrl)) {
				void this.controller.createTab(targetUrl, false).catch(() => {});
			}
			return { action: "deny" };
		});
		wc.on("will-navigate", (event, targetUrl) => {
			if (!/^https?:/i.test(targetUrl)) event.preventDefault();
		});
		wc.on("did-start-loading", () => {
			this.loading = true;
			this.refreshState();
			this.controller.notifyLifecycle(this);
		});
		wc.on("did-stop-loading", () => {
			this.loading = false;
			this.refreshState();
			this.controller.notifyLifecycle(this);
			this.controller.markActivityComplete(this);
		});
		wc.on("did-navigate", (_e, targetUrl) => {
			this.refreshState(targetUrl);
			this.controller.notifyLifecycle(this);
		});
		wc.on("did-navigate-in-page", (_e, targetUrl) => {
			this.refreshState(targetUrl);
			this.controller.notifyLifecycle(this);
		});
		wc.on("page-title-updated", (_e, title) => {
			this.title = title;
			this.controller.notifyLifecycle(this);
		});
		wc.on("destroyed", () => {
			this.guestReady.resolve(null);
			this.controller.handleTabDestroyed(this);
		});
		// CDP: the debugger is attached LAZILY after the renderer finishes its
		// initial load (attaching to a booting renderer wedges it — every
		// command hangs until a navigation). whenDebuggerReady() bridges the
		// remaining race for clients that attach mid-load.
		wc.once("did-finish-load", () => this.ensureDebugger());
		// `did-attach` can reach main after a fast local page already
		// finished loading — attach now instead of waiting for an event that
		// will never fire again.
		if (!wc.isLoading()) this.ensureDebugger();
		this.refreshState();
		this.guestReady.resolve(this);
		return true;
	}

	/** Attach the CDP debugger on demand; true once commands can flow. */
	ensureDebugger() {
		if (this.cdpOk) return true;
		const wc = this.wc;
		if (!wc || wc.isDestroyed()) return false;
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

	detachDebugger() {
		const wc = this.wc;
		if (wc && !wc.isDestroyed()) {
			try {
				if (wc.debugger.isAttached()) wc.debugger.detach();
			} catch {
				// already detached
			}
		}
		this.cdpOk = false;
	}

	/** True once the renderer's guest is bound (waits out the attach report). */
	async waitForGuest(timeoutMs = GUEST_READY_TIMEOUT_MS) {
		if (this.wc && !this.wc.isDestroyed()) return true;
		let timer;
		try {
			const bound = await Promise.race([
				this.guestReady.promise.then((tab) => tab !== null),
				new Promise((resolve) => {
					timer = setTimeout(() => resolve(false), timeoutMs);
				}),
			]);
			return bound === true && this.wc !== null && !this.wc.isDestroyed();
		} finally {
			clearTimeout(timer);
		}
	}

	/** Resolve once the debugger is attachable (waits out the initial load). */
	async whenDebuggerReady(timeoutMs = 4000) {
		if (this.cdpOk) return true;
		if ((!this.wc || this.wc.isDestroyed()) && !(await this.waitForGuest(timeoutMs))) return false;
		const wc = this.wc;
		if (!wc || wc.isDestroyed()) return false;
		if (!wc.isLoading()) {
			this.ensureDebugger();
			return this.cdpOk;
		}
		return await new Promise((resolve) => {
			const done = () => {
				clearTimeout(timer);
				wc.removeListener("did-finish-load", done);
				this.ensureDebugger();
				resolve(this.cdpOk);
			};
			const timer = setTimeout(done, timeoutMs);
			wc.once("did-finish-load", done);
		});
	}

	refreshState(navigatedUrl) {
		const wc = this.wc;
		if (!wc || wc.isDestroyed()) return;
		if (navigatedUrl) this.url = redactUrl(navigatedUrl);
		else this.url = redactUrl(wc.getURL()) || this.url;
		this.title = wc.getTitle() || this.title;
	}

	async navigate(url) {
		const target = normalizeAddressBarUrl(url);
		if (!target) return { ok: false, error: "Only http/https or omp-file:// URLs are allowed" };
		const wc = this.wc;
		if (!wc || wc.isDestroyed()) return { ok: false, error: "browser tab is not ready" };
		try {
			await wc.loadURL(target);
			return { ok: true, url: target };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// ERR_ABORTED (-3) is not a failure: the load was superseded (redirect
			// chain, a newer navigation winning) and the page IS loading. Reporting
			// it put a red banner over a perfectly good page.
			if (/ERR_ABORTED/.test(message)) return { ok: true, url: target };
			return { ok: false, error: message };
		}
	}

	/** Release the guest. The renderer unmounts its element on the matching
	 *  `close-tab` push; closing here also covers tabs whose renderer is gone. */
	dispose() {
		this.guestReady.resolve(null);
		clearTimeout(this.highlightTimer);
		this.highlightTimer = null;
		this.detachDebugger();
		const wc = this.wc;
		this.wc = null;
		if (wc && !wc.isDestroyed()) {
			try {
				wc.close();
			} catch {
				// already closing
			}
		}
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
		/** IPC handlers registered (start is re-entrant — see start()). */
		this.ipcRegistered = false;
		this.sessionSeq = 0;
		this.ledger = [];
		this.server = null;
		this.port = DEFAULT_PORT;
		this.partitionGuarded = false;
		/** Renderer-reported browser-pane visibility (agent activity on a
		 *  hidden tab must surface the pane). */
		this.panelVisible = false;
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
	 * close), and the old owner stays destroyed — a stale `this.owner` made
	 * the old native-view code throw "Object has been destroyed" (the
	 * managed-browser:navigate crash the user hit). Same window: no-op; a
	 * different window drops the old tab records and re-arms the handlers.
	 */
	setOwner(ownerWindow) {
		if (this.owner === ownerWindow) return;
		this.releaseTabs();
		this.owner = ownerWindow;
		this.owner.on("closed", () => {
			this.releaseTabs();
			this.closeServer();
		});
		// A main-frame load replaces the whole renderer: every guest is a DOM
		// element of the page being torn down, so the old records can never
		// bind again. Reset before the fresh page reports its restored tabs
		// (`guest-ready` then rebuilds clean records with live guests).
		this.owner.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
			if (isMainFrame && !isInPlace) this.releaseTabs();
		});
	}

	/** Drop every tab record without renderer pushes — the owner window (and
	 *  with it every guest) is gone, so there is nobody left to notify. */
	releaseTabs() {
		for (const tab of [...this.tabs.values()]) tab.dispose();
		this.tabs.clear();
		this.activeTabId = null;
		this.agentTabId = null;
	}

	async start(ownerWindow) {
		this.setOwner(ownerWindow);
		this.guardPartition();
		this.registerIpc();
		// Re-entrant by design: a second boot in the same process (window
		// recreation, a relaunch hook) must not re-register the IPC channels —
		// Electron throws on a duplicate channel, and that rejection used to
		// abort start() BEFORE the bridge existed. Measured symptom: the CDP
		// port never bound, every pane call answered "unknown tab", and agent
		// browsing had no lane at all.
		if (this.server) return this.port;
		await this.startServer();
		if (this.port === null) console.warn("[managed-browser] CDP bridge could not bind any port 9230-9239");
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

	/** Create a tab: mint the record, ask the renderer to mount the guest,
	 *  then wait for its `guest-ready` report. Resolves to null when the tab
	 *  could not be created (no owner, guest never attached) — callers turn
	 *  that into a CDP error rather than a silent no-op. */
	async createTab(url = "about:blank", openedByAgent = false) {
		if (!this.owner || this.owner.isDestroyed()) return null;
		const tab = new ManagedTab(this, url, openedByAgent);
		const id = String(tab.id);
		this.tabs.set(id, tab);
		if (!this.activeTabId) this.activeTabId = id;
		this.recordActivity(tab, "open", url, "opened");
		this.sendToRenderer("managed-browser:create-tab", { tabId: id, url });
		// The agent's work must stay visible: creating an agent tab selects it
		// (and pushes agentActivity so the closed pane re-opens).
		if (openedByAgent) this.selectTab(id, { agentActivity: true });
		else this.emitState({});
		if (!(await tab.waitForGuest())) {
			// No guest ever attached: drop the record so `/json/list` and
			// Target.* never advertise a target that cannot be driven.
			tab.dispose();
			this.handleTabDestroyed(tab);
			return null;
		}
		void this.announceTabCreated(tab);
		return tab;
	}

	/** The dedicated agent tab; creates it on first use. */
	async ensureAgentTab() {
		const existing = this.agentTabId ? this.tabs.get(this.agentTabId) : null;
		if (existing) return existing;
		const tab = await this.createTab("about:blank", true);
		if (!tab) return null;
		this.agentTabId = String(tab.id);
		return tab;
	}

	async ensureTab(url = "about:blank", openedByAgent = false) {
		if (!this.owner || this.owner.isDestroyed()) return null;
		if (this.tabs.size > 0) return this.tabs.get(this.activeTabId) ?? null;
		return await this.createTab(url, openedByAgent);
	}

	/**
	 * Renderer reports a mounted guest (`did-attach`). Binds it, or adopts
	 * the tab id outright — tabs the user opened are minted renderer-side
	 * (`local-N`) and main only ever learns about them here.
	 */
	handleGuestReady(input) {
		const tabId = typeof input?.tabId === "string" && input.tabId ? input.tabId : null;
		const webContentsId = Number(input?.webContentsId);
		if (!tabId || !Number.isInteger(webContentsId)) return { ok: false };
		const wc = webContents.fromId(webContentsId);
		if (!wc) return { ok: false };
		let tab = this.tabs.get(tabId);
		const adopted = !tab;
		if (!tab) {
			tab = new ManagedTab(this, "about:blank", false, tabId);
			this.tabs.set(tabId, tab);
			if (!this.activeTabId) this.activeTabId = tabId;
		}
		if (!tab.bindGuest(wc)) {
			// Foreign partition — never bridge an arbitrary guest into CDP.
			if (adopted) {
				this.tabs.delete(tabId);
				if (this.activeTabId === tabId) this.activeTabId = null;
			}
			return { ok: false };
		}
		if (adopted) void this.announceTabCreated(tab);
		return { ok: true };
	}

	/** Renderer reports a guest gone (element unmounted, crash, tab closed):
	 *  drop the record, its CDP targets and its ledger rows. */
	handleGuestGone(tabId) {
		const id = String(tabId ?? "");
		const tab = this.tabs.get(id);
		if (tab) {
			tab.dispose();
			this.handleTabDestroyed(tab);
		}
		if (this.ledger.some((entry) => entry.tabId === id)) {
			this.ledger = this.ledger.filter((entry) => entry.tabId !== id);
			this.emitState({});
		}
		return { ok: true };
	}

	handleTabDestroyed(tab) {
		const id = String(tab.id);
		if (!this.tabs.has(id)) return;
		this.tabs.delete(id);
		if (this.agentTabId === id) this.agentTabId = null;
		if (this.activeTabId === id) {
			const next = [...this.tabs.values()][0];
			this.activeTabId = next ? String(next.id) : null;
		}
		this.announceTabDestroyed(tab);
		this.emitState({});
	}

	/** Make `tabId` the active tab (CDP `Target.activateTarget`, new agent
	 *  tabs). The renderer owns selection; this pushes the intent to it. */
	selectTab(tabId, extra) {
		const tab = this.tabs.get(String(tabId));
		if (!tab) return null;
		const id = String(tab.id);
		this.activeTabId = id;
		this.sendToRenderer("managed-browser:select-tab", { tabId: id });
		this.emitState(extra ?? {});
		return this.state();
	}

	/** Close a tab (CDP `Target.closeTarget`, stopOp). The renderer unmounts
	 *  the element on the push; closing the guest here also covers a renderer
	 *  that is already gone. */
	closeTab(tabId) {
		const tab = this.tabs.get(String(tabId));
		if (!tab) return null;
		this.sendToRenderer("managed-browser:close-tab", { tabId: String(tab.id) });
		tab.dispose();
		this.handleTabDestroyed(tab);
		return this.state();
	}

	closeAll() {
		for (const tab of [...this.tabs.values()]) {
			this.sendToRenderer("managed-browser:close-tab", { tabId: String(tab.id) });
			tab.dispose();
			this.announceTabDestroyed(tab);
		}
		this.tabs.clear();
		this.activeTabId = null;
		this.agentTabId = null;
		this.emitState({});
	}

	// ── renderer-facing state ────────────────────────────────────────────

	/** Projected state: the CDP port and the ledger's latest entry. Tab
	 *  metadata stays in the renderer — it owns the elements. */
	state() {
		return {
			port: this.server ? this.port : null,
			activity: this.ledger[this.ledger.length - 1] ?? null,
		};
	}

	emitState(extra) {
		this.sendToRenderer("managed-browser:state", { ...this.state(), ...extra });
	}

	sendToRenderer(channel, payload) {
		if (!this.owner || this.owner.isDestroyed()) return;
		this.owner.webContents.send(channel, payload);
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
		const wc = tab.wc;
		if (wc && !wc.isDestroyed()) {
			try {
				wc.stop();
			} catch {
				// already stopped/destroyed
			}
		}
		// Mark before closing: the close path drops the tab record and its
		// ledger rows, so a terminal status must land on the entry first.
		this.markOpStatus(String(tab.id), "canceled");
		if (tab.openedByAgent) this.closeTab(String(tab.id));
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
		// always has a tab. The renderer mounts the guest and reports back —
		// a miss is not fatal (the agent lane creates its own tab through
		// ManagedBrowser.ensureAgentTab) but must not pass silently.
		void this.ensureTab("about:blank", false).catch((error) => {
			console.warn(
				"[managed-browser] prewarm tab failed:",
				error instanceof Error ? error.message : error,
			);
		});
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
				const tab = await this.createTab(url, true);
				if (!tab) {
					this.replyError(conn, msg, "The managed browser did not provide a tab");
					return;
				}
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
				if (parsed) this.selectTab(String(parsed.tabId));
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
				const tab = await this.ensureAgentTab();
				if (!tab) {
					this.replyError(conn, msg, "The managed browser did not provide an agent tab");
					return;
				}
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
			// On a guest with no composited surface it never settles, and a
			// freshly attached guest can miss its first frame — so the wait is
			// capped AND retried once: puppeteer still gets an error instead of
			// hanging, but a cold-start screenshot succeeds.
			const wc = tab.wc;
			if (!wc || wc.isDestroyed()) {
				this.replyError(conn, msg, "Managed tab is not attached");
				return;
			}
			let image = null;
			let lastError = null;
			for (let attempt = 0; attempt < 2 && image === null; attempt++) {
				let timer;
				try {
					image = await Promise.race([
						wc.capturePage(),
						new Promise((_resolve, reject) => {
							timer = setTimeout(
								() => reject(new Error("Page.captureScreenshot timed out (no composited surface)")),
								CAPTURE_TIMEOUT_MS,
							);
						}),
					]);
				} catch (error) {
					lastError = error;
					await new Promise((resolve) => setTimeout(resolve, CAPTURE_RETRY_MS));
				} finally {
					clearTimeout(timer);
				}
			}
			if (image === null) {
				this.replyError(
					conn,
					msg,
					lastError instanceof Error ? lastError.message : String(lastError),
					typeof lastError?.code === "number" ? lastError.code : CDP_ERROR_SERVER,
				);
				return;
			}
			const params = msg.params ?? {};
			const format = params.format === "jpeg" ? "jpeg" : "png";
			const quality = typeof params.quality === "number" ? params.quality : 80;
			const buffer = format === "jpeg" ? image.toJPEG(quality) : image.toPNG();
			this.reply(conn, msg, { data: buffer.toString("base64") });
			return;
		}
		if (!tab.ensureDebugger()) {
			this.replyError(conn, msg, "Managed tab debugger is unavailable (DevTools may be attached)");
			return;
		}
		const wc = tab.wc;
		if (!wc || wc.isDestroyed()) {
			this.replyError(conn, msg, "Managed tab is not attached");
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
			if (!this.panelVisible) this.emitState({ agentActivity: true });
		}
		const highlightPoint = agentHighlightPoint(msg.method, msg.params);
		if (highlightPoint) this.flashAgentTarget(tab, highlightPoint);
		try {
			const result = (await wc.debugger.sendCommand(msg.method, msg.params)) ?? {};
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
			case "Input.dispatchKeyEvent":
				return "fill";
			case "Runtime.evaluate":
			case "Runtime.callFunctionOn":
				return "evaluate";
			default:
				return null;
		}
	}

	/**
	 * Apply (or clear) a device-identity preset on one tab's guest.
	 *
	 * `reload` re-requests the page so it re-serves under the new identity; the
	 * renderer sends it only when the preset itself changed, so switching tabs
	 * re-applies silently instead of reloading a page the user just opened.
	 */
	async applyDevicePreset(tabId, preset, reload, viewport) {
		const tab = this.tabs.get(String(tabId));
		if (!tab) return { ok: false, error: "unknown tab" };
		if (!(await tab.whenDebuggerReady())) return { ok: false, error: "browser tab is not ready" };
		const wc = tab.wc;
		if (!wc || wc.isDestroyed()) return { ok: false, error: "browser tab is not ready" };
		const identity = deviceIdentity(preset);
		const changed = tab.devicePreset !== preset;
		try {
			// Layout size first. The guest's viewport has to be the PRESET's, not
			// the element's: the host is transform-scaled to fit the pane, and a
			// scaled element shrinks the guest's viewport with it (measured: a
			// 1440-wide host under scale(0.227) left the page a 327px viewport,
			// so every wide preset only zoomed the desktop layout out instead of
			// giving it room). Emulating the viewport is the reliable lever, and
			// it is also what makes the page's own viewport meta behave.
			const size = viewport && Number.isFinite(viewport.width) ? { width: Math.round(viewport.width), height: Math.round(viewport.height) } : null;
			if (size && size.width > 0 && size.height > 0) {
				await wc.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
					width: size.width,
					height: size.height,
					deviceScaleFactor: 0,
					mobile: identity !== null,
				});
			} else {
				await wc.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
			}
			if (identity) {
				const major = chromeMajorVersion();
				await wc.debugger.sendCommand("Emulation.setUserAgentOverride", {
					userAgent: deviceUserAgent(identity, major),
					acceptLanguage: "",
					platform: "Android",
					userAgentMetadata: deviceUserAgentMetadata(identity, major),
				});
				await wc.debugger.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
			} else {
				// An empty userAgent clears the override: Chromium's emulation
				// agent resets to the engine's own identity AND client hints.
				// The metadata argument must be OMITTED here rather than passed
				// as null — the CDP parser rejects a null object, and the whole
				// clear then fails silently, leaving the page on the phone UA.
				await wc.debugger.sendCommand("Emulation.setUserAgentOverride", { userAgent: "" });
				await wc.debugger.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: false });
			}
			tab.devicePreset = preset;
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		if (reload && changed) {
			try {
				wc.reload();
			} catch {
				// a reload racing a navigation is not a failure
			}
		}
		return { ok: true };
	}

	/**
	 * Flash the element an agent action is about to hit (proma parity): a user
	 * watching the panel sees WHERE the click lands. Drawn through Blink's
	 * inspector overlay (Overlay domain) — nothing is injected into the page —
	 * and a second action moves the box instead of stacking highlights.
	 * Best effort by construction: a failed highlight must never fail the
	 * agent's action.
	 */
	flashAgentTarget(tab, point) {
		const wc = tab.wc;
		if (!wc || wc.isDestroyed()) return;
		void (async () => {
			try {
				// DOM.getNodeForLocation needs the DOM domain on THIS debugger
				// session — the agent's connection is its own session, so the
				// renderer lane enabling it does not carry over.
				await wc.debugger.sendCommand("DOM.enable");
				const node = await wc.debugger.sendCommand("DOM.getNodeForLocation", {
					x: Math.round(point.x),
					y: Math.round(point.y),
					includeUserAgentShadowDOM: false,
				});
				const { backendNodeId } = node ?? {};
				if (typeof backendNodeId !== "number") return;
				await wc.debugger.sendCommand("Overlay.enable");
				await wc.debugger.sendCommand("Overlay.highlightNode", {
					backendNodeId,
					highlightConfig: AGENT_HIGHLIGHT_CONFIG,
				});
				clearTimeout(tab.highlightTimer);
				tab.highlightTimer = setTimeout(() => {
					tab.highlightTimer = null;
					try {
						void wc.debugger.sendCommand("Overlay.hideHighlight");
					} catch {
						// tab gone
					}
				}, AGENT_HIGHLIGHT_MS);
			} catch (error) {
				// Best effort, but never silent: a dead highlight is a UX bug
				// someone will ask about.
				console.warn("[managed-browser] agent highlight failed:", error instanceof Error ? error.message : error);
			}
		})();
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

	// ── IPC (renderer guest lifecycle + controls) ────────────────────────

	registerIpc() {
		if (this.ipcRegistered) return;
		this.ipcRegistered = true;
		ipcMain.handle("managed-browser:get-state", () => this.state());
		ipcMain.handle("managed-browser:navigate", async (_e, input) => {
			// Address-bar navigation drives the ACTIVE tab's guest; the
			// renderer owns the elements, so an unbound tab is a real failure
			// (never a silent no-op).
			const tab = this.tabs.get(this.activeTabId);
			if (!tab) return { ok: false, error: "no active browser tab" };
			const result = await tab.navigate(input?.url ?? "");
			// Do NOT record user-initiated navigation into the agent activity
			// ledger — that ledger is the agent's browser lane (user: 浏览器里
			// 多出个无法点击的 agent 行). Agent navs go through the CDP path.
			this.emitState({});
			return result;
		});
		ipcMain.handle("managed-browser:set-device", async (_e, input) =>
			this.applyDevicePreset(input?.tabId, input?.preset, input?.reload === true, input?.viewport ?? null),
		);
		ipcMain.handle("managed-browser:stop", (_e, tabId) => this.stopOp(tabId));
		ipcMain.handle("managed-browser:confirm-result", (_e, input) => {
			const pending = this.pendingConfirm;
			if (!pending || !input || pending.requestId !== input.requestId) return { ok: false };
			clearTimeout(pending.timer);
			this.pendingConfirm = null;
			pending.resolve(Boolean(input.allow));
			return { ok: true };
		});
		// Guest lifecycle: the renderer owns the elements, so it is the only
		// source of truth for which webContents belongs to which tab.
		ipcMain.handle("managed-browser:guest-ready", (_e, input) => this.handleGuestReady(input));
		ipcMain.handle("managed-browser:guest-gone", (_e, tabId) => this.handleGuestGone(tabId));
		ipcMain.handle("managed-browser:active-tab", (_e, tabId) => {
			// The renderer is the selection authority and may report a tab
			// before its guest attaches — adopt the id unconditionally. No
			// state push: nothing in the projection (port/activity) changed.
			if (typeof tabId !== "string" || !tabId) return { ok: false };
			this.activeTabId = tabId;
			return { ok: true };
		});
		ipcMain.handle("managed-browser:visibility", (_e, input) => {
			this.panelVisible = input?.visible === true;
			// The pane is showing: a pending agent-activity flag has done its
			// job (the renderer auto-opens the browser view on it).
			this.emitState({ agentActivity: false });
			return { ok: true };
		});
	}
}

module.exports = { ManagedBrowserController, DEFAULT_PORT };
