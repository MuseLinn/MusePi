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
 *   permissions, `musepi-file://` previews), the CDP bridge, and the sanitized
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

const { app, dialog, ipcMain, net, protocol, session: electronSession, shell, webContents } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createHash } = require("node:crypto");
const { projectActivity, settleActivity, startActivity, takeoverActivity } = require("./managed-browser-activity.cjs");
const { ManagedBrowserRecordStore } = require("./managed-browser-records.cjs");
const {
	readExtensionManifest,
	readExtensionRecords,
	writeExtensionRecords,
	loadPersistedExtensions,
	listManagedExtensions,
} = require("./managed-browser-extensions.cjs");

const DEFAULT_PORT = Number(process.env.MUSEPI_MANAGED_BROWSER_PORT || 9230);
const MAX_PORT_TRIES = 10;
const PARTITION = "persist:musepi-managed-browser";
const MAX_ACTIVITY_ITEMS = 12;
const CDP_ERROR_METHOD_NOT_FOUND = -32601;
const CDP_ERROR_SERVER = -32000;
/** Renderer-pushed runtime preferences (设置 → 浏览器). Defaults mirror the
 *  daemon schema so a pane that never pushes still gets the documented
 *  behavior (default zoom, system downloads, 5 GB agent limit). */
const DEFAULT_PREFERENCES = {
	zoom: 1,
	userAgent: "",
	searchEngine: "google",
	download: { askWhereToSave: true, dir: "", maxBytes: 5 * 1024 * 1024 * 1024 },
};
/** Same page-zoom range the renderer's per-tab override uses. */
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 3;
/** URLs the tool must never see as targets (mirrors the relay's ineligible set). */
const INELIGIBLE_URL = /^(chrome|devtools|edge|view-source|chrome-extension|chrome-untrusted|chrome-search):/i;
/** Sanctioned local-preview scheme: `musepi-file://<urlencoded absolute path>`
 *  serves agent-generated artifacts through the managed session. It is the ONLY
 *  local scheme: renderer persistence migrates the pre-rename spelling before a
 *  URL reaches this process. */
const LOCAL_PREVIEW_SCHEME = "musepi-file";
/** Matches the scheme prefix at the start of an address. */
const LOCAL_PREVIEW_URL = new RegExp(`^${LOCAL_PREVIEW_SCHEME}:`, "i");

/** Timeout for the renderer's risky-navigation consent dialog (auto-deny). */
const CONFIRM_TIMEOUT_MS = 30_000;
/** Upload confirmation window: the card (and the OS file picker it opens) may
 *  legitimately take a minute; after that the chooser is canceled. */
const UPLOAD_CONFIRM_TIMEOUT_MS = 60_000;
/** Upload request body cap (site metadata + an agent's absolute paths). */
const UPLOAD_REQUEST_MAX_BYTES = 64 * 1024;
/** One confirmation can carry at most this many files. */
const UPLOAD_MAX_FILES = 20;
/** Renderer guest-attach deadline for a main-initiated tab (10s renderer-side
 *  attach timeout + margin); a miss fails the CDP call instead of hanging. */
const GUEST_READY_TIMEOUT_MS = 15_000;
/** capturePage() never settles for an uncomposited guest — cap the wait. */
const CAPTURE_TIMEOUT_MS = 1_500;
/** A closed tab's guest is disposed only after the renderer actually unmounts
 *  its element (`guest-gone` from the ref detach). This is the fallback when
 *  that report never arrives (renderer dead/busy) — disposing earlier makes
 *  the webview's disconnectedCallback throw "Invalid guestInstanceId". */
const GUEST_GONE_TIMEOUT_MS = 2_000;
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

/**
 * Case-insensitive url/title substring match over the open tabs, in map
 * order. The empty query matches nothing so an absent `app.target` can never
 * be mistaken for "the first tab".
 */
function findTabByQuery(tabs, query) {
	const needle = typeof query === "string" ? query.trim().toLowerCase() : "";
	if (!needle) return null;
	for (const tab of tabs.values()) {
		const url = String(tab.url);
		if (INELIGIBLE_URL.test(url)) continue;
		if (url.toLowerCase().includes(needle)) return tab;
		if (String(tab.title).toLowerCase().includes(needle)) return tab;
	}
	return null;
}

/** Agent identity carried by a create request (CDP params or the private
 *  `ManagedBrowser.*` bridge methods). A missing id keeps user/app tab
 *  semantics: no attribution and no operator badge. */
function normalizeAgent(input) {
	const id = typeof input?.agentId === "string" ? input.agentId.trim() : "";
	if (!id) return null;
	const name = typeof input?.agentName === "string" ? input.agentName.trim() : "";
	return { id, name: name || id };
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

/** True when `url` addresses the local-preview surface in either spelling. */
function isLocalPreviewUrl(url) {
	return LOCAL_PREVIEW_URL.test(String(url));
}

/** Address-bar normalization: bare hostnames default to https; http/https or
 *  the local-preview scheme are accepted. Anything else, including the retired
 *  pre-rename spelling, is rejected. */
function normalizeAddressBarUrl(input) {
	const value = String(input).trim();
	if (!value) return null;
	if (value.startsWith("//")) return null;
	if (isLocalPreviewUrl(value)) {
		// Local preview, canonical form `musepi-file://localhost<absolute path>`.
		// An empty host is unstable: Chromium canonicalizes `musepi-file:///tmp/x`
		// into `musepi-file://tmp/x`, folding the first path segment into the
		// host. With a real host the pathname IS the absolute path.
		try {
			const filePath = localPreviewFilePath(value);
			if (!filePath) return null;
			// URL paths always use `/`; Windows drive paths need the leading
			// slash (`musepi-file://localhost/D:/x`) so `pathname` round-trips.
			const urlPath = filePath.replace(/\\/g, "/");
			return `${LOCAL_PREVIEW_SCHEME}://localhost${encodeURI(urlPath.startsWith("/") ? urlPath : `/${urlPath}`)}`;
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

/** Absolute filesystem path behind a local-preview URL, or null when the URL
 *  cannot address a file. Throws on a malformed URL. */
function localPreviewFilePath(url) {
	let decoded = decodeURIComponent(new URL(url).pathname);
	// Windows drive paths arrive as `/D:/...`; on Windows strip the URL
	// separator so `path.normalize` + `pathToFileURL` resolve the real file
	// instead of producing `file:///D:/D:/...`. On POSIX the leading slash is
	// the filesystem root, so keep it: stripping there turns an absolute path
	// into `D:/...`, which `path.isAbsolute` rejects and the round-trip breaks.
	if (process.platform === "win32" && /^\/[A-Za-z]:\//.test(decoded)) decoded = decoded.slice(1);
	const filePath = path.normalize(decoded);
	if (!path.isAbsolute(filePath) || path.basename(filePath) === "") return null;
	return filePath;
}

/** `file://` URL the protocol handlers fetch for a local-preview URL; null when
 *  the URL cannot address a file. Throws on a malformed URL. */
function localPreviewFileUrl(url) {
	const filePath = localPreviewFilePath(url);
	return filePath === null ? null : pathToFileURL(filePath).toString();
}

/** Minimal deferred (`Promise.withResolvers()` without a runtime floor). */
function deferred() {
	let resolve;
	const promise = new Promise((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** Server-supplied download name → one local path segment. */
function downloadFileName(raw) {
	const base = path
		.basename(String(raw || ""))
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
		.trim();
	return base && base !== "." && base !== ".." ? base : "download";
}

/** Never clobber an existing file in the download folder. */
function uniqueDownloadPath(target) {
	if (!fs.existsSync(target)) return target;
	const ext = path.extname(target);
	const stem = target.slice(0, target.length - ext.length);
	for (let i = 1; i < 1000; i++) {
		const candidate = `${stem} (${i})${ext}`;
		if (!fs.existsSync(candidate)) return candidate;
	}
	return target;
}

// ── in-app upload confirmation ─────────────────────────────────────────
//
// The managed browser never lets Chromium show a native file dialog: the
// daemon's browser worker intercepts the chooser over CDP and POSTs the
// decision here (loopback only). The renderer draws the card, optionally
// opens the OS picker from the card, and answers with `upload-result`.

/** MIME / wildcard accept entries → file extensions for the OS picker. */
const MIME_UPLOAD_EXTENSIONS = {
	"image/*": ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "heic"],
	"video/*": ["mp4", "webm", "mov", "mkv", "avi"],
	"audio/*": ["mp3", "wav", "ogg", "m4a", "flac"],
	"text/*": ["txt", "csv", "md", "html", "css", "js", "json", "xml"],
	"application/pdf": ["pdf"],
	"application/zip": ["zip"],
	"application/json": ["json"],
	"application/xml": ["xml"],
	"text/plain": ["txt"],
	"text/csv": ["csv"],
	"text/html": ["html", "htm"],
	"image/png": ["png"],
	"image/jpeg": ["jpg", "jpeg"],
	"image/gif": ["gif"],
	"image/webp": ["webp"],
	"image/svg+xml": ["svg"],
};

/** One-line accept summary for the renderer's card. */
function uploadAcceptList(raw) {
	const values = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
	const seen = new Set();
	for (const value of values) {
		const text = String(value || "")
			.trim()
			.toLowerCase()
			.slice(0, 80);
		if (text) seen.add(text);
	}
	return [...seen].slice(0, 20);
}

/** Electron `dialog.showOpenDialog` filters for a page's accept list. */
function uploadFilters(accept) {
	const extensions = new Set();
	let wildcard = false;
	for (const value of uploadAcceptList(accept)) {
		if (value === "*/*" || value === "*") {
			wildcard = true;
			continue;
		}
		if (value.startsWith(".")) {
			const ext = value.slice(1).replace(/[^a-z0-9+_-]/g, "").slice(0, 20);
			if (ext) extensions.add(ext);
			continue;
		}
		for (const ext of MIME_UPLOAD_EXTENSIONS[value] || []) extensions.add(ext);
	}
	const filters = [];
	if (!wildcard && extensions.size > 0) {
		const list = [...extensions].slice(0, 24);
		filters.push({
			name: `Supported files (${list
				.slice(0, 6)
				.map((ext) => `*.${ext}`)
				.join(", ")})`,
			extensions: list,
		});
	}
	filters.push({ name: "All files", extensions: ["*"] });
	return filters;
}

/** Absolute, existing, regular files only — the renderer is not trusted with
 *  an arbitrary path just because it answered a card. */
function validateUploadPaths(raw) {
	if (!Array.isArray(raw) || raw.length === 0 || raw.length > UPLOAD_MAX_FILES) return null;
	const paths = [];
	for (const value of raw) {
		if (typeof value !== "string" || !value || !path.isAbsolute(value)) return null;
		try {
			if (!fs.statSync(value).isFile()) return null;
		} catch {
			return null;
		}
		paths.push(value);
	}
	return paths;
}

/** Mail-shaped site metadata → safe card fields (control chars stripped). */
function sanitizeUploadSite(raw) {
	const site = raw && typeof raw === "object" ? raw : {};
	const clean = (value, max) =>
		String(value || "")
			.replace(/[\u0000-\u001f\u007f]/g, "")
			.trim()
			.slice(0, max);
	return {
		host: clean(site.host, 200),
		url: redactUrl(clean(site.url, 2048)),
		...(clean(site.title, 120) ? { title: clean(site.title, 120) } : {}),
	};
}

/**
 * Validate one upload request from the browser worker. Returns null when the
 * shape or a path is unusable; the HTTP endpoint then answers `invalid`.
 */
function sanitizeUploadRequest(input) {
	if (!input || typeof input !== "object") return null;
	const mode = input.mode === "agent" ? "agent" : "site";
	const site = sanitizeUploadSite(input.site);
	const accept = uploadAcceptList(input.accept);
	const multiple = input.multiple === true;
	if (mode === "agent") {
		const paths = validateUploadPaths(input.paths);
		if (!paths) return null;
		return { mode, site, accept, multiple, paths };
	}
	return { mode, site, accept, multiple };
}

/** Upload names shown on the card (basenames only, never full paths). */
function uploadNames(paths) {
	return (Array.isArray(paths) ? paths : [])
		.slice(0, UPLOAD_MAX_FILES)
		.map((filePath) => path.basename(String(filePath)).slice(0, 160));
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
	constructor(controller, url, openedByAgent, explicitId, agent = null) {
		this.controller = controller;
		/** Opaque tab id: main mints numeric ones for the tabs it creates
		 *  (agent lanes, prewarm), the renderer's own (`local-N`) for tabs the
		 *  user opened. It only has to round-trip through `tabs`. */
		this.id = explicitId ?? ++controller.tabSeq;
		this.openedByAgent = openedByAgent;
		/** Agent that asked for this tab; null for user/app tabs. */
		this.agentId = agent?.id ?? null;
		/** Display name of {@link agentId}, falling back to the id. */
		this.agentName = agent?.name ?? this.agentId;
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
		/** Renderer set an explicit per-tab zoom; the default zoom must not
		 *  overwrite it when preferences change. */
		this.zoomOverride = false;
		/** Page frozen via CDP `Page.setWebLifecycleState` (residency management). */
		this.frozen = false;
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
		const managedSession = electronSession.fromPartition(PARTITION);
		// Electron may return a different JS wrapper for the same partition.
		// Compare its canonical storage path, not wrapper identity.
		if (wc.session.getStoragePath() !== managedSession.getStoragePath()) return false;
		if (this.wc && this.wc !== wc) this.detachDebugger();
		this.wc = wc;
		wc.setWindowOpenHandler(({ url: targetUrl }) => {
			// target=_blank / window.open become managed tabs instead of
			// escaping the app (deny would silently drop user clicks).
			// User-initiated opens (window.open via click) are NOT agent tabs;
			// only Target.createTarget from the CDP side sets openedByAgent=true.
			if (/^https?:/i.test(targetUrl) || isLocalPreviewUrl(targetUrl)) {
				void this.controller.createTab(targetUrl, false).catch(() => {});
			}
			return { action: "deny" };
		});
		wc.on("will-navigate", (event, targetUrl) => {
			// Local previews navigate within their scheme (relative links,
			// anchors); everything else non-http(s) stays blocked.
			if (!/^https?:/i.test(targetUrl) && !isLocalPreviewUrl(targetUrl)) event.preventDefault();
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
		});
		wc.on("did-navigate", (_e, targetUrl) => {
			this.refreshState(targetUrl);
			this.controller.recordHistory(this);
			this.controller.notifyLifecycle(this);
		});
		wc.on("did-navigate-in-page", (_e, targetUrl) => {
			this.refreshState(targetUrl);
			this.controller.recordHistory(this);
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
		wc.once("did-finish-load", () => {
			this.ensureDebugger();
			this.controller.recordHistory(this);
		});
		// `did-attach` can reach main after a fast local page already
		// finished loading — attach now instead of waiting for an event that
		// will never fire again.
		if (!wc.isLoading()) {
			this.ensureDebugger();
			this.controller.recordHistory(this);
		}
		// Preferences must be in place before the first navigation resolves:
		// UA is read by the document, zoom by the compositor.
		this.controller.applyPreferences(this);
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
		if (!target) return { ok: false, error: `Only http/https or ${LOCAL_PREVIEW_SCHEME}:// URLs are allowed` };
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
				// The renderer element is already unmounted here. close() can leave a
				// guest alive indefinitely; destroy() completes the CDP close cycle.
				wc.destroy();
			} catch {
				// already closing
			}
		}
	}
}

class ManagedBrowserController {
	constructor(options = {}) {
		this.owner = null;
		/** Created on first use: constructing the controller must not need
		 *  Electron's `app`, so unit tests can drive tab lookup directly. */
		this.recordsOptions = options;
		this.records = options.recordStore ?? null;
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
		/** In-flight in-app upload confirmation ({requestId, timer, resolve, paths}). */
		this.pendingUpload = null;
		this.uploadSeq = 0;
		/** Closes waiting for the renderer's element-unmount report before the
		 *  guest is disposed (id → {tab, timer}) — see disposeAfterUnmount. */
		this.guestGoneWaiters = new Map();
		/** Renderer listener registration barrier. CDP starts before React, so a
		 *  create notification sent before this resolves can be lost. */
		this.hostReady = deferred();
		/** Runtime preferences pushed by the renderer (setPreferences). */
		this.preferences = { ...DEFAULT_PREFERENCES, download: { ...DEFAULT_PREFERENCES.download } };
		/** `will-download` listener armed once on the managed session. */
		this.downloadsGuarded = false;
		this.persistedExtensionRecordsFile = null;
		this.extensionLoadErrors = [];
	}

	/** Record store, created on first use (see the constructor note). */
	get recordStore() {
		if (this.records === null) {
			const options = this.recordsOptions;
			this.records = new ManagedBrowserRecordStore(
				options.recordsFile ?? path.join(app.getPath("userData"), "managed-browser-records.json"),
			);
		}
		return this.records;
	}

	/** Persisted-extension index path, resolved on first use for the same reason. */
	get extensionRecordsFile() {
		if (this.persistedExtensionRecordsFile === null) {
			this.persistedExtensionRecordsFile = path.join(app.getPath("userData"), "managed-browser-extensions.json");
		}
		return this.persistedExtensionRecordsFile;
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
		this.hostReady = deferred();
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
		this.cancelPendingUpload();
		for (const waiter of this.guestGoneWaiters.values()) {
			clearTimeout(waiter.timer);
			waiter.tab.dispose();
		}
		this.guestGoneWaiters.clear();
		for (const tab of [...this.tabs.values()]) tab.dispose();
		this.tabs.clear();
		this.activeTabId = null;
		this.agentTabId = null;
	}

	async start(ownerWindow) {
		this.setOwner(ownerWindow);
		this.guardPartition();
		await this.loadPersistedExtensions();
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
			// Local artifact preview: `musepi-file://<urlencoded absolute path>`.
			// Absolute paths only; navigation to it from renderer-initiated
			// non-http(s) links is blocked by will-navigate.
			const serveLocalPreview = (request) => {
				let fileUrl;
				try {
					fileUrl = localPreviewFileUrl(request.url);
				} catch {
					return new Response("bad request", { status: 400 });
				}
				if (fileUrl === null) return new Response("not found", { status: 404 });
				return net.fetch(fileUrl);
			};
			ses.protocol.handle(LOCAL_PREVIEW_SCHEME, serveLocalPreview);
		} catch {
			// session unavailable (tests / headless) — best effort
		}
		this.guardDownloads();
	}

	/** Downloads for the managed partition: one `will-download` listener
	 *  applies the renderer's save policy (agent tabs → download folder,
	 *  user tabs → ask or download folder) and the agent size cap. */
	guardDownloads() {
		if (this.downloadsGuarded) return;
		this.downloadsGuarded = true;
		try {
			electronSession.fromPartition(PARTITION).on("will-download", (_event, item, wc) => {
				this.handleWillDownload(item, wc);
			});
		} catch (error) {
			console.warn(
				"[managed-browser] will-download registration failed:",
				error instanceof Error ? error.message : error,
			);
		}
	}

	/** Choose the destination synchronously: Electron only honors
	 *  `setSavePath` inside this callback, and an async dialog would let
	 *  the transfer start (or open Chromium's own prompt) first. */
	handleWillDownload(item, wc) {
		try {
			const tab = wc ? [...this.tabs.values()].find((candidate) => candidate.wc === wc) : null;
			const agent = Boolean(
				tab && (tab.openedByAgent || (this.agentTabId !== null && String(tab.id) === this.agentTabId)),
			);
			const prefs = this.preferences.download;
			const dir = prefs.dir || app.getPath("downloads");
			const fileName = downloadFileName(item.getFilename());
			let savePath;
			if (agent || !prefs.askWhereToSave) {
				fs.mkdirSync(dir, { recursive: true });
				savePath = uniqueDownloadPath(path.join(dir, fileName));
			} else {
				const options = { defaultPath: path.join(dir, fileName) };
				const owner = this.owner && !this.owner.isDestroyed() ? this.owner : null;
				const picked = owner ? dialog.showSaveDialogSync(owner, options) : dialog.showSaveDialogSync(options);
				if (!picked) {
					item.cancel();
					return;
				}
				fs.mkdirSync(path.dirname(picked), { recursive: true });
				savePath = picked;
			}
			item.setSavePath(savePath);
			const download = this.recordStore.beginDownload({
				url: redactUrl(item.getURL()),
				fileName,
				savePath,
				totalBytes: item.getTotalBytes(),
				startedAt: Date.now(),
			});
			item.on("updated", (_event, state) => {
				this.recordStore.updateDownload(download.id, {
					status: state,
					receivedBytes: item.getReceivedBytes(),
					totalBytes: item.getTotalBytes(),
				});
			});
			item.once("done", (_event, state) => {
				this.recordStore.updateDownload(download.id, {
					status: state,
					receivedBytes: item.getReceivedBytes(),
					totalBytes: item.getTotalBytes(),
					endedAt: Date.now(),
				});
			});
			// The cap is an agent guardrail: a user-started download is theirs.
			if (agent) this.guardDownloadSize(item, prefs.maxBytes);
		} catch (error) {
			console.warn("[managed-browser] download setup failed:", error instanceof Error ? error.message : error);
		}
	}

	/** Cancel an agent download that exceeds `maxBytes` (known total up
	 *  front, or the running byte count once unknown totals arrive). */
	guardDownloadSize(item, maxBytes) {
		const limit = Number(maxBytes);
		if (!Number.isFinite(limit) || limit <= 0) return;
		let blocked = false;
		const stop = () => {
			if (blocked) return;
			blocked = true;
			try {
				item.cancel();
			} catch {
				// already finished
			}
			this.discardDownload(item);
		};
		if (item.getTotalBytes() > limit) {
			stop();
			return;
		}
		item.on("updated", (_event, state) => {
			if (blocked || state !== "progressing") return;
			if (item.getReceivedBytes() > limit) stop();
		});
	}

	/** Remove the partial file a capped agent download left behind; Windows
	 *  may keep the handle briefly, so retry on `done` and once after. */
	discardDownload(item) {
		const remove = () => {
			let filePath = "";
			try {
				filePath = item.getSavePath();
			} catch {
				return;
			}
			if (!filePath) return;
			try {
				fs.rmSync(filePath, { force: true });
			} catch (error) {
				console.warn(
					"[managed-browser] partial download cleanup failed:",
					error instanceof Error ? error.message : error,
				);
			}
		};
		remove();
		try {
			item.once("done", remove);
		} catch {
			// item already settled
		}
		const timer = setTimeout(remove, 1000);
		if (typeof timer.unref === "function") timer.unref();
	}

	// ── tabs ─────────────────────────────────────────────────────────────

	/** Wait for the renderer's listener registration without blocking forever
	 *  when the host failed to mount. A later call may retry after a timeout. */
	async waitForHostReady() {
		let timer;
		const timeout = new Promise(resolve => {
			timer = setTimeout(() => resolve(false), GUEST_READY_TIMEOUT_MS);
		});
		const ready = await Promise.race([this.hostReady.promise, timeout]);
		clearTimeout(timer);
		return ready;
	}

	handleHostReady() {
		this.hostReady.resolve(true);
		return { ok: true };
	}

	/** Create a tab: mint the record, ask the renderer to mount the guest,
	 *  then wait for its `guest-ready` report. Resolves to null when the tab
	 *  could not be created (no owner, guest never attached) — callers turn
	 *  that into a CDP error rather than a silent no-op. */
	async createTab(url = "about:blank", openedByAgent = false, agent = null) {
		if (!this.owner || this.owner.isDestroyed()) return null;
		if (!(await this.waitForHostReady())) return null;
		const tab = new ManagedTab(this, url, openedByAgent, undefined, agent);
		const id = String(tab.id);
		this.tabs.set(id, tab);
		if (!this.activeTabId) this.activeTabId = id;
		this.recordActivity(tab, "open", url, "opened");
		// The renderer badges the tab with its operator; a user tab omits the
		// fields entirely so the pre-existing payload shape is unchanged.
		this.sendToRenderer("managed-browser:create-tab", {
			tabId: id,
			url,
			...(tab.agentId ? { agentId: tab.agentId, agentName: tab.agentName } : {}),
		});
		// The agent's work must stay visible: creating an agent tab selects it
		// (and pushes agentActivity so the closed pane re-opens).
		if (openedByAgent) this.selectTab(id, { agentActivity: true });
		else this.emitState({});
		const guestReady = await tab.waitForGuest();
		if (!guestReady) {
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
	async ensureAgentTab(agent = null) {
		const existing = this.agentTabId ? this.tabs.get(this.agentTabId) : null;
		if (existing) {
			// A later caller may be the first to publish an identity for the
			// dedicated tab (older daemons send no agent fields). The renderer
			// learns about it through the ledger, which the next activity row
			// carries.
			if (agent && (existing.agentId !== agent.id || existing.agentName !== agent.name)) {
				existing.agentId = agent.id;
				existing.agentName = agent.name;
				this.emitState({});
			}
			return existing;
		}
		const tab = await this.createTab("about:blank", true, agent);
		if (!tab) return null;
		this.agentTabId = String(tab.id);
		return tab;
	}

	activatePanel() {
		this.panelVisible = true;
		this.emitState({ agentActivity: true });
		return { ok: true, panelVisible: true };
	}

	releaseAgentTab() {
		const id = this.agentTabId;
		if (id) takeoverActivity(this.ledger, id);
		this.agentTabId = null;
		this.emitState({});
		return { ok: true };
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
	 *  drop the record, its CDP targets and its ledger rows. A pending close
	 *  waiter settles here — the guest is disposed only NOW that the element
	 *  is already out of the DOM. */
	handleGuestGone(tabId) {
		const id = String(tabId ?? "");
		if (this.settleClosedTab(id)) return { ok: true };
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
		for (const conn of this.conns.values()) {
			for (const [sessionId, ref] of conn.sessions) {
				if (String(ref.tabId) !== id) continue;
				this.emit(conn, "Target.detachedFromTarget", {
					sessionId,
					targetId: ref.kind === "tab" ? tabTargetId(id) : pageTargetId(id),
				});
				this.releaseSession(conn, sessionId);
			}
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
	 *  the element on the push; the guest is disposed after that unmount
	 *  actually happens (see disposeAfterUnmount) — disposing first makes the
	 *  webview's disconnectedCallback throw "Invalid guestInstanceId" inside
	 *  React's commit and crash the GUI. */
	closeTab(tabId) {
		const tab = this.tabs.get(String(tabId));
		if (!tab) return null;
		this.sendToRenderer("managed-browser:close-tab", { tabId: String(tab.id) });
		this.disposeAfterUnmount(tab);
		return this.state();
	}

	/** Dispose a tab once its renderer element has actually unmounted.
	 *
	 *  Ordering is the whole game: the webview's disconnectedCallback resolves
	 *  its guest through a main-side registry, and closeTab's `close-tab` push
	 *  is asynchronous — disposing synchronously after the push means the
	 *  registry entry is gone by the time the renderer's removeChild runs,
	 *  and the callback throws "Invalid guestInstanceId" inside React's
	 *  commit. The renderer reports the REAL unmount (ref detach) via
	 *  `guest-gone`; the timeout covers a dead or busy renderer. */
	disposeAfterUnmount(tab) {
		const id = String(tab.id);
		if (this.guestGoneWaiters.has(id)) return;
		const timer = setTimeout(() => this.settleClosedTab(id), GUEST_GONE_TIMEOUT_MS);
		this.guestGoneWaiters.set(id, { tab, timer });
	}

	/** Settle a close waiter (guest-gone report or timeout). True when a
	 *  waiter existed and was settled. */
	settleClosedTab(id) {
		const waiter = this.guestGoneWaiters.get(id);
		if (!waiter) return false;
		this.guestGoneWaiters.delete(id);
		clearTimeout(waiter.timer);
		waiter.tab.dispose();
		this.handleTabDestroyed(waiter.tab);
		return true;
	}

	closeAll() {
		for (const tab of [...this.tabs.values()]) {
			this.sendToRenderer("managed-browser:close-tab", { tabId: String(tab.id) });
			this.disposeAfterUnmount(tab);
		}
		this.activeTabId = null;
		this.agentTabId = null;
		this.emitState({});
	}

	// ── renderer-facing state ────────────────────────────────────────────

	recordHistory(tab) {
		const url = redactUrl(tab.url);
		if (!url || INELIGIBLE_URL.test(url) || tab.lastHistoryUrl === url) return;
		tab.lastHistoryUrl = url;
		this.recordStore.recordHistory({ url, title: tab.title, visitedAt: Date.now() });
	}

	/** Agent-facing panel and tab facts. Page contents and credentials never
	 *  cross this metadata-only boundary. */
	agentState() {
		const tabs = [...this.tabs.values()].filter((tab) => !INELIGIBLE_URL.test(tab.url));
		const controlled = this.agentTabId ? tabs.find((tab) => String(tab.id) === this.agentTabId) : null;
		const visible = this.activeTabId ? tabs.find((tab) => String(tab.id) === this.activeTabId) : null;
		const current = controlled ?? visible ?? null;
		return {
			available: true,
			panelVisible: this.panelVisible,
			...(controlled ? { activeTabId: String(controlled.id) } : {}),
			...(this.panelVisible && visible ? { visibleTabId: String(visible.id) } : {}),
			...(current ? { url: redactUrl(current.url), title: current.title } : {}),
			tabs: tabs.map((tab) => {
				const wc = tab.wc && !tab.wc.isDestroyed() ? tab.wc : null;
				const navigation = wc?.navigationHistory;
				return {
					id: String(tab.id),
					title: tab.title,
					url: redactUrl(tab.url),
					controlled: String(tab.id) === this.agentTabId,
					visible: this.panelVisible && String(tab.id) === this.activeTabId,
					...(wc && typeof wc.isLoading === "function" ? { loading: wc.isLoading() } : {}),
					...(navigation && typeof navigation.canGoBack === "function"
						? { canGoBack: navigation.canGoBack() }
						: wc && typeof wc.canGoBack === "function"
							? { canGoBack: wc.canGoBack() }
							: {}),
					...(navigation && typeof navigation.canGoForward === "function"
						? { canGoForward: navigation.canGoForward() }
						: wc && typeof wc.canGoForward === "function"
							? { canGoForward: wc.canGoForward() }
							: {}),
				};
			}),
		};
	}

	/** Projected state: the CDP port and per-tab activity. Tab metadata stays
	 *  in the renderer — it owns the elements. */
	state() {
		return {
			port: this.server ? this.port : null,
			...projectActivity(this.ledger, this.activeTabId),
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

	recordActivity(tab, action, url, status, key) {
		let domain = null;
		try {
			domain = new URL(url).host || null;
		} catch {
			// about:blank etc.
		}
		const item = startActivity(this.ledger, {
			key: key ?? `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			action,
			summary: this.activitySummary(action, tab, url),
			domain,
			status,
			tabId: String(tab.id),
			at: Date.now(),
		}, MAX_ACTIVITY_ITEMS);
		// The projected state carries the operator so the overlay can name the
		// agent even when the renderer's tab record has no attribution.
		if (tab.agentId) {
			item.agentId = tab.agentId;
			item.agentName = tab.agentName;
		}
		return item;
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
	 * the URL, the retired pre-rename spelling, and exotic schemes need
	 * explicit user consent (default deny).
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

	// ── in-app upload confirmation ───────────────────────────────────────

	/**
	 * Ask the renderer to decide on an upload. One card at a time; a second
	 * request answers `busy` instead of stacking dialogs. Resolves with the
	 * accepted absolute paths (site mode: picked by the user; agent mode: the
	 * worker's already-validated list).
	 */
	requestUploadConsent(input) {
		if (this.pendingUpload) return Promise.resolve({ accepted: false, reason: "busy" });
		if (!this.owner || this.owner.isDestroyed()) return Promise.resolve({ accepted: false, reason: "unsupported" });
		return new Promise((resolve) => {
			const requestId = `u${++this.uploadSeq}`;
			const timer = setTimeout(() => {
				if (this.pendingUpload && this.pendingUpload.requestId === requestId) {
					this.pendingUpload = null;
				}
				if (this.owner && !this.owner.isDestroyed()) {
					this.owner.webContents.send("managed-browser:upload-dismiss", { requestId });
				}
				resolve({ accepted: false, reason: "timeout" });
			}, UPLOAD_CONFIRM_TIMEOUT_MS);
			timer.unref?.();
			this.pendingUpload = { requestId, timer, resolve, agentPaths: input.paths ?? null };
			this.owner.webContents.send("managed-browser:upload-request", {
				requestId,
				mode: input.mode,
				site: input.site,
				accept: input.accept,
				multiple: input.multiple === true,
				names: uploadNames(input.paths),
			});
		});
	}

	/** Renderer answer to a card: validate the decision, then settle the wait. */
	resolveUploadResult(input) {
		const pending = this.pendingUpload;
		if (!pending || !input || pending.requestId !== input.requestId) return { ok: false };
		clearTimeout(pending.timer);
		this.pendingUpload = null;
		if (input.accepted !== true) {
			pending.resolve({
				accepted: false,
				reason: typeof input.reason === "string" ? input.reason : "canceled",
			});
			return { ok: true };
		}
		// Agent mode keeps the worker's validated list; site mode trusts the
		// picker's return value only after the same absolute/regular-file check.
		const paths = pending.agentPaths ?? validateUploadPaths(input.paths);
		if (!paths) {
			pending.resolve({ accepted: false, reason: "invalid" });
			return { ok: false };
		}
		pending.resolve({ accepted: true, paths });
		return { ok: true };
	}

	/** Owner window going away: unblock the worker now instead of after 60s. */
	cancelPendingUpload() {
		const pending = this.pendingUpload;
		if (!pending) return;
		clearTimeout(pending.timer);
		this.pendingUpload = null;
		pending.resolve({ accepted: false, reason: "canceled" });
	}

	/**
	 * Native picker for the card's 选择文件 button. Returns absolute paths
	 * (empty when canceled). Only while a card is waiting — a renderer cannot
	 * pop the file dialog arbitrarily.
	 */
	async pickUploadFiles(input) {
		if (!this.pendingUpload) return { paths: [] };
		try {
			const multiple = input?.multiple === true;
			const options = {
				properties: multiple ? ["openFile", "multiSelections"] : ["openFile"],
				filters: uploadFilters(input?.accept),
			};
			const owner = this.owner && !this.owner.isDestroyed() ? this.owner : null;
			const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
			if (!result || result.canceled) return { paths: [] };
			return { paths: (result.filePaths || []).filter((filePath) => path.isAbsolute(filePath)) };
		} catch (error) {
			return { paths: [], error: error instanceof Error ? error.message : String(error) };
		}
	}

	/**
	 * Loopback HTTP endpoint for the daemon's browser worker
	 * (`POST /musepi/upload-request`). No CORS, no credentials, JSON only: a
	 * web page must never be able to ask for a file upload on its own.
	 */
	handleUploadRequestHttp(req, res) {
		if (req.headers.origin) {
			res.writeHead(403);
			res.end("forbidden");
			return;
		}
		if (!/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) {
			res.writeHead(415);
			res.end("unsupported media type");
			return;
		}
		const chunks = [];
		let size = 0;
		let overflow = false;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > UPLOAD_REQUEST_MAX_BYTES) {
				overflow = true;
				if (!res.headersSent) {
					res.writeHead(413);
					res.end("too large");
				}
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("error", () => {
			if (!res.headersSent) {
				res.writeHead(400);
				res.end("bad request");
			}
		});
		req.on("end", () => {
			if (overflow) return;
			let parsed;
			try {
				parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch {
				this.writeJson(res, { accepted: false, reason: "invalid" });
				return;
			}
			const request = sanitizeUploadRequest(parsed);
			if (!request) {
				this.writeJson(res, { accepted: false, reason: "invalid" });
				return;
			}
			void this.requestUploadConsent(request).then((result) => this.writeJson(res, result));
		});
	}

	// ── operation status + stop (executionSource 停止按钮) ───────────────

	markOpStatus(key, status) {
		return settleActivity(this.ledger, key, status);
	}

	/** Hand the live page to the user without the hard-stop tab disposal. */
	takeoverOp(tabId) {
		const id = String(tabId ?? this.activeTabId ?? "");
		if (id) takeoverActivity(this.ledger, id);
		this.emitState({});
		return this.state();
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
		takeoverActivity(this.ledger, String(tab.id));
		if (tab.openedByAgent) this.closeTab(String(tab.id));
		this.emitState({});
		return this.state();
	}

	/**
	 * Clear managed-browser browsing data for the shared partition.
	 * `mode: "cookies"` clears cookies/storage; `"all"` also wipes cache.
	 * Returns `{ ok: boolean, error?: string }`.
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
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
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
				if (req.method === "GET" && (req.url === "/musepi/history" || req.url === "/musepi/history/")) {
					this.writeJson(res, this.recordStore.history());
					return;
				}
				if (req.method === "GET" && (req.url === "/musepi/downloads" || req.url === "/musepi/downloads/")) {
					this.writeJson(res, this.recordStore.downloads());
					return;
				}
				if (req.method === "GET" && (req.url === "/musepi/state" || req.url === "/musepi/state/")) {
					this.writeJson(res, this.agentState());
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
				// In-app upload confirmation for the daemon's browser worker.
				if (
					req.method === "POST" &&
					(req.url === "/musepi/upload-request" || req.url === "/musepi/upload-request/")
				) {
					this.handleUploadRequestHttp(req, res);
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
				const tab = await this.createTab(url, true, normalizeAgent(msg.params));
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
				// Daemon-side contract (tab-supervisor requestManagedBrowserTarget
				// without app.target): return the DEDICATED agent tab's page target
				// id, creating it on first use so the agent never adopts the user's
				// tab.
				const tab = await this.ensureAgentTab(normalizeAgent(msg.params));
				if (!tab) {
					this.replyError(conn, msg, "The managed browser did not provide an agent tab");
					return;
				}
				this.reply(conn, msg, { targetId: pageTargetId(tab.id) });
				return;
			}
			case "ManagedBrowser.activatePanel": {
				this.reply(conn, msg, this.activatePanel());
				return;
			}
			case "ManagedBrowser.releaseAgentTab": {
				this.reply(conn, msg, this.releaseAgentTab());
				return;
			}
			case "ManagedBrowser.findTabTarget": {
				// Daemon-side contract (tab-supervisor requestManagedBrowserTarget
				// with an explicit app.target): resolve an OPEN tab by url/title
				// substring. Lookup only — no selection, focus change or tab
				// creation — and a miss replies null so the caller reports it.
				const tab = findTabByQuery(this.tabs, msg.params?.target);
				this.reply(conn, msg, { targetId: tab ? pageTargetId(tab.id) : null });
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
		if (msg.method === "Page.close" || msg.method === "Target.closeTarget") {
			// Do not detach the debugger before acknowledging the close. Route it
			// through the same unmount → dispose chain as the browser-level method.
			this.closeTab(String(tab.id));
			this.reply(conn, msg, msg.method === "Page.close" ? {} : { success: true });
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
		const activityKey = activityAction ? `${conn.id}:${msg.id}` : null;
		if (activityAction && activityKey) {
			this.recordActivity(tab, activityAction, tab.url, "dispatched", activityKey);
			this.emitState(this.panelVisible ? {} : { agentActivity: true });
		}
		const highlightPoint = agentHighlightPoint(msg.method, msg.params);
		if (highlightPoint) this.flashAgentTarget(tab, highlightPoint);
		try {
			const result = (await wc.debugger.sendCommand(msg.method, msg.params)) ?? {};
			// Detach (e.g. a stopOp tab close) resolves pending commands instead
			// of rejecting — do not overwrite the canceled mark the stop applied.
			if (activityKey && this.tabs.has(String(tab.id))) {
				this.markOpStatus(activityKey, "completed");
				this.emitState({});
			}
			this.reply(conn, msg, result);
		} catch (error) {
			if (activityKey) {
				this.markOpStatus(activityKey, "failed");
				this.emitState({});
			}
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
	 * Per-tab page zoom (zcode zoom-control parity, shell design §3.2.1):
	 * the WebContents zoom factor, fully independent of the device-preset
	 * Emulation overrides (those own layout metrics + UA identity, never
	 * page zoom) — the two levers do not step on each other.
	 */
	async setZoom(input) {
		const tab = this.tabs.get(String(input?.tabId));
		if (!tab) return { ok: false, error: "unknown tab" };
		const wc = tab.wc;
		if (!wc || wc.isDestroyed()) return { ok: false, error: "browser tab is not ready" };
		const zoom = Number(input?.zoom);
		try {
			wc.setZoomFactor(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number.isFinite(zoom) && zoom > 0 ? zoom : 1)));
			tab.zoomOverride = true;
			return { ok: true };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async printTab(tabId) {
		const tab = this.tabs.get(String(tabId));
		const wc = tab?.wc;
		if (!wc || wc.isDestroyed()) return { ok: false, error: "browser tab is not ready" };
		return await new Promise(resolve => {
			try {
				wc.print({}, (success, reason) => {
					resolve(success ? { ok: true } : { ok: false, error: reason || "print failed" });
				});
			} catch (error) {
				resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
			}
		});
	}

	async saveScreenshot(tabId) {
		const tab = this.tabs.get(String(tabId));
		const wc = tab?.wc;
		if (!wc || wc.isDestroyed()) return { ok: false, error: "browser tab is not ready" };
		const prefs = this.preferences.download;
		const dir = prefs.dir || app.getPath("downloads");
		const fileName = downloadFileName(`${tab.title || "screenshot"}.png`);
		let timer;
		try {
			const image = await Promise.race([
				wc.capturePage(),
				new Promise((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error("Screenshot unavailable")), CAPTURE_TIMEOUT_MS);
				}),
			]);
			if (!image) return { ok: false, error: "Screenshot unavailable" };
			fs.mkdirSync(dir, { recursive: true });
			let target;
			if (prefs.askWhereToSave) {
				const options = { defaultPath: path.join(dir, fileName) };
				const owner = this.owner && !this.owner.isDestroyed() ? this.owner : null;
				const picked = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
				if (!picked || picked.canceled || !picked.filePath) return { ok: false, canceled: true };
				target = picked.filePath;
				fs.mkdirSync(path.dirname(target), { recursive: true });
			} else {
				target = uniqueDownloadPath(path.join(dir, fileName));
			}
			fs.writeFileSync(target, image.toPNG());
			return { ok: true, path: target };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		} finally {
			clearTimeout(timer);
		}
	}

	async showDownloads() {
		const dir = this.preferences.download.dir || app.getPath("downloads");
		try {
			fs.mkdirSync(dir, { recursive: true });
			const error = await shell.openPath(dir);
			return error ? { ok: false, error } : { ok: true };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async loadPersistedExtensions() {
		try {
			const ses = electronSession.fromPartition(PARTITION);
			const result = await loadPersistedExtensions(ses, this.extensionRecordsFile);
			this.extensionLoadErrors = result.errors;
		} catch (error) {
			this.extensionLoadErrors = [error instanceof Error ? error.message : String(error)];
		}
	}

	listExtensions() {
		const ses = electronSession.fromPartition(PARTITION);
		return { extensions: listManagedExtensions(ses, this.extensionRecordsFile), errors: this.extensionLoadErrors };
	}

	async chooseExtension() {
		this.pendingExtensionCandidate = null;
		const options = { properties: ["openDirectory"] };
		const owner = this.owner && !this.owner.isDestroyed() ? this.owner : null;
		const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
		if (!picked || picked.canceled || !picked.filePaths?.[0]) return { candidate: null };
		const candidate = readExtensionManifest(picked.filePaths[0]);
		this.pendingExtensionCandidate = candidate;
		const existing = readExtensionRecords(this.extensionRecordsFile).find(record => record.path === candidate.path);
		return { candidate: existing ? { ...candidate, id: existing.id, alreadyInstalled: true } : candidate };
	}

	async installExtension(input) {
		if (input?.confirmed !== true) throw new Error("Extension permission confirmation is required");
		const candidate = this.pendingExtensionCandidate;
		if (!candidate) throw new Error("Choose and review an extension before installation");
		const existing = readExtensionRecords(this.extensionRecordsFile).find(record => record.path === candidate.path);
		if (existing) return { ok: true, alreadyInstalled: true, extension: { ...candidate, id: existing.id } };
		const ses = electronSession.fromPartition(PARTITION);
		const extension = await ses.loadExtension(candidate.path);
		const record = { ...candidate, id: extension.id };
		const records = [...readExtensionRecords(this.extensionRecordsFile).filter(item => item.id !== record.id && item.path !== record.path), record];
		writeExtensionRecords(this.extensionRecordsFile, records);
		this.extensionLoadErrors = [];
		return { ok: true, extension: record };
	}

	async removeExtension(input) {
		if (typeof input?.id !== "string" || !input.id) return { ok: false, error: "extension id is required" };
		electronSession.fromPartition(PARTITION).removeExtension(input.id);
		writeExtensionRecords(
			this.extensionRecordsFile,
			readExtensionRecords(this.extensionRecordsFile).filter(record => record.id !== input.id),
		);
		return { ok: true };
	}

	/**
	 * Runtime preferences from the pane's settings read (设置 → 浏览器):
	 * default page zoom, custom user agent, address-bar search engine and the
	 * download policy. Applied to every open tab and to tabs created later.
	 */
	setPreferences(input) {
		const current = this.preferences;
		const zoom = Number(input?.zoom);
		const download = input?.download ?? {};
		const maxBytes = Number(download.maxBytes);
		this.preferences = {
			zoom: Number.isFinite(zoom) && zoom > 0 ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom)) : current.zoom,
			// "" is meaningful: it clears the override and restores the engine
			// default user agent.
			userAgent: typeof input?.userAgent === "string" ? input.userAgent.trim() : current.userAgent,
			searchEngine:
				typeof input?.searchEngine === "string" && input.searchEngine.trim()
					? input.searchEngine.trim().toLowerCase()
					: current.searchEngine,
			download: {
				askWhereToSave:
					typeof download.askWhereToSave === "boolean" ? download.askWhereToSave : current.download.askWhereToSave,
				dir: typeof download.dir === "string" ? download.dir.trim() : current.download.dir,
				maxBytes: Number.isFinite(maxBytes) && maxBytes >= 0 ? maxBytes : current.download.maxBytes,
			},
		};
		for (const tab of this.tabs.values()) this.applyPreferences(tab);
		return { ok: true };
	}

	/** Apply the stored preferences to one bound guest (best effort). */
	applyPreferences(tab) {
		const wc = tab.wc;
		if (!wc || wc.isDestroyed()) return;
		try {
			// Empty setting = engine default; keep the guest's original UA once
			// (getUserAgent would return our override after the first apply).
			tab.baseUserAgent ??= wc.getUserAgent();
			wc.setUserAgent(this.preferences.userAgent || tab.baseUserAgent);
		} catch {
			// guest is tearing down
		}
		// A per-tab override wins over the default (per-tab zoom parity).
		if (tab.zoomOverride) return;
		try {
			wc.setZoomFactor(this.preferences.zoom);
		} catch {
			// guest is tearing down
		}
	}

	/**
	 * Freeze/thaw one tab's page via the per-tab CDP debugger session
	 * (`Page.setWebLifecycleState`). Chromium-native page freezing: the DOM
	 * and in-page state survive, JavaScript timers/loads pause, and there is
	 * NO reload cost on thaw — the panel-embedded webview has no native
	 * suspend of its own, so this is the residency lever (sidepanel browser
	 * rendering design, batch B). Best effort: a guest mid-load or without a
	 * bound debugger reports `{ok:false}` and the renderer simply keeps the
	 * tab unfrozen.
	 */
	async setTabLifecycle(input) {
		const tab = this.tabs.get(String(input?.tabId));
		if (!tab) return { ok: false, error: "unknown tab" };
		if (!(await tab.whenDebuggerReady())) return { ok: false, error: "browser tab is not ready" };
		const wc = tab.wc;
		if (!wc || wc.isDestroyed()) return { ok: false, error: "browser tab is not ready" };
		const state = input?.state === "frozen" ? "frozen" : "active";
		try {
			await wc.debugger.sendCommand("Page.enable");
			await wc.debugger.sendCommand("Page.setWebLifecycleState", { state });
			tab.frozen = state === "frozen";
			return { ok: true };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
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
		ipcMain.handle("managed-browser:set-zoom", (_e, input) => this.setZoom(input));
		ipcMain.handle("managed-browser:clear-data", (_e, input) =>
			this.clearBrowserData(input?.mode === "all" ? "all" : "cookies"),
		);
		ipcMain.handle("managed-browser:print", (_e, input) => this.printTab(input?.tabId));
		ipcMain.handle("managed-browser:save-screenshot", (_e, input) => this.saveScreenshot(input?.tabId));
		ipcMain.handle("managed-browser:show-downloads", () => this.showDownloads());
		ipcMain.handle("managed-browser:extensions-list", () => this.listExtensions());
		ipcMain.handle("managed-browser:extensions-choose", () => this.chooseExtension());
		ipcMain.handle("managed-browser:extensions-install", (_e, input) => this.installExtension(input));
		ipcMain.handle("managed-browser:extensions-remove", (_e, input) => this.removeExtension(input));
		// Settings → 浏览器: default zoom / UA / search engine / download policy.
		ipcMain.handle("managed-browser:set-preferences", (_e, input) => this.setPreferences(input));
		// Page freeze/thaw for tab residency (CDP `Page.setWebLifecycleState`).
		ipcMain.handle("managed-browser:set-lifecycle", (_e, input) => this.setTabLifecycle(input));
		ipcMain.handle("managed-browser:stop", (_e, tabId) => this.stopOp(tabId));
		ipcMain.handle("managed-browser:takeover", (_e, tabId) => this.takeoverOp(tabId));
		ipcMain.handle("managed-browser:confirm-result", (_e, input) => {
			const pending = this.pendingConfirm;
			if (!pending || !input || pending.requestId !== input.requestId) return { ok: false };
			clearTimeout(pending.timer);
			this.pendingConfirm = null;
			pending.resolve(Boolean(input.allow));
			return { ok: true };
		});
		// In-app upload card: the OS picker and the renderer's decision.
		ipcMain.handle("managed-browser:pick-upload-files", (_e, input) => this.pickUploadFiles(input));
		ipcMain.handle("managed-browser:upload-result", (_e, input) => this.resolveUploadResult(input));
		// Guest lifecycle: the renderer owns the elements, so it is the only
		// source of truth for which webContents belongs to which tab.
		ipcMain.handle("managed-browser:host-ready", () => this.handleHostReady());
		ipcMain.handle("managed-browser:guest-ready", (_e, input) => this.handleGuestReady(input));
		ipcMain.handle("managed-browser:guest-gone", (_e, tabId) => this.handleGuestGone(tabId));
		ipcMain.handle("managed-browser:active-tab", (_e, tabId) => {
			// The renderer is the selection authority and may report a tab
			// before its guest attaches — adopt the id unconditionally.
			if (typeof tabId !== "string" || !tabId) return { ok: false };
			this.activeTabId = tabId;
			this.emitState({});
			return { ok: true };
		});
		ipcMain.handle("managed-browser:visibility", (_e, input) => {
			this.panelVisible = input?.visible === true;
			// The pane is showing: a pending agent-activity flag has done its
			// job (the renderer auto-opens the browser view on it).
			this.emitState({ agentActivity: false });
			return { ok: true };
		});
		// 标注截图:对指定 guest 截整页可见区。capturePage() 在没有合成表面
		// 的 guest 上永不返回(与 CDP 路径相同的坑),所以同样加超时。
		ipcMain.handle("managed-browser:capture-page", async (_e, input) => {
			const webContentsId = Number(input?.webContentsId);
			if (!Number.isInteger(webContentsId)) return null;
			const wc = webContents.fromId(webContentsId);
			if (!wc || wc.isDestroyed()) return null;
			try {
				const image = await Promise.race([
					wc.capturePage(),
					new Promise((_resolve, reject) => {
						setTimeout(() => reject(new Error("capture-page timed out")), CAPTURE_TIMEOUT_MS);
					}),
				]);
				if (!image) return null;
				return {
					mime: "image/png",
					base64: image.toPNG().toString("base64"),
					width: image.getSize().width,
					height: image.getSize().height,
				};
			} catch {
				return null;
			}
		});
	}
}

module.exports = {
	ManagedBrowserController,
	DEFAULT_PORT,
	LOCAL_PREVIEW_SCHEME,
	// Pure helpers the upload/local-preview tests exercise without Electron.
	normalizeAddressBarUrl,
	localPreviewFilePath,
	localPreviewFileUrl,
	isLocalPreviewUrl,
	sanitizeUploadRequest,
	validateUploadPaths,
	uploadFilters,
	uploadAcceptList,
};
