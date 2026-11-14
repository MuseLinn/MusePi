/**
 * Managed in-app browser pane (Proma 吸收 + open-design DesignBrowserPanel
 * UI/UX 吸收).
 *
 * 页面是 DOM 里的 `<webview>`,由常驻的 `ManagedBrowserHost` 持有 —— 本组件只渲染
 * chrome(地址栏/菜单/台账/起始页),并把内容槽位的 rect 报给宿主定位。
 * 因为页面参与 DOM 层叠,菜单、悬浮提示与右侧面板的 4px 拖拽手柄都按普通 z-index
 * 正常显示;原生 `WebContentsView` 时代的「让位 4px」「有浮层就隐藏页面」规避
 * 全部删除。
 *
 * 空白标签显示 React 起始页(快速链接 + 最近访问),它盖在 about:blank 的 guest
 * 之上 —— guest 不因此卸载,agent 仍可继续驱动它。
 *
 * The agent's browser tool drives the SAME guests through the loopback CDP
 * bridge (`browser.gui`), so user and agent share one browser instance and its
 * persistent login state; agent operations surface in the activity line and
 * auto-open the panel (ContextPanel listens for agentActivity).
 */
import { t } from "@musepi/client-core";
import { dispatchAnnotationResult, resolveAnnotationOverlayTheme } from "@musepi/client-core/src/annotation";
import { annotationOverlayLabels, widgetHostTheme } from "@musepi/client-core/src/widgets/html";
import { Eye as EyeIconData, EyeOff as EyeOffIconData, RefreshCw as RefreshCwIconData, X as XIconData } from "lucide";
import { MorphIcon } from "morphicons/react";
import type { KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAgentTabControl } from "../lib/agent-tab-control";
import { type AnnotationHost, cancelAnnotationSession, runAnnotationSession } from "../lib/annotation-session";
import { formatAddressDisplayParts } from "../lib/browser-address";
import { browserMenuModel } from "../lib/browser-menu-model";
import { BROWSER_PREFERENCES_CHANGED_EVENT, readBrowserShowFullUrl } from "../lib/browser-preferences";
import {
	beginViewportDrag,
	cancelViewportDragOnBlank,
	clampViewportSize,
	fitViewport,
	resolveViewportScale,
	viewportClip,
	viewportControlsVisible,
	viewportOverflow,
} from "../lib/browser-viewport";
import type { ManagedBrowserPreferences } from "../lib/electron";
import { copyToClipboard, openExternalUrl, setManagedBrowserPreferences } from "../lib/electron";
import type { BrowserPageContextDetail } from "../lib/managed-browser-host";
import {
	allowAgentUpload,
	answerConfirm,
	browserTabsForSession,
	cancelUpload,
	chooseUploadFiles,
	clearData as clearBrowserDataInStore,
	createTab,
	findInActivePage,
	getHostState,
	goBack,
	goForward,
	hostElement,
	navigate as navigateInStore,
	printActivePage,
	reload,
	resolveAddressBarInput,
	saveActivePageScreenshot,
	selectTab,
	setBrowserSession,
	setPaneRect,
	showDownloads,
	stopAgentOp,
	stopFindInActivePage,
	subscribeHost,
	takeoverAgentOp,
} from "../lib/managed-browser-host";
import type { RpcClient } from "../lib/rpc";
import { type SuggestionStepKey, stepSuggestionIndex } from "../lib/suggestion-nav";
import { useFloatingMenu } from "../lib/use-floating-menu";
import { Icon } from "../vendor/oc-icons";
import { BrowserAgentMark } from "./browser-agent-mark";
import { BrowserControlOverlay } from "./browser-control-overlay";
import {
	BROWSER_VIEWPORTS,
	BrowserDeviceToolbar,
	type BrowserPageBackground,
	type BrowserViewportPreset,
	readBrowserDeviceToolbarVisibility,
	setBrowserDeviceToolbarVisibility,
} from "./browser-device-toolbar";
import { BrowserUploadDialog } from "./browser-upload-dialog";
import { ContextMenu } from "./ContextMenu";
import { ManagedBrowserExtensions } from "./managed-browser-extensions";

// ── URL helpers (open-design DesignBrowserPanel parity) ───────────────

const EMPTY_URL = "about:blank";
const HISTORY_KEY = "musepi-gui-managed-browser-history";
const HISTORY_LIMIT = 80;
const HISTORY_SUGGESTION_LIMIT = 20;

// ── runtime preferences (设置 → 浏览器) ───────────────────────────────
// Main applies these to every open tab and to tabs created later; the pane
// reads them through the daemon and re-pushes on the settings page's save
// event, so a running browser never needs a restart.
const BROWSER_SETTINGS_KEYS = [
	"browser.zoom",
	"browser.userAgent",
	"browser.searchEngine",
	"browser.download.askWhereToSave",
	"browser.download.dir",
	"browser.download.agentMaxBytes",
];
const BROWSER_SETTINGS_CHANGED_EVENT = "musepi-browser-settings-changed";
const DEFAULT_BROWSER_PREFERENCES: ManagedBrowserPreferences = {
	zoom: 1,
	userAgent: "",
	searchEngine: "google",
	download: { askWhereToSave: true, dir: "", maxBytes: 5 * 1024 * 1024 * 1024 },
};

function preferencesFromSettings(values: Record<string, unknown> | null): ManagedBrowserPreferences {
	const zoom = Number(values?.["browser.zoom"]);
	const userAgent = values?.["browser.userAgent"];
	const engine = values?.["browser.searchEngine"];
	const askWhereToSave = values?.["browser.download.askWhereToSave"];
	const dir = values?.["browser.download.dir"];
	const maxBytes = Number(values?.["browser.download.agentMaxBytes"]);
	return {
		zoom: Number.isFinite(zoom) && zoom > 0 ? zoom : DEFAULT_BROWSER_PREFERENCES.zoom,
		userAgent: typeof userAgent === "string" ? userAgent : DEFAULT_BROWSER_PREFERENCES.userAgent,
		searchEngine: typeof engine === "string" && engine ? engine : DEFAULT_BROWSER_PREFERENCES.searchEngine,
		download: {
			askWhereToSave: askWhereToSave !== false,
			dir: typeof dir === "string" ? dir : DEFAULT_BROWSER_PREFERENCES.download?.dir,
			maxBytes:
				Number.isFinite(maxBytes) && maxBytes >= 0 ? maxBytes : DEFAULT_BROWSER_PREFERENCES.download?.maxBytes,
		},
	};
}

interface BrowserHistoryEntry {
	title: string;
	url: string;
	lastVisitedAt: number;
	visitCount: number;
}

function isHistoryEntry(value: unknown): value is BrowserHistoryEntry {
	if (typeof value !== "object" || value == null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.url === "string" &&
		typeof record.title === "string" &&
		typeof record.lastVisitedAt === "number" &&
		typeof record.visitCount === "number"
	);
}

function loadHistory(): BrowserHistoryEntry[] {
	try {
		const raw = window.localStorage.getItem(HISTORY_KEY);
		const parsed = raw ? JSON.parse(raw) : [];
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter(isHistoryEntry)
			.sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)
			.slice(0, HISTORY_LIMIT);
	} catch {
		return [];
	}
}

function saveHistory(history: BrowserHistoryEntry[]): void {
	try {
		window.localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, HISTORY_LIMIT)));
	} catch {
		// storage quota / private mode — best effort
	}
}

function sameUrl(left: string, right: string): boolean {
	return left.replace(/\/+$/, "") === right.replace(/\/+$/, "");
}

// ── zoom persistence (§3.2.1): per-tab factor in localStorage ─────────
const ZOOM_KEY = "musepi-gui-managed-browser-zoom";

function loadZooms(): Record<string, number> {
	try {
		const raw = window.localStorage.getItem(ZOOM_KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : {};
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		return Object.fromEntries(
			Object.entries(parsed as Record<string, unknown>).filter(
				(entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]),
			),
		);
	} catch {
		return {};
	}
}

function saveZooms(zooms: Record<string, number>): void {
	try {
		window.localStorage.setItem(ZOOM_KEY, JSON.stringify(zooms));
	} catch {
		// storage quota — best effort
	}
}

function labelFromUrl(url: string): string {
	if (url === EMPTY_URL) return t("tools.browserEmptyTab");
	try {
		const parsed = new URL(url);
		return parsed.hostname.replace(/^www\./, "") || url;
	} catch {
		return url;
	}
}

function hostnameFromUrl(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

function faviconUrl(url: string): string | undefined {
	if (!/^https?:\/\//i.test(url)) return undefined;
	try {
		return new URL("/favicon.ico", new URL(url).origin).toString();
	} catch {
		return undefined;
	}
}

function isHistoryUrl(url: string): boolean {
	return url !== EMPTY_URL && (/^https?:\/\//i.test(url) || /^musepi-file:\/\//i.test(url));
}

// ── quick links (start page 快速链接) ─────────────────────────────────

const QUICK_LINKS: Array<{
	label: string;
	url: string;
	icon: "github" | "search" | "book" | "terminal" | "chat-1" | "compass-3";
}> = [
	{ label: "GitHub", url: "https://github.com", icon: "github" },
	{ label: "Google", url: "https://www.google.com", icon: "search" },
	{ label: "Bing", url: "https://www.bing.com", icon: "search" },
	{ label: "MDN", url: "https://developer.mozilla.org", icon: "book" },
	{ label: "Stack Overflow", url: "https://stackoverflow.com", icon: "terminal" },
	{ label: "DeepL", url: "https://www.deepl.com", icon: "chat-1" },
];

export function ManagedBrowserPane({
	open = true,
	openRequest = null,
	onTakeover,
	rpc = null,
	sessionId = null,
}: {
	/** External reveal (chat link click / agent browser open): navigate the
	 *  active tab to this URL when the nonce advances (proma
	 *  AgentBrowserLinkProvider parity). */
	openRequest?: { url: string; nonce: number; preferAgentTab?: boolean } | null;
	/** Panel fold state. A closed panel keeps this pane mounted at width 0, so
	 *  the pane cannot infer visibility from its own geometry. */
	open?: boolean;
	/** Stop the current session turn without closing the managed page. */
	onTakeover?(): void;
	/** Daemon RPC bridge (settings.get): reads the browser preferences main
	 *  applies to the guests. */
	rpc?: RpcClient | null;
	/** Chat session owning this pane; its browser tabs are isolated per session. */
	sessionId?: string | null;
} = {}): ReactNode {
	// 页面状态在宿主 store 里(`<webview>` 元素由常驻的 ManagedBrowserHost 持有);
	// 本组件只渲染 chrome,并把内容槽位的 rect 报给宿主定位。
	const host = useSyncExternalStore(subscribeHost, getHostState);
	const sessionTabs = browserTabsForSession(sessionId, host);
	useEffect(() => setBrowserSession(sessionId), [sessionId]);
	const [annotating, setAnnotating] = useState(false);
	const annotationHostRef = useRef<AnnotationHost | null>(null);
	// Address omnibox state: editing shows the raw URL,
	// idle shows `host / title` display parts.
	const [addressValue, setAddressValue] = useState("");
	const [addressEditing, setAddressEditing] = useState(false);
	const [suggestionsOpen, setSuggestionsOpen] = useState(false);
	const [suggestionIndex, setSuggestionIndex] = useState(-1);
	const [history, setHistory] = useState<BrowserHistoryEntry[]>(() => loadHistory());
	const [menuOpen, setMenuOpen] = useState(false);
	const [extensionsOpen, setExtensionsOpen] = useState(false);
	const [showFullUrl, setShowFullUrl] = useState(readBrowserShowFullUrl);
	useEffect(() => {
		const onPreferences = (event: Event): void => {
			const detail = (event as CustomEvent<{ key?: string }>).detail;
			if (detail?.key === "showFullUrl") setShowFullUrl(readBrowserShowFullUrl());
		};
		window.addEventListener(BROWSER_PREFERENCES_CHANGED_EVENT, onPreferences);
		return () => window.removeEventListener(BROWSER_PREFERENCES_CHANGED_EVENT, onPreferences);
	}, []);
	// Settings → 浏览器: read on mount and re-read when the settings page
	// commits (it dispatches `musepi-browser-settings-changed`), then push the
	// result to main so open tabs and tabs created later share one policy.
	const [preferences, setPreferences] = useState<ManagedBrowserPreferences>(DEFAULT_BROWSER_PREFERENCES);
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		const load = (): void => {
			void rpc
				.request<Record<string, unknown>>("settings.get", { keys: BROWSER_SETTINGS_KEYS })
				.then(values => {
					if (!alive) return;
					const next = preferencesFromSettings(values);
					setPreferences(next);
					void setManagedBrowserPreferences(next);
				})
				.catch(() => {});
		};
		load();
		const onChange = (): void => load();
		window.addEventListener(BROWSER_SETTINGS_CHANGED_EVENT, onChange);
		return () => {
			alive = false;
			window.removeEventListener(BROWSER_SETTINGS_CHANGED_EVENT, onChange);
		};
	}, [rpc]);
	const defaultZoom = preferences.zoom ?? 1;
	// Preset KEY, not its width: the key also carries the device identity the
	// page is served under (see the device-preset effect below), while the
	// width drives the fit-scaling.
	const [viewportKey, setViewportKey] = useState<BrowserViewportPreset>("tools.browserViewportFit");
	const activePreset = BROWSER_VIEWPORTS.find(preset => preset.key === viewportKey) ?? BROWSER_VIEWPORTS[0];
	const [displayScale, setDisplayScale] = useState<"fit" | number>("fit");
	const [pageBackground, setPageBackground] = useState<BrowserPageBackground>("auto");
	const [copied, setCopied] = useState(false);
	const [pageContext, setPageContext] = useState<BrowserPageContextDetail | null>(null);
	const slotRef = useRef<HTMLDivElement | null>(null);
	const contentRef = useRef<HTMLDivElement | null>(null);
	const [controlRect, setControlRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
	const [pageOrigin, setPageOrigin] = useState<{ x: number; y: number } | null>(null);
	const [findOpen, setFindOpen] = useState(false);
	const [findQuery, setFindQuery] = useState("");
	const [deviceToolbarVisible, setDeviceToolbarVisible] = useState(readBrowserDeviceToolbarVisibility);
	const [keepPageFocused, setKeepPageFocused] = useState(false);
	const urlRef = useRef<HTMLInputElement | null>(null);

	const activeTab = sessionTabs.find(tab => tab.id === host.activeId) ?? null;
	const activeUrl = activeTab?.url ?? EMPTY_URL;
	const availability = browserMenuModel(activeTab);
	const isBlank = !availability.hasPage;
	const deviceToolbarActive = deviceToolbarVisible && availability.hasPage;
	const activePresetForPage = deviceToolbarActive ? activePreset : BROWSER_VIEWPORTS[0];
	const pageDisplayScale = deviceToolbarActive ? displayScale : "fit";
	const changeDeviceToolbarVisibility = useCallback((visible: boolean): void => {
		setBrowserDeviceToolbarVisibility(visible);
		setDeviceToolbarVisible(visible);
	}, []);

	// ── Zoom controls (§3.2.1, zcode parity): per-tab factor persisted in
	// localStorage; applied through main (WebContents zoom — independent of
	// the device-preset Emulation overrides, so the two never fight).
	const ZOOM_MIN = 0.5;
	const ZOOM_MAX = 2;
	const [zoomByTab, setZoomByTab] = useState<Record<string, number>>(() => loadZooms());
	const activeZoom = (host.activeId ? zoomByTab[host.activeId] : undefined) ?? defaultZoom;
	const setActiveZoom = (next: number): void => {
		const id = host.activeId;
		if (!id) return;
		const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next * 100) / 100));
		setZoomByTab(current => ({ ...current, [id]: clamped }));
	};
	useEffect(() => {
		const timer = window.setTimeout(() => saveZooms(zoomByTab), 200);
		return () => window.clearTimeout(timer);
	}, [zoomByTab]);
	// Only an EXPLICIT per-tab factor is pushed; tabs without one stay on the
	// settings default, which main applies at bind and on preference changes.
	useEffect(() => {
		const api = window.electronAPI;
		const tabId = host.activeId;
		const override = tabId ? zoomByTab[tabId] : undefined;
		if (!api?.managedBrowserSetZoom || !tabId || isBlank || override === undefined) return;
		void api.managedBrowserSetZoom({ tabId, zoom: override }).catch(() => {});
	}, [host.activeId, zoomByTab, isBlank]);

	useEffect(() => {
		setFindOpen(false);
		setFindQuery("");
		stopFindInActivePage();
	}, [host.activeId]);

	useEffect(() => {
		if (!keepPageFocused || isBlank || !host.activeId) return;
		const webview = hostElement(host.activeId);
		if (!webview) return;
		let frame = 0;
		const focusPage = (): void => {
			window.cancelAnimationFrame(frame);
			frame = window.requestAnimationFrame(() => webview.focus());
		};
		focusPage();
		webview.addEventListener("blur", focusPage);
		return () => {
			window.cancelAnimationFrame(frame);
			webview.removeEventListener("blur", focusPage);
		};
	}, [host.activeId, isBlank, keepPageFocused]);

	// Custom emulated size while a preset is active (§3.2.2): the dashed
	// viewport frame's right/bottom handles drag the preset away from the
	// catalog value (width floor 320). Reset when the preset changes.
	const [customVp, setCustomVp] = useState<{ width: number; height: number | null } | null>(null);
	const deviceViewport = activePresetForPage.width;
	const presetWidth = deviceViewport === null ? null : (customVp?.width ?? deviceViewport);
	const presetHeight = customVp?.height ?? activePresetForPage.height;
	useEffect(() => setCustomVp(null), [viewportKey]);
	// Viewport-frame geometry for the drag handles, measured in report().
	const [pageBox, setPageBox] = useState<{
		left: number;
		width: number;
		height: number;
		scale: number;
		layoutWidth: number;
		layoutHeight: number;
	} | null>(null);
	const [pageOverflow, setPageOverflow] = useState({ x: false, y: false });
	const vpDragRef = useRef<{ axis: "x" | "y"; startClient: number; startSize: number; scale: number } | null>(null);

	// Device identity: a preset has to change what the SITE serves, not just
	// the box — at phone width with a desktop UA, UA-sniffing sites (bing.com,
	// google.com) keep sending their desktop document. Main applies the
	// UA/client-hints/touch override on the active tab; switching the preset
	// reloads so the page re-serves, while a tab switch re-applies silently.
	const device = activePresetForPage.device;
	// Identity AND emulated layout size ride one channel, because main owns the
	// guest's debugger. Both matter: the preset decides what the SITE serves
	// (UA + client hints + touch), and the page's viewport has to be emulated
	// (the host is transform-scaled to fit the pane, which shrinks the guest's
	// viewport with it — measured: a 1440-wide host under scale(0.227) left the
	// page a 327px viewport, so wide presets only zoomed the desktop layout out
	// instead of giving it room).
	const deviceSyncRef = useRef<{ tabId: string; device: string; width: number; height: number } | null>(null);
	const syncContextRef = useRef({ tabId: isBlank ? null : host.activeId, device });
	syncContextRef.current = { tabId: isBlank ? null : host.activeId, device };
	const syncDevice = useCallback(
		(tabId: string, deviceKey: string, size: { width: number; height: number } | null, reload: boolean): void => {
			const api = window.electronAPI;
			if (!api?.managedBrowserSetDevice || !tabId) return;
			const width = size?.width ?? 0;
			const height = size?.height ?? 0;
			const last = deviceSyncRef.current;
			// The re-measure loop reports size changes too, so dedupe with a small
			// tolerance: an IPC per pixel of a window drag is not free.
			const unchanged =
				last?.tabId === tabId &&
				last.device === deviceKey &&
				Math.abs(last.width - width) <= 4 &&
				Math.abs(last.height - height) <= 4;
			if (unchanged && !reload) return;
			deviceSyncRef.current = { tabId, device: deviceKey, width, height };
			void api
				.managedBrowserSetDevice({ tabId, preset: deviceKey, reload, viewport: size ?? undefined })
				.then(result => {
					// A silent failure leaves the page on the wrong identity/size
					// with no trace: both are invisible until the next load.
					if (result?.ok === false) console.warn("[managed-browser] device preset failed:", result.error);
				})
				.catch(() => {});
		},
		[],
	);
	/** Emulated layout size for the active preset (null while the pane fills the
	 *  slot: there is nothing to emulate). */
	const deviceSize = useCallback((): { width: number; height: number } | null => {
		const el = slotRef.current;
		if (!el || presetWidth === null) return null;
		const avail = el.getBoundingClientRect();
		if (avail.width <= 0 || avail.height <= 0) return null;
		const fit = fitViewport(presetWidth, avail.width);
		const scale = resolveViewportScale(fit.scale, pageDisplayScale);
		return { width: fit.width, height: Math.round(presetHeight ?? avail.height / scale) };
	}, [presetWidth, presetHeight, pageDisplayScale]);
	useEffect(() => {
		if (isBlank || !host.activeId) return;
		const previous = deviceSyncRef.current;
		// Reload only when the IDENTITY changed on the tab already on screen: a
		// tab switch re-applies silently instead of yanking the page.
		syncDevice(host.activeId, device, deviceSize(), previous?.tabId === host.activeId && previous.device !== device);
	}, [host.activeId, device, deviceSize, isBlank, syncDevice]);

	// Persist history (debounced, open-design parity).
	useEffect(() => {
		const timer = window.setTimeout(() => saveHistory(history), 140);
		return () => window.clearTimeout(timer);
	}, [history]);

	// Commit a visit whenever the active tab lands on a real URL.
	useEffect(() => {
		if (!activeTab || !isHistoryUrl(activeTab.url)) return;
		setHistory(current => {
			const existing = current.find(entry => sameUrl(entry.url, activeTab.url));
			const nextTitle = activeTab.title?.trim() || existing?.title || labelFromUrl(activeTab.url);
			const entry: BrowserHistoryEntry = existing
				? {
						...existing,
						title: nextTitle,
						lastVisitedAt: Date.now(),
						visitCount: existing.visitCount + 1,
					}
				: { title: nextTitle, url: activeTab.url, lastVisitedAt: Date.now(), visitCount: 1 };
			if (existing && existing.title === entry.title && existing.visitCount === entry.visitCount) return current;
			return [entry, ...current.filter(item => !sameUrl(item.url, activeTab.url))].slice(0, HISTORY_LIMIT);
		});
	}, [activeTab]);

	/** 统一标注(与会话内 HTML 卡片同一份 overlay):注入页面 → 用户选元素/
	 *  区域/绘制+注释 → 拆 chrome → 页面截图 → 合成带标记的图 → 附图+prompt
	 *  一起进 composer。页面本身从不被修改 —— 标注只标记已有内容。 */
	const handleAnnotate = useCallback(
		(elementAt?: { x: number; y: number }): void => {
			if (annotating) {
				setAnnotating(false);
				if (annotationHostRef.current) void cancelAnnotationSession(annotationHostRef.current);
				return;
			}
			const tabId = host.activeId;
			const webview = tabId ? hostElement(tabId) : null;
			if (isBlank || !webview) {
				window.dispatchEvent(new CustomEvent("musepi-gui-toast", { detail: t("annotation.noPage") }));
				return;
			}
			const sessionHost: AnnotationHost = {
				executeJavaScript: (code, userGesture) => webview.executeJavaScript(code, userGesture),
				capturePage: async () => {
					const webContentsId = webview.getWebContentsId();
					if (!Number.isFinite(webContentsId)) return null;
					try {
						return (await window.electronAPI?.managedBrowserCapturePage({ webContentsId })) ?? null;
					} catch {
						return null;
					}
				},
			};
			annotationHostRef.current = sessionHost;
			const theme = resolveAnnotationOverlayTheme(widgetHostTheme());
			setAnnotating(true);
			void runAnnotationSession({
				host: sessionHost,
				theme,
				// 与会话内 HTML 卡片同一份文案与结构卡(见 annotationOverlayLabels)。
				labels: annotationOverlayLabels(),
				...(elementAt ? { elementAt } : {}),
			})
				.then(result => {
					setAnnotating(false);
					if (!result) return;
					void dispatchAnnotationResult({
						payload: result.payload,
						screenshot: result.screenshot,
						intro: t("annotation.browserIntro"),
					});
					window.dispatchEvent(
						new CustomEvent("musepi-gui-toast", {
							detail: { message: t("annotation.attached"), kind: "success" },
						}),
					);
				})
				.catch(() => {
					setAnnotating(false);
					window.dispatchEvent(new CustomEvent("musepi-gui-toast", { detail: t("annotation.failed") }));
				});
		},
		[annotating, host.activeId, isBlank],
	);

	useEffect(() => {
		const onPageContextMenu = (event: Event): void => {
			const detail = (event as CustomEvent<NonNullable<typeof pageContext>>).detail;
			if (!detail || detail.tabId !== host.activeId) return;
			setPageContext(detail);
		};
		window.addEventListener("musepi-browser-page-context-menu", onPageContextMenu);
		return () => window.removeEventListener("musepi-browser-page-context-menu", onPageContextMenu);
	}, [host.activeId]);

	// Escape 从应用侧退出标注:overlay 自己处理页面内的 Escape,但焦点可能在
	// 面板上而不是页面里。
	useEffect(() => {
		if (!annotating) return;
		const handler = (event: globalThis.KeyboardEvent): void => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopImmediatePropagation();
			setAnnotating(false);
			if (annotationHostRef.current) void cancelAnnotationSession(annotationHostRef.current);
		};
		window.addEventListener("keydown", handler, true);
		return () => window.removeEventListener("keydown", handler, true);
	}, [annotating]);

	// First open with no tabs: give the host one to mount (main learns about it
	// through guest-ready, so no IPC call is needed here).
	useEffect(() => {
		if (sessionTabs.length === 0) void createTab(EMPTY_URL).catch(() => {});
	}, [sessionTabs.length]);

	// 内容槽位是宿主的「定位靶」:页面元素在同级常驻宿主里,这里只把槽位 rect 交给
	// store,由宿主用 fixed 定位浮上来(纯 DOM,无 IPC)。槽位卸载 = 面板关闭;宿主
	// 保持挂载并转不可见 —— agent 仍可继续驱动并截图。
	useLayoutEffect(() => {
		const el = slotRef.current;
		if (!el) return;
		if (!open) {
			setPaneRect(null);
			return;
		}
		const report = (): void => {
			const avail = el.getBoundingClientRect();
			const scrollport = contentRef.current?.getBoundingClientRect() ?? avail;
			setPageOrigin(previous =>
				previous && Math.abs(previous.x - avail.x) < 1 && Math.abs(previous.y - avail.y) < 1
					? previous
					: { x: avail.x, y: avail.y },
			);
			const nextControlRect = {
				x: scrollport.x + 5,
				y: scrollport.y + 5,
				width: Math.max(0, scrollport.width - 10),
				height: Math.max(0, scrollport.height - 10),
			};
			setControlRect(previous =>
				previous &&
				Math.abs(previous.x - nextControlRect.x) < 1 &&
				Math.abs(previous.y - nextControlRect.y) < 1 &&
				Math.abs(previous.width - nextControlRect.width) < 1 &&
				Math.abs(previous.height - nextControlRect.height) < 1
					? previous
					: nextControlRect,
			);
			if (presetWidth !== null) {
				const fit = fitViewport(presetWidth, avail.width);
				const scale = resolveViewportScale(fit.scale, pageDisplayScale);
				const layoutHeight = presetHeight ?? avail.height / scale;
				const visualWidth = fit.width * scale;
				const hostX = avail.x + Math.max(0, (avail.width - visualWidth) / 2);
				const overflow = viewportOverflow(fit.width, layoutHeight, scale, avail.width, avail.height);
				setPageOverflow(previous => (previous.x === overflow.x && previous.y === overflow.y ? previous : overflow));
				setPaneRect({
					x: hostX,
					y: avail.y,
					width: fit.width,
					height: layoutHeight,
					scale: scale,
					clip: viewportClip({ x: hostX, y: avail.y, width: fit.width, height: layoutHeight, scale }, scrollport),
				});
				setPageBox(prev => {
					const next = {
						left: Math.max(0, (avail.width - visualWidth) / 2),
						width: visualWidth,
						height: layoutHeight * scale,
						scale: scale,
						layoutWidth: fit.width,
						layoutHeight,
					};
					return prev &&
						Math.abs(prev.left - next.left) < 1 &&
						Math.abs(prev.width - next.width) < 1 &&
						Math.abs(prev.height - next.height) < 1 &&
						Math.abs(prev.layoutWidth - next.layoutWidth) < 1 &&
						Math.abs(prev.layoutHeight - next.layoutHeight) < 1
						? prev
						: next;
				});
				const { tabId: syncedTabId, device: syncedDevice } = syncContextRef.current;
				if (syncedTabId) {
					syncDevice(syncedTabId, syncedDevice, { width: fit.width, height: Math.round(layoutHeight) }, false);
				}
			} else {
				setPageBox(prev => (prev === null ? prev : null));
				const scale = resolveViewportScale(1, pageDisplayScale);
				const visualWidth = avail.width * scale;
				const hostX = avail.x + Math.max(0, (avail.width - visualWidth) / 2);
				setPageOverflow(previous => {
					const overflow = viewportOverflow(avail.width, avail.height, scale, avail.width, avail.height);
					return previous.x === overflow.x && previous.y === overflow.y ? previous : overflow;
				});
				setPaneRect({
					x: hostX,
					y: avail.y,
					width: avail.width,
					height: avail.height,
					scale,
					clip: viewportClip(
						{ x: hostX, y: avail.y, width: avail.width, height: avail.height, scale },
						scrollport,
					),
				});
			}
		};
		report();
		const ro = new ResizeObserver(report);
		ro.observe(el);
		// A layout shift that MOVES the slot without resizing it (sidebar
		// collapse, side-panel drag, transcript reflow, panel maximize) fires no
		// ResizeObserver event and no window event — the host then keeps the old
		// rect, so the page looks oversized/clipped and clicks land off-target.
		// Re-measure on a cheap interval while the pane is mounted.
		const timer = window.setInterval(report, 200);
		window.addEventListener("resize", report);
		window.addEventListener("scroll", report, true);
		window.addEventListener("transitionend", report, true);
		return () => {
			window.clearInterval(timer);
			ro.disconnect();
			window.removeEventListener("resize", report);
			window.removeEventListener("scroll", report, true);
			window.removeEventListener("transitionend", report, true);
			setPaneRect(null);
		};
	}, [open, presetWidth, presetHeight, pageDisplayScale, syncDevice]);

	// Viewport-handle drag (§3.2.2): the pointer delta is visual px; convert
	// through the fit scale so dragging feels 1:1 on screen. Width floor 320
	// (design minimum); height floor 480.
	useEffect(() => {
		vpDragRef.current = cancelViewportDragOnBlank(vpDragRef.current, availability.hasPage);
	}, [availability.hasPage]);

	const startVpDrag = (e: React.PointerEvent<HTMLButtonElement>, axis: "x" | "y"): void => {
		e.preventDefault();
		if (!availability.hasPage || presetWidth === null || pageBox === null) return;
		vpDragRef.current = beginViewportDrag(availability.hasPage, pageBox, axis, axis === "x" ? e.clientX : e.clientY);
		if (vpDragRef.current) e.currentTarget.setPointerCapture(e.pointerId);
	};
	const onVpDragMove = (e: React.PointerEvent<HTMLButtonElement>): void => {
		if (!availability.hasPage) {
			vpDragRef.current = null;
			return;
		}
		const drag = vpDragRef.current;
		if (!drag) return;
		const delta = ((drag.axis === "x" ? e.clientX : e.clientY) - drag.startClient) / drag.scale;
		if (drag.axis === "x") {
			const size = clampViewportSize(drag.startSize + delta, pageBox?.layoutHeight ?? 480);
			setCustomVp(current => ({ width: size.width, height: current?.height ?? null }));
		} else {
			const size = clampViewportSize(pageBox?.layoutWidth ?? 320, drag.startSize + delta);
			setCustomVp(current => ({ width: current?.width ?? presetWidth ?? 393, height: size.height }));
		}
	};
	const endVpDrag = (): void => {
		vpDragRef.current = null;
	};

	// Report the fold itself: main's `panelVisible` gates the agent-activity
	// reveal, and a folded panel keeps this pane mounted (width 0) with a
	// non-degenerate rect — the reveal then never fires and the agent's work
	// stays unseen.
	useEffect(() => {
		void window.electronAPI?.managedBrowserVisibility(open).catch(() => {});
	}, [open]);

	const commitVisit = useCallback((url: string): void => {
		if (!isHistoryUrl(url)) return;
		const now = Date.now();
		setHistory(current => {
			const existing = current.find(entry => sameUrl(entry.url, url));
			const entry: BrowserHistoryEntry = existing
				? { ...existing, lastVisitedAt: now, visitCount: existing.visitCount + 1 }
				: { title: labelFromUrl(url), url, lastVisitedAt: now, visitCount: 1 };
			return [entry, ...current.filter(item => !sameUrl(item.url, url))].slice(0, HISTORY_LIMIT);
		});
	}, []);

	const navigateTo = useCallback(
		async (target: string): Promise<void> => {
			const trimmed = target.trim();
			if (!trimmed) return;
			// Main normalizes the address (localhost / local-preview paths) and owns
			// the risk policy, then loads the guest; failures land in the host store.
			const ok = await navigateInStore(trimmed);
			if (!ok) return;
			commitVisit(trimmed);
			setAddressEditing(false);
			setSuggestionsOpen(false);
		},
		[commitVisit],
	);

	const handleAddressSubmit = (e: React.FormEvent): void => {
		e.preventDefault();
		// URLs keep the existing completion path; anything else is a search
		// through the configured engine (设置 → 浏览器).
		void navigateTo(resolveAddressBarInput(addressValue, preferences.searchEngine));
	};

	// Transcript step/thumbnail jump asks for the agent's dedicated tab; the
	// tool dispatches this after musepi-open-url has opened the panel.
	useEffect(() => {
		const focusAgentTab = (): void => {
			const agentTab = getHostState().tabs.find(tab => tab.agent);
			if (agentTab) selectTab(agentTab.id);
		};
		window.addEventListener("musepi-browser-focus-agent", focusAgentTab);
		return () => window.removeEventListener("musepi-browser-focus-agent", focusAgentTab);
	}, []);

	// External reveal: chat link clicks (and agent browser.open) navigate the
	// active tab. The nonce makes repeated clicks on the same URL re-trigger.
	const lastReveal = useRef(0);
	useEffect(() => {
		if (!openRequest || openRequest.nonce === lastReveal.current) return;
		lastReveal.current = openRequest.nonce;
		// Transcript "View"/thumbnail jumps target the agent's dedicated tab;
		// a user tab stays put when the request came from a chat link.
		if (openRequest.preferAgentTab) {
			const agentTab = getHostState().tabs.find(tab => tab.agent);
			if (agentTab) selectTab(agentTab.id);
		}
		void navigateTo(openRequest.url);
	}, [openRequest, navigateTo]);

	// Suggestions: history entries filtered by the query.
	const suggestions = useMemo(() => {
		const query = addressValue.trim().toLocaleLowerCase();
		const showDefault = addressEditing && !query;
		const historySuggestions = history.slice(0, HISTORY_SUGGESTION_LIMIT).map(entry => ({
			key: `history:${entry.url}`,
			label: entry.title || labelFromUrl(entry.url),
			detail: entry.url,
			icon: "history" as const,
			url: entry.url,
		}));
		if (showDefault || !query) return historySuggestions;
		return historySuggestions.filter(item => `${item.label} ${item.detail}`.toLocaleLowerCase().includes(query));
	}, [addressEditing, addressValue, history]);

	// Every dropdown renders through the app's single floating-menu primitive:
	// its portal is the only tier that can paint over the page (the pane sits
	// inside the chat surface's stacking context while the page host is a
	// root-level element), and it owns positioning, enter/exit and dismissal.
	const suggestionsVisible = suggestionsOpen && suggestions.length > 0;
	const { anchorRef: addressAnchorRef, renderMenu: renderSuggestions } = useFloatingMenu(
		suggestionsVisible,
		open => {
			if (!open) setSuggestionsOpen(false);
		},
		{ className: "gui-browser-suggestions" },
	);
	const { anchorRef: actionsAnchorRef, renderMenu: renderActionsMenu } = useFloatingMenu(menuOpen, setMenuOpen, {
		className: "gui-browser-menu",
		align: "right",
	});
	const { anchorRef: extensionsAnchorRef, renderMenu: renderExtensionsMenu } = useFloatingMenu(
		extensionsOpen,
		setExtensionsOpen,
		{ className: "gui-browser-extensions-popup", align: "right" },
	);
	const addressDisplayParts = addressEditing
		? { url: "" }
		: formatAddressDisplayParts(activeUrl, activeTab?.title, showFullUrl);
	const shownAddressValue = addressEditing ? addressValue : "";
	const pageIconUrl = faviconUrl(activeUrl);

	const copyCurrentUrl = useCallback(async (): Promise<void> => {
		if (!(await copyToClipboard(activeUrl))) throw new Error(t("tools.browserCopyUrlFailed"));
		setCopied(true);
		window.setTimeout(() => setCopied(false), 1400);
	}, [activeUrl]);

	const runBrowserAction = useCallback(async (action: () => Promise<void>): Promise<void> => {
		try {
			await action();
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			window.dispatchEvent(
				new CustomEvent("musepi-gui-toast", { detail: t("tools.browserActionFailed", { detail }) }),
			);
		}
	}, []);

	const clearHistory = useCallback((): void => {
		setHistory([]);
		saveHistory([]);
		setMenuOpen(false);
	}, []);

	const clearBrowserData = useCallback(
		(mode: "cookies" | "all"): void => {
			setMenuOpen(false);
			void runBrowserAction(async () => {
				await clearBrowserDataInStore(mode);
				window.dispatchEvent(
					new CustomEvent("musepi-gui-toast", {
						detail: { message: t("tools.browserDataCleared"), kind: "success" },
					}),
				);
			});
		},
		[runBrowserAction],
	);

	const openHistory = useCallback((): void => {
		setMenuOpen(false);
		if (history.length === 0) {
			window.dispatchEvent(new CustomEvent("musepi-gui-toast", { detail: t("tools.browserNoHistory") }));
			return;
		}
		setAddressEditing(true);
		setSuggestionsOpen(true);
		urlRef.current?.focus();
		window.requestAnimationFrame(() => {
			setAddressValue("");
			setSuggestionsOpen(true);
			urlRef.current?.select();
		});
	}, [history.length]);

	const closeFind = useCallback((): void => {
		setFindOpen(false);
		setFindQuery("");
		stopFindInActivePage();
	}, []);

	const openInSystem = useCallback((): void => {
		if (!availability.canOpenExternal) return;
		void openExternalUrl(activeUrl).catch(() => {});
		setMenuOpen(false);
	}, [activeUrl, availability.canOpenExternal]);

	const onAddressKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
		if (e.key === "Escape") {
			setAddressEditing(false);
			setSuggestionsOpen(false);
			setSuggestionIndex(-1);
			e.currentTarget.blur();
			return;
		}
		if (!suggestionsOpen || suggestions.length === 0) return;
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			// Narrow outside the setState callback — narrowing does not survive
			// into a closure that runs after the event handler returns.
			const step: SuggestionStepKey = e.key;
			e.preventDefault();
			setSuggestionIndex(current => stepSuggestionIndex(current, step, suggestions.length));
			return;
		}
		if (e.key === "Enter" && suggestionIndex >= 0) {
			e.preventDefault();
			const chosen = suggestions[suggestionIndex];
			if (chosen) void navigateTo(chosen.url);
		}
	};

	// A new list is a new choice; keep stale index from highlighting whatever
	// happens to sit at that position now.
	useLayoutEffect(() => {
		setSuggestionIndex(-1);
	}, [addressValue, suggestionsOpen]);

	const activeTabLoading = Boolean(activeTab?.loading);
	// Agent occupancy (§3.2.5): tab-level control survives gaps between tool
	// calls; a single in-flight operation would make the pill blink out.
	const knownTabIds = useMemo(() => sessionTabs.map(tab => tab.id), [sessionTabs]);
	const { control: agentControl, release: releaseAgentControl } = useAgentTabControl(host.activity, knownTabIds);
	const agentBusy = agentControl !== null && agentControl.tabId === host.activeId && !isBlank;
	const handleTakeover = useCallback(async (): Promise<void> => {
		await takeoverAgentOp(agentControl?.tabId);
		releaseAgentControl();
		onTakeover?.();
	}, [agentControl?.tabId, releaseAgentControl, onTakeover]);
	return (
		<div className="gui-browser-pane relative flex min-h-0 flex-1 flex-col">
			{/* Chrome bar: nav / address omnibox / zoom / actions (§3.2.4 IA:
			 * address row is first-tier; viewport presets + ⋯ are second-tier;
			 * the pick-element probe moved into ⋯ as a low-frequency tool).
			 * agentBusy adds the 2px accent top bar (§3.2.5). */}
			<div className={`gui-browser-chrome${agentBusy ? " gui-browser-chrome--agent" : ""}`}>
				<div className="gui-browser-nav">
					<button
						type="button"
						className="gui-browser-icon-btn"
						aria-label={t("settings.back")}
						title={t("settings.back")}
						disabled={!activeTab?.canGoBack}
						onClick={() => goBack()}
					>
						<Icon name="arrow-go-back" className="h-4 w-4" />
					</button>
					<button
						type="button"
						className="gui-browser-icon-btn"
						aria-label={t("transcript.forward")}
						title={t("transcript.forward")}
						disabled={!activeTab?.canGoForward}
						onClick={() => goForward()}
					>
						<Icon name="arrow-go-forward" className="h-4 w-4" />
					</button>
					<button
						type="button"
						className={`gui-browser-icon-btn${activeTabLoading ? " gui-browser-icon-btn--spinning" : ""}`}
						aria-label={activeTabLoading ? t("tools.stopAgentOperation") : t("settings.refresh")}
						title={activeTabLoading ? t("tools.stopAgentOperation") : t("settings.refresh")}
						disabled={isBlank}
						onClick={() => {
							if (activeTabLoading) void stopAgentOp(activeTab?.id);
							else reload();
						}}
					>
						<MorphIcon
							icon={activeTabLoading ? XIconData : RefreshCwIconData}
							size={16}
							spring="snappy"
							reducedMotion="user"
						/>
					</button>
				</div>
				<form className="gui-browser-address" onSubmit={handleAddressSubmit}>
					<span className="gui-browser-address-icon" aria-hidden>
						{pageIconUrl && !isBlank ? (
							<img src={pageIconUrl} alt="" className="h-4 w-4 rounded-[3px] object-contain" />
						) : (
							<Icon name="compass-3" className="h-4 w-4" />
						)}
					</span>
					<div ref={addressAnchorRef} className="gui-browser-address-field">
						<input
							ref={urlRef}
							value={shownAddressValue}
							onChange={e => {
								setAddressEditing(true);
								setAddressValue(e.target.value);
								setSuggestionsOpen(true);
							}}
							onFocus={e => {
								setAddressEditing(true);
								setAddressValue(activeUrl === EMPTY_URL ? "" : activeUrl);
								setSuggestionsOpen(true);
								window.requestAnimationFrame(() => urlRef.current?.select());
							}}
							onBlur={e => {
								const next = e.relatedTarget as Node | null;
								// The suggestions are portaled outside this form (useFloatingMenu),
								// so focus moving into that popup must not close the list before
								// the click lands.
								const intoPopup = next instanceof HTMLElement && next.closest(".gui-menu-popup") !== null;
								if (!intoPopup && e.currentTarget.form?.contains(next)) return;
								setSuggestionsOpen(false);
								window.setTimeout(() => setAddressEditing(false), 80);
							}}
							onKeyDown={onAddressKeyDown}
							placeholder={isBlank ? t("tools.browserSearchPlaceholder") : ""}
							aria-label={t("tools.browserSearchPlaceholder")}
							autoComplete="settings.off"
							spellCheck={false}
						/>
						{addressDisplayParts.url ? (
							<span className="gui-browser-address-display" aria-hidden>
								<span className="gui-browser-address-url">{addressDisplayParts.url}</span>
								{addressDisplayParts.title ? (
									<>
										<span className="gui-browser-address-sep">/</span>
										<span className="gui-browser-address-title">{addressDisplayParts.title}</span>
									</>
								) : null}
							</span>
						) : null}
					</div>
					{renderSuggestions(
						<div role="listbox">
							{suggestions.map((item, index) => (
								<button
									key={item.key}
									type="button"
									role="option"
									aria-selected={index === suggestionIndex}
									className={index === suggestionIndex ? "gui-browser-suggestion--active" : ""}
									onClick={() => {
										setSuggestionIndex(-1);
										void navigateTo(item.url);
									}}
									onMouseEnter={() => setSuggestionIndex(index)}
									onMouseLeave={() => setSuggestionIndex(-1)}
								>
									<span className="gui-browser-suggestion-icon">
										<Icon name={item.icon} className="h-3.5 w-3.5" />
									</span>
									<span className="gui-browser-suggestion-copy">
										<span>{item.label}</span>
										<small>{item.detail}</small>
									</span>
								</button>
							))}
						</div>,
					)}
				</form>
				{/* 统一标注 / 开发者工具 / 外部打开:地址行右侧的一等公民。
				 *  缩放收进 ⋯ 菜单,主行保持简洁。 */}
				<div className="gui-browser-tools">
					<button
						type="button"
						className={`gui-browser-icon-btn${annotating ? " gui-browser-icon-btn--active" : ""}`}
						aria-label={annotating ? t("annotation.stop") : t("annotation.toggle")}
						title={annotating ? t("annotation.stop") : t("annotation.toggle")}
						aria-pressed={annotating}
						disabled={isBlank}
						onClick={() => handleAnnotate()}
					>
						<Icon name="pencil" className="h-4 w-4" />
					</button>
					<button
						type="button"
						className="gui-browser-icon-btn"
						aria-label={t("tools.browserDevTools")}
						title={t("tools.browserDevTools")}
						disabled={isBlank}
						onClick={() => {
							const tabId = host.activeId;
							const webview = tabId ? hostElement(tabId) : null;
							webview?.openDevTools();
						}}
					>
						<Icon name="code-sslash" className="h-4 w-4" />
					</button>
					<button
						type="button"
						className="gui-browser-icon-btn"
						aria-label={t("tools.browserOpenSystem")}
						title={t("tools.browserOpenSystem")}
						disabled={!availability.canOpenExternal}
						onClick={() => void openExternalUrl(activeUrl).catch(() => {})}
					>
						<Icon name="external-link" className="h-4 w-4" />
					</button>
				</div>
				<div className="gui-browser-actions">
					<div ref={extensionsAnchorRef} className="gui-browser-action-item">
						<button
							type="button"
							className={`gui-browser-icon-btn${extensionsOpen ? " gui-browser-icon-btn--active" : ""}`}
							aria-label={t("tools.extensions")}
							title={t("tools.extensions")}
							aria-haspopup="dialog"
							aria-expanded={extensionsOpen}
							onClick={() => {
								setExtensionsOpen(open => !open);
								setMenuOpen(false);
								setSuggestionsOpen(false);
							}}
						>
							<Icon name="apps-2-ai" className="h-4 w-4" />
						</button>
						{renderExtensionsMenu(
							<div role="dialog" aria-modal="false" aria-label={t("tools.extensions")}>
								<div className="gui-browser-extensions-popup-head">
									<span>{t("tools.extensions")}</span>
									<button
										type="button"
										className="gui-browser-icon-btn"
										aria-label={t("settings.close")}
										title={t("settings.close")}
										onClick={() => setExtensionsOpen(false)}
									>
										<Icon name="close" className="h-3.5 w-3.5" />
									</button>
								</div>
								<ManagedBrowserExtensions />
							</div>,
						)}
					</div>
					<div ref={actionsAnchorRef} className="gui-browser-action-item">
						<button
							type="button"
							className={`gui-browser-icon-btn${menuOpen ? " gui-browser-icon-btn--active" : ""}`}
							aria-label={t("tools.browserMenu")}
							title={t("tools.browserMenu")}
							onClick={() => {
								setMenuOpen(o => !o);
								setExtensionsOpen(false);
								setSuggestionsOpen(false);
							}}
						>
							<Icon name="more-2" className="h-4 w-4" />
						</button>
						{renderActionsMenu(
							<div role="menu">
								<button
									type="button"
									role="menuitem"
									onClick={() => {
										setMenuOpen(false);
										void createTab(EMPTY_URL).catch(() => {});
									}}
								>
									<Icon name="add" className="h-3.5 w-3.5" />
									{t("tools.browserNewTab")}
								</button>
								<button
									type="button"
									role="menuitem"
									disabled={isBlank}
									onClick={() => {
										setMenuOpen(false);
										handleAnnotate();
									}}
								>
									<Icon name="pencil" className="h-3.5 w-3.5" />
									{t("annotation.toggle")}
								</button>
								<button
									type="button"
									role="menuitem"
									disabled={isBlank}
									onClick={() => {
										setMenuOpen(false);
										hostElement(host.activeId ?? "")?.openDevTools();
									}}
								>
									<Icon name="code-sslash" className="h-3.5 w-3.5" />
									{t("tools.browserDevTools")}
								</button>
								<button
									type="button"
									role="menuitem"
									disabled={!availability.actions.find}
									onClick={() => {
										setFindOpen(true);
										setMenuOpen(false);
									}}
								>
									<Icon name="search" className="h-3.5 w-3.5" />
									{t("tools.browserFindInPage")}
								</button>
								<button
									type="button"
									role="menuitem"
									disabled={!availability.actions.print}
									onClick={() => {
										setMenuOpen(false);
										void runBrowserAction(printActivePage);
									}}
								>
									<Icon name="file-text" className="h-3.5 w-3.5" />
									{t("tools.browserPrint")}
								</button>
								<div className="gui-browser-menu-zoom" role="group">
									<button
										type="button"
										className="gui-browser-icon-btn"
										aria-label={t("tools.browserZoomOut")}
										title={t("tools.browserZoomOut")}
										disabled={!availability.actions.zoom}
										onClick={() => setActiveZoom(activeZoom - 0.1)}
									>
										<Icon name="subtract" className="h-3.5 w-3.5" />
									</button>
									<button
										type="button"
										className="gui-browser-zoom-value"
										title={t("tools.browserResetZoom")}
										disabled={!availability.actions.zoom}
										onClick={() => setActiveZoom(1)}
									>
										{Math.round(activeZoom * 100)}%
									</button>
									<button
										type="button"
										className="gui-browser-icon-btn"
										aria-label={t("tools.browserZoom")}
										title={t("tools.browserZoom")}
										disabled={!availability.actions.zoom}
										onClick={() => setActiveZoom(activeZoom + 0.1)}
									>
										<Icon name="add" className="h-3.5 w-3.5" />
									</button>
								</div>
								<button
									type="button"
									role="menuitemcheckbox"
									aria-checked={deviceToolbarActive}
									disabled={!availability.actions.deviceToolbar}
									onClick={() => {
										changeDeviceToolbarVisibility(!deviceToolbarVisible);
										setMenuOpen(false);
									}}
								>
									<Icon name="computer" className="h-3.5 w-3.5" />
									{deviceToolbarActive
										? t("tools.browserHideDeviceToolbar")
										: t("tools.browserShowDeviceToolbar")}
								</button>
								<button
									type="button"
									role="menuitemcheckbox"
									aria-checked={keepPageFocused}
									disabled={!availability.actions.focus}
									onClick={() => {
										setKeepPageFocused(focused => !focused);
										setMenuOpen(false);
									}}
								>
									<MorphIcon
										icon={keepPageFocused ? EyeIconData : EyeOffIconData}
										size={14}
										spring="snappy"
										reducedMotion="user"
									/>
									{t("tools.browserAlwaysFocus")}
								</button>
								<button
									type="button"
									role="menuitem"
									disabled={!availability.actions.screenshot}
									onClick={() => {
										setMenuOpen(false);
										void runBrowserAction(async () => {
											const result = await saveActivePageScreenshot();
											if (result.canceled) return;
											window.dispatchEvent(
												new CustomEvent("musepi-gui-toast", {
													detail: { message: t("tools.browserScreenshotSaved"), kind: "success" },
												}),
											);
										});
									}}
								>
									<Icon name="camera" className="h-3.5 w-3.5" />
									{t("tools.browserScreenshot")}
								</button>
								<button
									type="button"
									role="menuitem"
									disabled={!availability.actions.copyUrl}
									onClick={() => {
										void runBrowserAction(copyCurrentUrl);
										setMenuOpen(false);
									}}
								>
									<Icon name="clipboard" className="h-3.5 w-3.5" />
									{copied ? t("tools.browserCopyUrlDone") : t("tools.browserCopyUrl")}
								</button>
								<button
									type="button"
									role="menuitem"
									disabled={!availability.actions.openExternal}
									onClick={openInSystem}
								>
									<Icon name="external-link" className="h-3.5 w-3.5" />
									{t("tools.browserOpenSystem")}
								</button>
								<button
									type="button"
									role="menuitem"
									disabled={!availability.actions.hardRefresh}
									onClick={() => {
										reload(true);
										setMenuOpen(false);
									}}
								>
									<Icon name="refresh" className="h-3.5 w-3.5" />
									{t("tools.browserHardReload")}
								</button>
								<span className="gui-browser-menu-sep" />
								<button
									type="button"
									role="menuitem"
									onClick={() => {
										setMenuOpen(false);
										void runBrowserAction(showDownloads);
									}}
								>
									<Icon name="download" className="h-3.5 w-3.5" />
									{t("tools.browserDownloads")}
								</button>
								<button type="button" role="menuitem" onClick={openHistory}>
									<Icon name="history" className="h-3.5 w-3.5" />
									{t("tools.browserHistory")}
								</button>
								<span className="gui-browser-menu-sep" />
								<button type="button" role="menuitem" disabled={history.length === 0} onClick={clearHistory}>
									<Icon name="history" className="h-3.5 w-3.5" />
									{t("tools.browserClearHistory")}
								</button>
								<button type="button" role="menuitem" onClick={() => clearBrowserData("cookies")}>
									<Icon name="lock" className="h-3.5 w-3.5" />
									{t("tools.browserClearCookies")}
								</button>
								<button type="button" role="menuitem" onClick={() => clearBrowserData("all")}>
									<Icon name="delete-bin" className="h-3.5 w-3.5" />
									{t("tools.browserClearAllData")}
								</button>
								<button
									type="button"
									role="menuitem"
									onClick={() => {
										setMenuOpen(false);
										window.dispatchEvent(
											new CustomEvent("musepi-gui-open-settings-section", { detail: "browser" }),
										);
									}}
								>
									<Icon name="settings-3" className="h-3.5 w-3.5" />
									{t("tools.browserSettings")}
								</button>
							</div>,
						)}
					</div>
					<button
						type="button"
						className="gui-browser-icon-btn"
						aria-label={t("tools.browserNewTab")}
						title={t("tools.browserNewTab")}
						onClick={() => void createTab(EMPTY_URL).catch(() => {})}
					>
						<Icon name="add" className="h-4 w-4" />
					</button>
				</div>
			</div>
			{findOpen && availability.actions.find && (
				<form
					className="gui-browser-find"
					onSubmit={event => {
						event.preventDefault();
						findInActivePage(findQuery);
					}}
				>
					<Icon name="search" className="h-3.5 w-3.5" />
					<input
						autoFocus
						className="gui-browser-find-input"
						value={findQuery}
						placeholder={t("tools.browserFindPlaceholder")}
						aria-label={t("tools.browserFindInPage")}
						onChange={event => {
							setFindQuery(event.target.value);
							findInActivePage(event.target.value);
						}}
						onKeyDown={event => {
							if (event.key === "Escape") {
								event.preventDefault();
								closeFind();
							}
						}}
					/>
					<button
						type="submit"
						className="gui-browser-icon-btn"
						aria-label={t("tools.browserFindNext")}
						title={t("tools.browserFindNext")}
					>
						<Icon name="arrow-go-forward" className="h-3.5 w-3.5" />
					</button>
					<button
						type="button"
						className="gui-browser-icon-btn"
						aria-label={t("tools.browserCloseFind")}
						title={t("tools.browserCloseFind")}
						onClick={closeFind}
					>
						<Icon name="close" className="h-3.5 w-3.5" />
					</button>
				</form>
			)}
			<BrowserDeviceToolbar
				preset={viewportKey}
				width={presetWidth}
				height={presetHeight}
				displayScale={displayScale}
				background={pageBackground}
				disabled={!availability.actions.deviceToolbar}
				visible={deviceToolbarVisible && availability.hasPage}
				onPresetChange={setViewportKey}
				onSizeChange={size => setCustomVp(size)}
				onDisplayScaleChange={setDisplayScale}
				onBackgroundChange={setPageBackground}
			/>
			{host.error && (
				<div className="border-b border-[var(--border)] px-2 py-1 text-[11px] text-[var(--color-danger)]">
					{host.error}
				</div>
			)}
			{/* Content: the slot is the host's positioning target (the page itself
			 * lives in the always-mounted host); a viewport preset is applied by
			 * scaling the host, not by constraining this box. */}
			<div
				ref={contentRef}
				className="gui-browser-content"
				data-background={deviceToolbarActive ? pageBackground : "auto"}
				style={{ overflow: pageOverflow.x || pageOverflow.y ? "auto" : "hidden" }}
			>
				<div ref={slotRef} className="gui-browser-slot" aria-label={t("tools.managedBrowser")} />
				<BrowserAgentMark
					mark={host.agentMark && host.agentMark.tabId === host.activeId ? host.agentMark : null}
					origin={pageOrigin}
					page={pageBox ? { left: pageBox.left, scale: pageBox.scale } : null}
				/>
				{agentControl && (
					<BrowserControlOverlay
						activity={agentControl.activity}
						since={agentControl.since}
						visible
						inView={agentBusy}
						onReveal={() => selectTab(agentControl.tabId)}
						onTakeover={handleTakeover}
						frameRect={controlRect ?? undefined}
					/>
				)}
				{/* Preset mode: dashed viewport frame + right/bottom drag handles
				 * (§3.2.2). Pure overlay siblings of the slot — the §23 webview
				 * constraints are untouched (no display/reparent near the page
				 * element). The 6px offset matches the slot's fixed margin. */}
				{pageBox && viewportControlsVisible(availability.hasPage, pageBox, presetWidth) && (
					<div
						className="gui-browser-vp-frame"
						style={{ left: 6 + pageBox.left, top: 6, width: pageBox.width, height: pageBox.height }}
					>
						<span className="gui-browser-vp-size">
							{Math.round(pageBox.layoutWidth)} × {Math.round(pageBox.layoutHeight)}
						</span>
						<button
							type="button"
							className="gui-browser-vp-handle gui-browser-vp-handle--x"
							title={t("tools.browserViewportWidth")}
							aria-label={t("tools.browserViewportWidth")}
							onPointerDown={e => startVpDrag(e, "x")}
							onPointerMove={onVpDragMove}
							onPointerUp={endVpDrag}
							onPointerCancel={endVpDrag}
						/>
						<button
							type="button"
							className="gui-browser-vp-handle gui-browser-vp-handle--y"
							title={t("tools.browserViewportHeight")}
							aria-label={t("tools.browserViewportHeight")}
							onPointerDown={e => startVpDrag(e, "y")}
							onPointerMove={onVpDragMove}
							onPointerUp={endVpDrag}
							onPointerCancel={endVpDrag}
						/>
					</div>
				)}
				{/* Readiness placeholder (§3.2.3): while the guest loads, an L1
				 * card sits over the slot so the pane never reads as a dead
				 * white box. Blank tabs render the start page instead. */}
				{!isBlank && activeTabLoading && (
					<div className="gui-browser-loading" role="status" aria-live="polite">
						<Icon name="loader-4" className="h-4 w-4 animate-spin" />
						<span>{t("tools.browserPageLoading")}</span>
					</div>
				)}
				{/* Blank tab: the start page layers OVER the about:blank guest — the
				 * guest stays mounted, so the agent keeps driving the same tab. */}
				{isBlank && (
					<div className="gui-browser-start-overlay">
						<BrowserStartPage
							history={history}
							onNavigate={(url: string) => void navigateTo(url)}
							onFocusAddress={() => {
								setAddressEditing(true);
								setAddressValue("");
								urlRef.current?.focus();
							}}
						/>
					</div>
				)}
			</div>
			{/* Local-only login note (Proma parity) */}
			<div className="flex items-center justify-between px-2 pb-1 pt-0.5">
				<span className="text-[10.5px] text-[var(--color-text-faint)]">{t("tools.managedBrowserLocalOnly")}</span>
				{host.port ? (
					<span className="text-[10.5px] text-[var(--color-text-faint)]">
						{t("tools.managedBrowserPort", { port: String(host.port) })}
					</span>
				) : null}
			</div>
			{/* Risky-navigation consent gate (DOM dialog — it layers over the page
			 * like any other overlay now). */}
			{host.confirm && (
				<div
					role="dialog"
					aria-modal="true"
					aria-label={t("tools.riskyNavigation")}
					className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 px-6"
				>
					<div className="max-w-[380px] rounded-lg border border-[var(--border)] bg-[var(--color-surface)] p-3 shadow-lg">
						<div className="mb-1 text-[12px] font-medium text-[var(--color-text)]">
							{t("tools.riskyNavigation")}
						</div>
						<div className="mb-2 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
							{t("tools.riskyNavigationDescription")}
						</div>
						<div className="mb-3 break-all rounded-md bg-[var(--color-surface-sunken)] px-2 py-1 font-mono text-[11px] text-[var(--color-text)]">
							{host.confirm.url}
						</div>
						<div className="flex justify-end gap-2">
							<button
								type="button"
								className="gui-pane-action !w-auto px-2.5 py-1"
								onClick={() => void answerConfirm(host.confirm?.requestId ?? "", false)}
							>
								{t("tools.deny")}
							</button>
							<button
								type="button"
								className="gui-pane-action !w-auto bg-[var(--color-accent)] px-2.5 py-1 text-[var(--color-on-accent)]"
								onClick={() => void answerConfirm(host.confirm?.requestId ?? "", true)}
							>
								{t("tools.allow")}
							</button>
						</div>
					</div>
				</div>
			)}
			{/* In-app upload confirmation: the site's file picker and the agent's
			 * tab.uploadFile both land here, never in a native dialog. */}
			<BrowserUploadDialog
				request={host.upload}
				onCancel={() => void cancelUpload(host.upload?.requestId ?? "")}
				onChoose={request => void chooseUploadFiles(request)}
				onAllowAgent={requestId => void allowAgentUpload(requestId)}
			/>
			{pageContext ? (
				<ContextMenu
					open
					x={pageContext.x}
					y={pageContext.y}
					onClose={() => setPageContext(null)}
					items={[
						{
							label: t("tools.browserPageCopy"),
							icon: "file-copy-2",
							disabled: !pageContext.selectionText,
							onSelect: () => {
								if (pageContext.selectionText) {
									void copyToClipboard(pageContext.selectionText);
								}
							},
						},
						{
							label: t("tools.browserPagePaste"),
							icon: "clipboard",
							disabled: !pageContext.isEditable,
							onSelect: () => hostElement(pageContext.tabId)?.paste(),
						},
						{
							label: t("annotation.toggle"),
							icon: "pencil",
							divider: true,
							onSelect: () => handleAnnotate({ x: pageContext.elementX, y: pageContext.elementY }),
						},
						{
							label: t("tools.browserInspectElement"),
							icon: "code-box",
							onSelect: () =>
								hostElement(pageContext.tabId)?.inspectElement(pageContext.elementX, pageContext.elementY),
						},
						{
							label: t("tools.browserCopySelectionLink"),
							icon: "external-link",
							disabled: !pageContext.linkURL,
							onSelect: () => {
								if (pageContext.linkURL) void copyToClipboard(pageContext.linkURL);
							},
						},
					]}
				/>
			) : null}
		</div>
	);
}

/** Start page for blank tabs (open-design DesignBrowserStart 吸收):
 *  hero + quick links + recent visits. Clicking a link navigates. */
function BrowserStartPage({
	history,
	onNavigate,
	onFocusAddress,
}: {
	history: BrowserHistoryEntry[];
	onNavigate: (url: string) => void;
	onFocusAddress: () => void;
}): ReactNode {
	const recent = history.slice(0, 8);
	return (
		<div className="gui-browser-start">
			<div className="gui-browser-start-hero">
				<span className="gui-browser-start-kicker">{t("settings.browser")}</span>
				<h2>{t("tools.browserStartTitle")}</h2>
				<p className="gui-browser-start-sub">{t("tools.browserStartSubtitle")}</p>
			</div>
			<div className="gui-browser-start-section">
				<div className="gui-browser-start-section-head">
					<span>{t("tools.browserQuickLinks")}</span>
					<small>{t("tools.browserQuickLinksHint")}</small>
				</div>
				<div className="gui-browser-quick-grid">
					{QUICK_LINKS.map(link => (
						<a
							key={link.url}
							href={link.url}
							className="gui-browser-quick-card"
							onClick={event => {
								event.preventDefault();
								onNavigate(link.url);
							}}
						>
							<Icon name={link.icon} className="h-4 w-4" />
							<span>{link.label}</span>
						</a>
					))}
				</div>
			</div>
			<div className="gui-browser-start-section">
				<div className="gui-browser-start-section-head">
					<span>{t("tools.browserRecentVisits")}</span>
					<small>{t("tools.browserRecentHint")}</small>
				</div>
				{recent.length === 0 ? (
					<div className="gui-browser-start-empty">
						<p>{t("tools.browserNoHistory")}</p>
						<p>{t("tools.browserTypePasteUrl")}</p>
						<button type="button" className="gui-browser-start-address" onClick={onFocusAddress}>
							<Icon name="compass-3" className="h-4 w-4" />
							<span>{t("tools.browserSearchPlaceholder")}</span>
						</button>
					</div>
				) : (
					<div className="gui-browser-recent-list">
						{recent.map(entry => (
							<a
								key={entry.url}
								href={entry.url}
								className="gui-browser-recent-item"
								title={entry.url}
								onClick={event => {
									event.preventDefault();
									onNavigate(entry.url);
								}}
							>
								<span className="gui-browser-recent-icon">
									<Icon name="history" className="h-3.5 w-3.5" />
								</span>
								<span className="gui-browser-recent-copy">
									<span>{entry.title || labelFromUrl(entry.url)}</span>
									<small>{hostnameFromUrl(entry.url)}</small>
								</span>
								<span className="gui-browser-recent-open">{t("tools.browserOpen")}</span>
							</a>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
