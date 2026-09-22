/**
 * 托管浏览器渲染端宿主状态。
 *
 * 页面是 **DOM 里的 `<webview>`**(OOPIF):标签、导航、可见性都归渲染端;
 * 主进程只保留 CDP 桥(9230)、分区策略与活动台账(见 `electron/managed-browser.cjs`)。
 *
 * 实测约束(Electron 43,勿改):
 * - `<webview>` 在 DOM 中被移动会**销毁 guest**(元素留在 DOM 里成死壳)⇒ 元素必须挂在
 *   同一个稳定父节点下,永不 reparent、永不卸载。
 * - 隐藏只能用 `opacity` 或叠放:`display:none` / 移出视口会让 `capturePage()` **永不返回**,
 *   零尺寸返回空图 —— agent 截图会挂死或拿到空帧。
 * - 元素以 `src` 定值创建;后台标签的 imperative 导航不可靠,创建后一律走 `loadURL()`。
 */

// ── Guest-unmount race guard(启动时装配,一次)───────────────────────────
//
// 实测竞态(Electron 43,压测下 12/12 复现):主进程 closeTab 销毁 guest 后,
// 渲染端才收到 close 推送并卸载元素,Electron webview 的 disconnectedCallback
// 按 guestInstanceId 反查主进程注册表失败,同步抛出 "Invalid guestInstanceId"
// —— 抛在 React commit 的 removeChild 里,unwind 整棵树进错误边界,GUI 崩溃。
// 主修复在 managed-browser.cjs(dispose 推迟到渲染端真实卸载之后);这里是兜底:
// 该异常的 DOM 变更已完成(detach 先于回调抛出),只吞这一个精确错误,其余照常上抛。
try {
	const originalRemoveChild = Node.prototype.removeChild;
	Node.prototype.removeChild = function <T extends Node>(this: Node, child: T): T {
		try {
			return originalRemoveChild.call(this, child) as T;
		} catch (error) {
			// Electron 的 isolated bundle 抛出的异常跨 realm —— 在主世界里
			// `instanceof Error` 为 false,只能按消息文本匹配。
			const message = error instanceof Error ? error.message : String(error);
			if (/Invalid guestInstanceId/.test(message)) {
				// guest 已被主进程注销(卸载竞态)——元素已是死壳,无可释放。
				return child;
			}
			throw error;
		}
	} as typeof Node.prototype.removeChild;
} catch {
	// 非 DOM 环境 —— 无需守卫。
}

/** 元素上我们会用到的 electron webview 方法子集(JSX 类型只有属性)。 */
export interface HostWebview extends HTMLElement {
	loadURL(url: string): Promise<void>;
	getURL(): string;
	getTitle(): string;
	getWebContentsId(): number;
	canGoBack(): boolean;
	canGoForward(): boolean;
	goBack(): void;
	goForward(): void;
	reload(): void;
	reloadIgnoringCache(): void;
	stop(): void;
	isLoading(): boolean;
	executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
	addEventListener(event: string, listener: (event: Event) => void, useCapture?: boolean): void;
	removeEventListener(event: string, listener: (event: Event) => void, useCapture?: boolean): void;
}

export interface ManagedTab {
	id: string;
	/** Creation URL — set once as the element's `src`. */
	url: string;
	title: string;
	loading: boolean;
	/** about:blank resting state: the React start page is layered over the guest. */
	blank: boolean;
	/** Created by the agent (CDP `Target.createTarget`). */
	agent: boolean;
	favicon: string | null;
	themeColor: string | null;
	canGoBack: boolean;
	canGoForward: boolean;
	/** Last user/agent activity (load, navigation, selection) — residency LRU. */
	lastActivityAt: number;
	/** Page paused via CDP `Page.setWebLifecycleState` (see enforceResidency). */
	frozen: boolean;
}

export interface HostRect {
	x: number;
	y: number;
	width: number;
	height: number;
	/** Viewport-preset fit: layout is `width` wide and visually scaled by this. */
	scale?: number;
}

export interface ManagedBrowserHostState {
	tabs: readonly ManagedTab[];
	activeId: string | null;
	/** Panel content slot rect; null while the panel is closed (guest stays mounted). */
	rect: HostRect | null;
	paneVisible: boolean;
	port: number | null;
	activity: ManagedBrowserActivity | null;
	agentActivity: boolean;
	confirm: ManagedBrowserConfirmRequest | null;
	error: string | null;
}

let state: ManagedBrowserHostState = {
	tabs: [],
	activeId: null,
	rect: null,
	paneVisible: false,
	port: null,
	activity: null,
	agentActivity: false,
	confirm: null,
	error: null,
};

const listeners = new Set<() => void>();
const elements = new Map<string, HostWebview>();
const pendingCreates = new Map<string, PromiseWithResolvers<string>>();
/** Elements already wired (ref callbacks re-invoke on every re-render). */
const wiredElements = new WeakSet<HostWebview>();

let tabSeq = 0;

function set(patch: Partial<ManagedBrowserHostState>): void {
	state = { ...state, ...patch };
	for (const fn of listeners) fn();
}

export function getHostState(): ManagedBrowserHostState {
	return state;
}
/**
 * The `src` a tab's element was created with — fixed for the element's life.
 *
 * Re-driving `src` from live state is a feedback loop: the guest's own
 * navigation updates that state, React re-sets the attribute, and the guest
 * reloads — which also aborts the in-flight load (`ERR_ABORTED (-3)` over a page
 * that was loading fine). The element's URL is set once; later navigations go
 * through `loadURL`/main, never through the attribute.
 */
const entrySrcs = new Map<string, string>();

export function entrySrc(tabId: string, url: string): string {
	const existing = entrySrcs.get(tabId);
	if (existing !== undefined) return existing;
	const initial = url || "about:blank";
	entrySrcs.set(tabId, initial);
	return initial;
}

/** Forget an entry URL once its tab is gone (the map must not grow). */
export function forgetEntrySrc(tabId: string): void {
	entrySrcs.delete(tabId);
}

export function subscribeHost(fn: () => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

export function hostElement(tabId: string): HostWebview | null {
	return elements.get(tabId) ?? null;
}

function patchTab(tabId: string, patch: Partial<ManagedTab>): void {
	if (!state.tabs.some(tab => tab.id === tabId)) return;
	const tabs = state.tabs.map(tab => (tab.id === tabId ? { ...tab, ...patch } : tab));
	set({ tabs });
}

/** Residency LRU touch: any load/navigation/selection counts as activity. */
function touchTab(tabId: string): void {
	const tab = state.tabs.find(x => x.id === tabId);
	if (!tab) return;
	if (Date.now() - tab.lastActivityAt < 1000) return;
	patchTab(tabId, { lastActivityAt: Date.now() });
}

function isBlankUrl(url: string): boolean {
	return url === "" || url === "about:blank";
}

/** Guest ids already reported to main (one report per tab; elements never remount). */
const reportedGuests = new Set<string>();

/** Element lifecycle: registered by the host renderer, reported to main. */
export function attachElement(tabId: string, el: HostWebview | null): void {
	if (el === null) {
		const had = elements.delete(tabId);
		// The null ref is only a REAL unmount when no element re-attaches in the
		// same commit. ManagedBrowserHost passes an INLINE ref callback, so React
		// detaches (null) + re-attaches (el) on EVERY re-render — firing
		// guest-gone for those would make main dispose live guests mid-scroll.
		// One microtask later the transient swap has re-registered; a genuine
		// unmount (tab removed from state) has not — that is when main may
		// dispose the guest (disposing earlier reopens the Invalid
		// guestInstanceId crash — see disposeAfterUnmount in managed-browser.cjs).
		if (had) {
			queueMicrotask(() => {
				if (!elements.has(tabId)) {
					void window.electronAPI?.managedBrowserGuestGone(tabId).catch(() => {});
				}
			});
		}
		return;
	}
	elements.set(tabId, el);
	// A re-rendered ref callback re-invokes this with the same element; wiring
	// the listeners twice would double every state patch.
	if (wiredElements.has(el)) return;
	wiredElements.add(el);
	// `did-attach` is the moment the guest exists (`getWebContentsId()` becomes
	// callable) — the CDP bridge cannot bind the webContents without that id.
	const onAttach = (): void => reportGuestReady(tabId);
	const onFavicon = (event: Event): void => {
		const urls = (event as Event & { favicons?: string[] }).favicons;
		if (Array.isArray(urls) && urls.length > 0) patchTab(tabId, { favicon: urls[0] ?? null });
	};
	const onLoadStart = (): void => {
		touchTab(tabId);
		patchTab(tabId, { loading: true });
	};
	const onLoadEnd = (): void => {
		const current = elements.get(tabId);
		if (!current) return;
		touchTab(tabId);
		let url = state.tabs.find(x => x.id === tabId)?.url ?? "";
		let title = "";
		let canGoBack = false;
		let canGoForward = false;
		try {
			url = current.getURL() || url;
			title = current.getTitle();
			canGoBack = current.canGoBack();
			canGoForward = current.canGoForward();
		} catch {
			// not attached yet — keep the previous values
		}
		patchTab(tabId, { loading: false, url, title: title || url, canGoBack, canGoForward, blank: isBlankUrl(url) });
		// A successful load clears any previous failure banner.
		set({ error: null });
		void refreshThemeColor(tabId);
	};
	const onTitle = (event: Event): void => {
		const title = (event as Event & { title?: string }).title;
		if (typeof title === "string" && title) patchTab(tabId, { title });
	};
	const onFail = (event: Event): void => {
		const detail = event as Event & {
			errorCode?: number;
			errorDescription?: string;
			validatedURL?: string;
			isMainFrame?: boolean;
		};
		// Sub-resource failures are noise; ERR_ABORTED (-3) means the load was
		// superseded by a newer navigation, i.e. the page IS loading.
		if (detail.isMainFrame === false) return;
		patchTab(tabId, { loading: false });
		if (detail.errorCode === -3) return;
		set({
			error: `${detail.errorDescription ?? "load failed"}${detail.validatedURL ? ` · ${detail.validatedURL}` : ""}`,
		});
	};
	const onGone = (): void => {
		if (!elements.has(tabId)) return;
		elements.delete(tabId);
		// Lifecycle reports are fire-and-forget: a main process that has not
		// registered the handler yet (boot) must not surface an unhandled
		// rejection in the renderer.
		void window.electronAPI?.managedBrowserGuestGone(tabId).catch(() => {});
	};
	const onDestroyed = (): void => onGone();
	el.addEventListener("page-favicon-updated", onFavicon);
	el.addEventListener("did-start-loading", onLoadStart);
	el.addEventListener("did-stop-loading", onLoadEnd);
	el.addEventListener("did-finish-load", onLoadEnd);
	el.addEventListener("did-navigate", onLoadEnd);
	el.addEventListener("did-navigate-in-page", onLoadEnd);
	el.addEventListener("did-fail-load", onFail);
	el.addEventListener("page-title-updated", onTitle);
	// `dom-ready` — NOT `did-attach` — is the readiness gate: the webview API
	// throws "must be attached to the DOM and the dom-ready event emitted"
	// before it (measured). `did-attach` stays registered as an early trigger;
	// reportGuestReady is idempotent and swallows the not-ready throw.
	el.addEventListener("dom-ready", onAttach);
	el.addEventListener("render-process-gone", onGone);
	el.addEventListener("destroyed", onDestroyed);
	el.addEventListener("did-attach", onAttach);
	// The element may already be attached (a blank guest attaches fast): probe
	// now instead of relying on the event alone.
	reportGuestReady(tabId);
}

/** Called by the host renderer once the guest exists (`did-attach`, or an
 *  immediate probe for an element that attached before the listener landed —
 *  an about:blank guest can attach faster than React's ref callback). */
export function reportGuestReady(tabId: string): void {
	if (reportedGuests.has(tabId)) return;
	const el = elements.get(tabId);
	if (!el) return;
	let webContentsId: number;
	try {
		// Throws until the guest is attached — that IS the readiness signal.
		webContentsId = el.getWebContentsId();
	} catch {
		return;
	}
	reportedGuests.add(tabId);
	void window.electronAPI?.managedBrowserGuestReady({ tabId, webContentsId }).catch(() => {});
	const started = pendingCreates.get(tabId);
	if (started) {
		pendingCreates.delete(tabId);
		started.resolve(tabId);
	}
	// Reflect the live URL/title now that the guest can be queried.
	pumpTabFromElement(tabId);
}
function pumpTabFromElement(tabId: string): void {
	const el = elements.get(tabId);
	if (!el) return;
	let title = "";
	let url = state.tabs.find(x => x.id === tabId)?.url ?? "";
	let canGoBack = false;
	let canGoForward = false;
	try {
		url = el.getURL() || url;
		title = el.getTitle();
		canGoBack = el.canGoBack();
		canGoForward = el.canGoForward();
	} catch {
		return;
	}
	patchTab(tabId, {
		url,
		title: title || url,
		canGoBack,
		canGoForward,
		blank: isBlankUrl(url),
		loading: el.isLoading(),
	});
}

/**
 * Create a tab. `tabId` is supplied by main for agent-created tabs (so the CDP
 * bridge can name the target before the DOM element exists); user tabs get a
 * local id. Resolves once the guest is attached and reported.
 */
export function createTab(url: string, options?: { tabId?: string; agent?: boolean }): Promise<string> {
	const id = options?.tabId ?? `local-${++tabSeq}`;
	const target = url || "about:blank";
	const tab: ManagedTab = {
		id,
		url: target,
		title: target,
		loading: true,
		blank: isBlankUrl(target),
		agent: options?.agent === true,
		favicon: null,
		themeColor: null,
		canGoBack: false,
		canGoForward: false,
		lastActivityAt: Date.now(),
		frozen: false,
	};
	const created = Promise.withResolvers<string>();
	pendingCreates.set(id, created);
	set({ tabs: [...state.tabs, tab], activeId: id });
	if (state.paneVisible) reportActive(id);
	// A new tab can push the set past the residency cap — reap in the background.
	enforceResidency();
	// A guest that never attaches (window closed mid-create) must not hang main.
	window.setTimeout(() => {
		const pending = pendingCreates.get(id);
		if (!pending) return;
		pendingCreates.delete(id);
		pending.reject(new Error("guest did not attach"));
	}, 10_000);
	return created.promise;
}

export function closeTab(tabId: string, options?: { notifyMain?: boolean }): void {
	const tabs = state.tabs.filter(tab => tab.id !== tabId);
	// The element is gone with the tab: drop its creation URL.
	forgetEntrySrc(tabId);
	// Deliberately keep the element in `elements` until React's ref detach
	// (attachElement(null)) — that detach is the element's REAL unmount, and it
	// owns the elements-map delete AND the main notification. Deleting here
	// would make the detach a no-op, and any notify here fires before the DOM
	// removal, which races main's dispose (Invalid guestInstanceId crash).
	const elementNeverMounted = !elements.has(tabId);
	const pending = pendingCreates.get(tabId);
	if (pending) {
		pendingCreates.delete(tabId);
		pending.reject(new Error("tab closed before attach"));
	}
	const activeId = state.activeId === tabId ? (tabs[tabs.length - 1]?.id ?? null) : state.activeId;
	set({ tabs, activeId });
	if (elementNeverMounted && options?.notifyMain !== false) {
		// Never mounted ⇒ no ref will ever detach: main must hear the demise
		// from here (its dispose-then has no element to race).
		void window.electronAPI?.managedBrowserGuestGone(tabId).catch(() => {});
	}
	if (activeId) reportActive(activeId);
	// React unmounts the element on the next render, which destroys the guest —
	// removing it here too would fight the reconciler.
}

export function selectTab(tabId: string): void {
	if (!state.tabs.some(tab => tab.id === tabId)) return;
	set({ activeId: tabId });
	touchTab(tabId);
	reportActive(tabId);
	// A frozen page is dead to input — always thaw on activation.
	const tab = state.tabs.find(x => x.id === tabId);
	if (tab?.frozen) void thawTab(tabId);
}

function reportActive(tabId: string): void {
	void window.electronAPI?.managedBrowserActiveTab(tabId).catch(() => {});
}

export function activeTab(): ManagedTab | null {
	return state.tabs.find(tab => tab.id === state.activeId) ?? null;
}

/** Panel slot geometry: the host positions itself over this rect (pure DOM, no IPC). */
export function setPaneRect(rect: HostRect | null): void {
	if (rect === null) {
		if (state.rect === null && !state.paneVisible) return;
		set({ rect: null, paneVisible: false });
		void window.electronAPI?.managedBrowserVisibility(false).catch(() => {});
		return;
	}
	// A folded panel keeps the pane mounted and animates its width to 0, so the
	// measured rect exists but is degenerate. Main must hear that as hidden:
	// otherwise its `panelVisible` stays true, the agent-activity reveal never
	// fires, and the agent's work (highlight included) stays unseen. The rect
	// itself is kept — the guest keeps its composited surface (capturePage
	// parity), only the visibility report changes.
	if (rect.width < 1 || rect.height < 1) {
		if (!state.paneVisible) return;
		set({ paneVisible: false });
		void window.electronAPI?.managedBrowserVisibility(false).catch(() => {});
		return;
	}
	// The pane re-measures on an interval; an unchanged rect must not re-render
	// the host (and its webviews) several times a second.
	const current = state.rect;
	if (
		state.paneVisible &&
		current !== null &&
		current.x === rect.x &&
		current.y === rect.y &&
		current.width === rect.width &&
		current.height === rect.height &&
		(current.scale ?? 1) === (rect.scale ?? 1)
	) {
		return;
	}
	set({ rect, paneVisible: true });
	void window.electronAPI?.managedBrowserVisibility(true).catch(() => {});
}

/** Navigate the active tab through main (URL normalization + risk policy live there). */
export async function navigate(url: string): Promise<boolean> {
	const tab = activeTab();
	if (!tab) return false;
	const res = await window.electronAPI?.managedBrowserNavigate({ url });
	if (res && res.ok === false) {
		set({ error: res.error ?? null });
		return false;
	}
	set({ error: null });
	pumpTabFromElement(tab.id);
	touchTab(tab.id);
	return true;
}

export function goBack(): void {
	const tab = activeTab();
	if (!tab) return;
	const el = elements.get(tab.id);
	try {
		if (el?.canGoBack()) {
			el.goBack();
			touchTab(tab.id);
		}
	} catch {
		// element not attached
	}
}

export function goForward(): void {
	const tab = activeTab();
	if (!tab) return;
	const el = elements.get(tab.id);
	try {
		if (el?.canGoForward()) {
			el.goForward();
			touchTab(tab.id);
		}
	} catch {
		// element not attached
	}
}

export function reload(hard = false): void {
	const tab = activeTab();
	if (!tab) return;
	const el = elements.get(tab.id);
	try {
		if (hard) el?.reloadIgnoringCache();
		else el?.reload();
		if (el) touchTab(tab.id);
	} catch {
		// element not attached
	}
}

// ── Tab residency (batch B, sidepanel browser rendering design) ─────────
//
// The panel embeds pages as DOM `<webview>`s, which have NO native suspend:
// every background tab keeps rendering and running timers. The cap freezes
// the coldest eligible tabs through CDP `Page.setWebLifecycleState` (Chromium
// page freezing — DOM and in-page state survive, thaw has no reload cost).
// Protection matrix: never freeze the active tab, a loading tab, a blank
// resting tab, the tab the agent is mid-operation on, or (preferentially) an
// agent-created tab; an idle grace keeps just-switched tabs from flapping.

/** Panel-embedded cap (zcode's desktop BrowserView keeps 32; ours is a pane). */
const RESIDENCY_LIMIT = 16;
/** A tab younger than this is never frozen (about-to-be-switched-back guard). */
const RESIDENCY_IDLE_MS = 30_000;

async function setLifecycle(tabId: string, lifecycle: "frozen" | "active"): Promise<boolean> {
	const res = await window.electronAPI?.managedBrowserSetLifecycle({ tabId, state: lifecycle }).catch(() => null);
	return res?.ok === true;
}

/** Pause a background tab. Fire-and-forget: residency is best-effort by design. */
function freezeTab(tabId: string): void {
	void setLifecycle(tabId, "frozen").then(ok => {
		if (ok) patchTab(tabId, { frozen: true });
	});
}

/** Resume a tab on activation; a frozen page is dead to input, so a failed
 *  thaw falls back to a reload (the partition keeps logins, in-page state
 *  is what a reload costs). */
async function thawTab(tabId: string): Promise<void> {
	if (await setLifecycle(tabId, "active")) {
		patchTab(tabId, { frozen: false });
		touchTab(tabId);
		return;
	}
	try {
		elements.get(tabId)?.reload();
		patchTab(tabId, { frozen: false });
	} catch {
		// guest gone
	}
}

/** Freeze the coldest eligible tabs when the set exceeds the cap. */
export function enforceResidency(): void {
	const tabs = state.tabs;
	if (tabs.length <= RESIDENCY_LIMIT) return;
	const busyTabId = state.activity?.status === "dispatched" ? state.activity.tabId : null;
	const idleBefore = Date.now() - RESIDENCY_IDLE_MS;
	const eligible = (tab: ManagedTab): boolean =>
		tab.id !== state.activeId &&
		tab.id !== busyTabId &&
		!tab.loading &&
		!tab.blank &&
		!tab.frozen &&
		tab.lastActivityAt <= idleBefore;
	// User tabs are the freeze-first pool; agent-created tabs only when no
	// user tab can take the hit.
	let pool = tabs.filter(tab => eligible(tab) && !tab.agent);
	if (pool.length === 0) pool = tabs.filter(eligible);
	pool.sort((a, b) => a.lastActivityAt - b.lastActivityAt);
	const excess = tabs.length - RESIDENCY_LIMIT;
	for (const victim of pool.slice(0, excess)) freezeTab(victim.id);
}

/** Element picker: the script runs inside the guest (cross-origin safe). */
export async function pickElement(script: string): Promise<unknown> {
	const tab = activeTab();
	const el = tab ? elements.get(tab.id) : null;
	if (!el) return null;
	try {
		return await el.executeJavaScript(script, true);
	} catch {
		return null;
	}
}

export async function stopAgentOp(tabId?: string): Promise<void> {
	await window.electronAPI?.managedBrowserStop(tabId);
}

export async function clearData(mode: "cookies" | "all"): Promise<void> {
	await window.electronAPI?.managedBrowserClearData(mode);
}

export async function answerConfirm(requestId: string, allow: boolean): Promise<void> {
	set({ confirm: null });
	await window.electronAPI?.managedBrowserConfirmResult({ requestId, allow });
}

/**
 * Live tab styling hint: `<meta name="theme-color">` has no webview event, so it
 * is read from the guest on navigation (best-effort, ignore failures).
 */
export async function refreshThemeColor(tabId: string): Promise<void> {
	const el = elements.get(tabId);
	if (!el) return;
	try {
		const raw = await el.executeJavaScript(
			`(()=>{const m=document.querySelector('meta[name="theme-color"]');return m?m.getAttribute('content'):null})()`,
			true,
		);
		if (typeof raw === "string" && /^#[0-9a-f]{6}$/i.test(raw)) patchTab(tabId, { themeColor: raw });
	} catch {
		// guest not scriptable (about:blank / crashed)
	}
}

let wired = false;

/** Bind main-process pushes once (idempotent; called by the host component). */
export function wireHost(): void {
	if (wired) return;
	wired = true;
	const api = window.electronAPI;
	if (!api) return;
	api.onManagedBrowserState(push => {
		set({
			port: push.port ?? null,
			activity: push.activity ?? null,
			agentActivity: push.agentActivity === true,
		});
	});
	api.onManagedBrowserConfirm(input => set({ confirm: input }));
	api.onManagedBrowserCreateTab(input => {
		void createTab(input.url, { tabId: input.tabId, agent: true }).catch(() => {
			void api.managedBrowserGuestGone(input.tabId).catch(() => {});
		});
	});
	api.onManagedBrowserSelectTab(input => selectTab(input.tabId));
	api.onManagedBrowserCloseTab(input => closeTab(input.tabId));
	void api.managedBrowserGetState().then(snapshot => {
		set({ port: snapshot.port ?? null, activity: snapshot.activity ?? null });
	});
	// Long-lived sets can exceed the cap without any new tab (restored tabs
	// all arrive at once); re-check periodically rather than only on create.
	window.setInterval(enforceResidency, 30_000);
}

/**
 * Persisted tab set (URLs + which one was active).
 *
 * A renderer reload destroys every guest (dev hot-reload, window reload,
 * renderer crash): the pages reload from these URLs — logins survive in the
 * partition — but their in-page state does not, so the tab strip and the
 * user's place in it are what this restores.
 */
const TABS_KEY = "musepi-gui-managed-browser-tabs";

export function persistTabs(): void {
	try {
		const activeIndex = state.tabs.findIndex(tab => tab.id === state.activeId);
		localStorage.setItem(
			TABS_KEY,
			JSON.stringify({ urls: state.tabs.map(tab => tab.url), active: Math.max(0, activeIndex) }),
		);
	} catch {
		// storage unavailable
	}
}

export function restoreTabs(): void {
	try {
		const raw = localStorage.getItem(TABS_KEY);
		if (!raw) return;
		const parsed: unknown = JSON.parse(raw);
		// Accept the older plain-array record too.
		const urls = Array.isArray(parsed)
			? parsed
			: Array.isArray((parsed as { urls?: unknown })?.urls)
				? ((parsed as { urls: unknown[] }).urls ?? [])
				: [];
		const active = Array.isArray(parsed) ? 0 : Number((parsed as { active?: unknown })?.active) || 0;
		let first: string | null = null;
		urls.slice(0, 8).forEach((url, index) => {
			if (typeof url !== "string" || !url) return;
			if (index === active) first = url;
			else void createTab(url).catch(() => {});
		});
		// Restore the active tab last so it ends up selected.
		if (first !== null) void createTab(first).catch(() => {});
	} catch {
		// corrupted record — start clean
	}
}
