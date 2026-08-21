/**
 * Managed in-app browser pane (Proma 吸收 + open-design DesignBrowserPanel
 * UI/UX 吸收).
 *
 * Electron path: the panel content is a plain div slot; the REAL page is an
 * Electron `WebContentsView` owned by the main process (managed-browser.cjs),
 * which projects the slot's CSS rect onto the native view via
 * `managed-browser:set-layout`. The renderer only reads projected state and
 * drives navigation controls over IPC — it never touches WebContents/CDP.
 *
 * Blank tabs (about:blank / no URL yet) hide the native view in main
 * (applyLayout skips blank tabs) so a React start page shows through:
 * quick links + recent visits, absorbing open-design's Reference Board
 * start page (`isBlank ? <DesignBrowserStart/> : <webview/>` pattern).
 *
 * The agent's browser tool drives the SAME views through the loopback CDP
 * bridge (`browser.gui`), so user and agent share one browser instance and
 * its persistent login state; agent operations surface in the activity line
 * and auto-open the panel (ContextPanel listens for agentActivity).
 */
import { t } from "@musepi/desktop-web";
import type { KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../vendor/oc-icons";

let nextLayoutRevision = 0;

/** App overlays that must render ABOVE the native view (it always sits on
 *  top of the DOM): dialogs/toasts hide the view while open. Our dialogs
 *  mount/unmount, so presence checks (not data-state toggles) are enough. */
const APP_OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [data-sonner-toast]';

function hasBlockingOverlay(): boolean {
	return document.querySelector(APP_OVERLAY_SELECTOR) !== null;
}

/** Only portal/toast lifecycle mutations — streaming text (characterData)
 *  must never trigger a layout IPC. */
function mutationIsOverlayLifecycle(mutation: MutationRecord): boolean {
	if (mutation.type !== "childList") return false;
	const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
	return nodes.some(node => node instanceof Element && node.closest(APP_OVERLAY_SELECTOR) !== null);
}

const statusLabel = (status: string): string => {
	switch (status) {
		case "dispatched":
			return t("dispatched");
		case "failed":
			return t("failed");
		case "canceled":
			return t("canceled");
		case "verified":
			return t("completed");
		default:
			return t("completed");
	}
};

// ── URL helpers (open-design DesignBrowserPanel parity) ───────────────

const EMPTY_URL = "about:blank";
const HISTORY_KEY = "musepi-gui-managed-browser-history";
const HISTORY_LIMIT = 80;
const HISTORY_SUGGESTION_LIMIT = 20;

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

function labelFromUrl(url: string): string {
	if (url === EMPTY_URL) return t("browser empty tab");
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

interface AddressDisplayParts {
	url: string;
	title?: string;
}

function formatAddressDisplayParts(url: string, title?: string): AddressDisplayParts {
	if (url === EMPTY_URL) return { url: "" };
	const cleanTitle = title?.trim();
	if (!cleanTitle) return { url };
	const fallback = labelFromUrl(url);
	if (cleanTitle === fallback || cleanTitle === url) return { url };
	return { url: url.replace(/\/+$/, ""), title: cleanTitle };
}

function isHistoryUrl(url: string): boolean {
	return url !== EMPTY_URL && (/^https?:\/\//i.test(url) || /^omp-file:\/\//i.test(url));
}

// ── viewport presets (legacy pane parity, moved into the managed pane) ─

const VIEWPORTS = [
	{ key: "browser viewport fit", width: null as number | null },
	{ key: "browser viewport phone", width: 393 },
	{ key: "browser viewport tablet", width: 768 },
	{ key: "browser viewport desktop", width: 1440 },
] as const;

// ── quick links (start page 快速链接) ─────────────────────────────────

const QUICK_LINKS: Array<{ label: string; url: string; icon: "github" | "search" | "book" | "terminal" | "chat-1" | "compass-3" }> = [
	{ label: "GitHub", url: "https://github.com", icon: "github" },
	{ label: "Google", url: "https://www.google.com", icon: "search" },
	{ label: "Bing", url: "https://www.bing.com", icon: "search" },
	{ label: "MDN", url: "https://developer.mozilla.org", icon: "book" },
	{ label: "Stack Overflow", url: "https://stackoverflow.com", icon: "terminal" },
	{ label: "DeepL", url: "https://www.deepl.com", icon: "chat-1" },
];

export function ManagedBrowserPane(): ReactNode {
	const api = window.electronAPI;
	const [state, setState] = useState<ManagedBrowserState | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [confirm, setConfirm] = useState<ManagedBrowserConfirmRequest | null>(null);
	const [picking, setPicking] = useState(false);
	const [pickedSelector, setPickedSelector] = useState<string | null>(null);
	// Address omnibox state (open-design parity): editing shows the raw URL,
	// idle shows `host / title` display parts.
	const [addressValue, setAddressValue] = useState("");
	const [addressEditing, setAddressEditing] = useState(false);
	const [suggestionsOpen, setSuggestionsOpen] = useState(false);
	const [history, setHistory] = useState<BrowserHistoryEntry[]>(() => loadHistory());
	const [menuOpen, setMenuOpen] = useState(false);
	const [viewport, setViewport] = useState<number | null>(null);
	const [copied, setCopied] = useState(false);
	const slotRef = useRef<HTMLDivElement | null>(null);
	const urlRef = useRef<HTMLInputElement | null>(null);
	const chromeRef = useRef<HTMLDivElement | null>(null);

	const activeTab = state?.tabs.find(tab => tab.id === state.activeTabId) ?? null;
	const activeUrl = activeTab?.url ?? EMPTY_URL;
	const isBlank = !activeTab || activeUrl === EMPTY_URL || activeUrl === "";

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

	/** Element picker (bitfun/openchamber parity): capture a page element's
	 *  unique CSS selector for the user to hand to the agent. */
	const pickElement = useCallback(async (): Promise<void> => {
		if (!api || picking) return;
		setPicking(true);
		setPickedSelector(null);
		const res = await api.managedBrowserPickElement().catch(() => null);
		setPicking(false);
		const selector = res?.selector;
		if (selector) setPickedSelector(selector);
	}, [api, picking]);

	useEffect(() => {
		if (!api) return;
		let alive = true;
		void api.managedBrowserGetState().then(snapshot => {
			if (!alive) return;
			setState(snapshot);
			// First open: create the initial tab (main owns all state).
			if (snapshot.tabs.length === 0)
				void api
					.managedBrowserOpen()
					.then(setState)
					.catch(() => {});
		});
		const off = api.onManagedBrowserState(snapshot => {
			if (!alive) return;
			setState(snapshot);
		});
		const offConfirm = api.onManagedBrowserConfirm(request => {
			if (!alive) return;
			setConfirm(request);
		});
		return () => {
			alive = false;
			off();
			offConfirm();
		};
	}, []);

	// Layout projection: slot rect → native view bounds. Re-project on
	// resize + overlay lifecycle; hide the view when the slot unmounts.
	// Blank tabs are skipped in main (start page shows), so project
	// `visible: false` when blank to keep the native view hidden.
	useLayoutEffect(() => {
		if (!api) return;
		const el = slotRef.current;
		if (!el) return;
		let cancelled = false;
		const project = (visible: boolean): void => {
			if (cancelled) return;
			const rect = el.getBoundingClientRect();
			nextLayoutRevision += 1;
			void api.managedBrowserSetLayout({
				bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
				visible: visible && !hasBlockingOverlay() && !isBlank,
				revision: nextLayoutRevision,
			});
		};
		project(true);
		const ro = new ResizeObserver(() => project(true));
		ro.observe(el);
		const mo = new MutationObserver(mutations => {
			if (mutations.some(mutationIsOverlayLifecycle)) project(true);
		});
		mo.observe(document.body, { childList: true, subtree: true });
		const onResize = (): void => project(true);
		window.addEventListener("resize", onResize);
		return () => {
			cancelled = true;
			ro.disconnect();
			mo.disconnect();
			window.removeEventListener("resize", onResize);
			nextLayoutRevision += 1;
			void api.managedBrowserSetLayout({
				bounds: { x: 0, y: 0, width: 0, height: 0 },
				visible: false,
				revision: nextLayoutRevision,
			});
		};
	}, [isBlank]);

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
			if (!api || !target.trim()) return;
			const trimmed = target.trim();
			// If it has no scheme, the main process normalizes it (localhost,
			// omp-file paths, etc.) — pass it through as-is.
			const result = await api.managedBrowserNavigate({ url: trimmed }).catch(() => null);
			setError(result && !result.ok ? (result.error ?? t("public http https only")) : null);
			if (result?.ok) {
				commitVisit(result.url ?? trimmed);
				setAddressValue(result.url ?? trimmed);
				setAddressEditing(false);
				setSuggestionsOpen(false);
			}
		},
		[api, commitVisit],
	);

	const handleAddressSubmit = (e: React.FormEvent): void => {
		e.preventDefault();
		void navigateTo(addressValue);
	};

	// Suggestions: history entries filtered by the query (open-design parity).
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
		return historySuggestions.filter(item =>
			`${item.label} ${item.detail}`.toLocaleLowerCase().includes(query),
		);
	}, [addressEditing, addressValue, history]);

	// Close the menu/suggestions on outside pointerdown (open-design parity).
	useEffect(() => {
		if (!menuOpen && !suggestionsOpen) return;
		const onPointerDown = (event: PointerEvent): void => {
			const chrome = chromeRef.current;
			if (chrome && event.target instanceof Node && chrome.contains(event.target)) return;
			setMenuOpen(false);
			setSuggestionsOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [menuOpen, suggestionsOpen]);

	const addressDisplayParts = addressEditing ? { url: "" } : formatAddressDisplayParts(activeUrl, activeTab?.title);
	const shownAddressValue = addressEditing ? addressValue : "";
	const pageTitle = activeTab?.title?.trim() || labelFromUrl(activeUrl);
	const pageIconUrl = faviconUrl(activeUrl);

	const copyCurrentUrl = useCallback(async (): Promise<void> => {
		await navigator.clipboard.writeText(activeUrl).catch(() => {});
		setCopied(true);
		window.setTimeout(() => setCopied(false), 1400);
	}, [activeUrl]);

	const clearHistory = useCallback((): void => {
		setHistory([]);
		saveHistory([]);
		setMenuOpen(false);
	}, []);

	const clearBrowserData = useCallback(
		async (mode: "cookies" | "all"): Promise<void> => {
			if (!api) return;
			await api.managedBrowserClearData(mode).catch(() => null);
			setMenuOpen(false);
		},
		[api],
	);

	const openInSystem = useCallback((): void => {
		if (!api || !/^https?:\/\//i.test(activeUrl)) return;
		void api.managedBrowserOpenExternal(activeUrl).catch(() => {});
		setMenuOpen(false);
	}, [api, activeUrl]);

	const onAddressKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
		if (e.key === "Escape") {
			setAddressEditing(false);
			setSuggestionsOpen(false);
			e.currentTarget.blur();
		}
	};

	const activeTabLoading = Boolean(activeTab?.loading);

	return (
		<div className="relative flex min-h-0 flex-1 flex-col">
			{/* Chrome bar: nav / address omnibox / actions (open-design db-chrome) */}
			<div ref={chromeRef} className="gui-browser-chrome">
				<div className="gui-browser-nav">
					<button
						type="button"
						className="gui-browser-icon-btn"
						aria-label={t("back")}
						title={t("back")}
						disabled={!state?.canGoBack}
						onClick={() => void api?.managedBrowserGoBack()}
					>
						<Icon name="arrow-go-back" className="h-4 w-4" />
					</button>
					<button
						type="button"
						className="gui-browser-icon-btn"
						aria-label={t("forward")}
						title={t("forward")}
						disabled={!state?.canGoForward}
						onClick={() => void api?.managedBrowserGoForward()}
					>
						<Icon name="arrow-go-forward" className="h-4 w-4" />
					</button>
					<button
						type="button"
						className={`gui-browser-icon-btn${activeTabLoading ? " gui-browser-icon-btn--spinning" : ""}`}
						aria-label={activeTabLoading ? t("stop agent operation") : t("refresh")}
						title={activeTabLoading ? t("stop agent operation") : t("refresh")}
						disabled={isBlank}
						onClick={() => {
							if (activeTabLoading) void api?.managedBrowserStop(activeTab?.id);
							else void api?.managedBrowserReload();
						}}
					>
						<Icon name={activeTabLoading ? "close" : "refresh"} className="h-4 w-4" />
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
					<div className="gui-browser-address-field">
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
								window.requestAnimationFrame(() => e.currentTarget.select());
							}}
							onBlur={e => {
								if (e.currentTarget.form?.contains(e.relatedTarget as Node | null)) return;
								setSuggestionsOpen(false);
								window.setTimeout(() => setAddressEditing(false), 80);
							}}
							onKeyDown={onAddressKeyDown}
							placeholder={isBlank ? t("browser search placeholder") : ""}
							aria-label={t("browser search placeholder")}
							autoComplete="off"
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
					{suggestionsOpen && suggestions.length > 0 ? (
						<div className="gui-browser-suggestions" role="listbox">
							{suggestions.map(item => (
								<button
									key={item.key}
									type="button"
									role="option"
									onClick={() => void navigateTo(item.url)}
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
						</div>
					) : null}
				</form>
				<div className="gui-browser-actions">
					<button
						type="button"
						className={`gui-browser-icon-btn${picking ? " gui-browser-icon-btn--active" : ""}`}
						aria-label={t("pick element")}
						title={t("pick element")}
						disabled={picking || isBlank}
						onClick={() => void pickElement()}
					>
						<Icon name="target" className="h-4 w-4" />
					</button>
					<div className="gui-browser-action-item">
						<button
							type="button"
							className={`gui-browser-icon-btn${menuOpen ? " gui-browser-icon-btn--active" : ""}`}
							aria-label={t("browser menu")}
							title={t("browser menu")}
							onClick={() => {
								setMenuOpen(o => !o);
								setSuggestionsOpen(false);
							}}
						>
							<Icon name="more-2" className="h-4 w-4" />
						</button>
						{menuOpen ? (
							<div className="gui-browser-menu" role="menu">
								{/* Viewport presets */}
								<span className="gui-browser-menu-label">{t("browser viewport fit")}</span>
								<div className="gui-browser-menu-viewports">
									{VIEWPORTS.map(v => (
										<button
											key={v.key}
											type="button"
											className={viewport === v.width ? "gui-browser-menu-chip--active" : ""}
											onClick={() => {
												setViewport(v.width);
												setMenuOpen(false);
											}}
										>
											{t(v.key)}
										</button>
									))}
								</div>
								<span className="gui-browser-menu-sep" />
								<button
									type="button"
									role="menuitem"
									disabled={isBlank}
									onClick={() => {
										void copyCurrentUrl();
										setMenuOpen(false);
									}}
								>
									<Icon name="clipboard" className="h-3.5 w-3.5" />
									{copied ? t("browser copy url done") : t("browser copy url")}
								</button>
								<button
									type="button"
									role="menuitem"
									disabled={isBlank || !/^https?:\/\//i.test(activeUrl)}
									onClick={openInSystem}
								>
									<Icon name="external-link" className="h-3.5 w-3.5" />
									{t("browser open in system")}
								</button>
								<button
									type="button"
									role="menuitem"
									disabled={isBlank}
									onClick={() => {
										void api?.managedBrowserHardReload();
										setMenuOpen(false);
									}}
								>
									<Icon name="refresh" className="h-3.5 w-3.5" />
									{t("browser hard reload")}
								</button>
								<span className="gui-browser-menu-sep" />
								<button
									type="button"
									role="menuitem"
									disabled={history.length === 0}
									onClick={clearHistory}
								>
									<Icon name="history" className="h-3.5 w-3.5" />
									{t("browser clear history")}
								</button>
								<button
									type="button"
									role="menuitem"
									onClick={() => void clearBrowserData("cookies")}
								>
									<Icon name="lock" className="h-3.5 w-3.5" />
									{t("browser clear cookies")}
								</button>
								<button
									type="button"
									role="menuitem"
									onClick={() => void clearBrowserData("all")}
								>
									<Icon name="delete-bin" className="h-3.5 w-3.5" />
									{t("browser clear all data")}
								</button>
							</div>
						) : null}
					</div>
					<button
						type="button"
						className="gui-browser-icon-btn"
						aria-label={t("browser new tab")}
						title={t("browser new tab")}
						onClick={() => void api?.managedBrowserNewTab()}
					>
						<Icon name="add" className="h-4 w-4" />
					</button>
				</div>
			</div>
			{/* Tab strip (Agent-created tabs are badged; selecting only changes
			 * what the user sees — the agent keeps its own working tab). */}
			{state && state.tabs.length > 0 && (
				<div className="flex items-center gap-1 overflow-x-auto px-1 pb-1">
					{state.tabs.map(tab => (
						<div
							key={tab.id}
							className={`gui-browser-tab${tab.id === state.activeTabId ? " gui-browser-tab--active" : ""}`}
							title={tab.url}
						>
							<button
								type="button"
								className="gui-browser-tab-main"
								aria-label={`${tab.title}${tab.openedByAgent ? ` (${t("agent created tab")})` : ""}`}
								onClick={() => void api?.managedBrowserSelectTab(tab.id)}
							>
								<span className="max-w-[110px] truncate">
									{tab.title?.trim() || t("browser empty tab")}
								</span>
								{tab.openedByAgent && (
									<span className="gui-browser-tab-badge">{t("agent created tab")}</span>
								)}
							</button>
							<button
								type="button"
								className="gui-browser-tab-close"
								aria-label={t("browser close tab")}
								title={t("browser close tab")}
								onClick={() => void api?.managedBrowserCloseTab(tab.id)}
							>
								<Icon name="close" className="h-3 w-3" />
							</button>
						</div>
					))}
				</div>
			)}
			{/* Agent activity ledger (sanitized in main — never page text,
			 * cookies or script source). */}
			{state?.activity && (
				<div
					className="flex min-h-6 items-center gap-2 border-b border-[var(--border)] bg-[var(--color-accent)]/[0.04] px-2 py-0.5 text-[11px]"
					role="status"
					aria-live="polite"
				>
					<span className="flex-shrink-0 font-medium text-[var(--color-accent)]">{t("agent activity")}</span>
					<span className="flex-shrink-0 text-[var(--color-text-faint)]">{statusLabel(state.activity.status)}</span>
					<span className="truncate text-[var(--color-text-muted)]">
						{state.activity.summary}
						{state.activity.domain ? ` · ${state.activity.domain}` : ""}
					</span>
					{state.activity.status === "dispatched" && (
						<button
							type="button"
							className="gui-pane-action ml-auto !w-auto px-1.5"
							aria-label={t("stop agent operation")}
							title={t("stop agent operation")}
							onClick={() => void api?.managedBrowserStop(state.activity?.tabId)}
						>
							<Icon name="stop" className="h-3 w-3" />
						</button>
					)}
				</div>
			)}
			{pickedSelector && (
				<div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--color-accent)]/[0.06] px-2 py-1">
					<span className="flex-shrink-0 text-[11px] font-medium text-[var(--color-accent)]">
						{t("picked element")}
					</span>
					<code className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--color-text)]">
						{pickedSelector}
					</code>
					<button
						type="button"
						className="gui-pane-action !w-auto px-1.5 text-[11px]"
						aria-label={t("copy")}
						title={t("copy")}
						onClick={() => {
							void navigator.clipboard.writeText(pickedSelector).catch(() => {});
						}}
					>
						<Icon name="clipboard" className="h-3 w-3" />
					</button>
					<button
						type="button"
						className="gui-pane-action !w-auto px-1.5"
						aria-label={t("close")}
						title={t("close")}
						onClick={() => setPickedSelector(null)}
					>
						<Icon name="close" className="h-3 w-3" />
					</button>
				</div>
			)}
			{error && (
				<div className="border-b border-[var(--border)] px-2 py-1 text-[11px] text-[var(--color-danger)]">
					{error}
				</div>
			)}
			{/* Content: blank tabs show the React start page (native view is
			 * hidden in main); real pages project onto the slot. Viewport
			 * presets constrain the slot width, centered. */}
			<div className="gui-browser-content">
				{isBlank ? (
					<BrowserStartPage
						history={history}
						onNavigate={(url: string) => void navigateTo(url)}
						onFocusAddress={() => {
							setAddressEditing(true);
							setAddressValue("");
							urlRef.current?.focus();
						}}
					/>
				) : viewport ? (
					<div className="gui-browser-viewport-wrap" style={{ maxWidth: viewport }}>
						<div
							ref={slotRef}
							className="gui-browser-slot"
							aria-label={t("managed browser")}
						/>
					</div>
				) : (
					<div
						ref={slotRef}
						className="gui-browser-slot"
						aria-label={t("managed browser")}
					/>
				)}
			</div>
			{/* Local-only login note (Proma parity) */}
			<div className="flex items-center justify-between px-2 pb-1 pt-0.5">
				<span className="text-[10.5px] text-[var(--color-text-faint)]">{t("managed browser local only")}</span>
				{state?.port ? (
					<span className="text-[10.5px] text-[var(--color-text-faint)]">
						{t("managed browser port", { port: String(state.port) })}
					</span>
				) : null}
			</div>
			{/* Risky-navigation consent gate (role=dialog → the overlay lifecycle
			 * watcher hides the native view while this is open). */}
			{confirm && (
				<div
					role="dialog"
					aria-modal="true"
					aria-label={t("risky navigation")}
					className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 px-6"
				>
					<div className="max-w-[380px] rounded-lg border border-[var(--border)] bg-[var(--color-surface)] p-3 shadow-lg">
						<div className="mb-1 text-[12px] font-medium text-[var(--color-text)]">{t("risky navigation")}</div>
						<div className="mb-2 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
							{t("risky navigation description")}
						</div>
						<div className="mb-3 break-all rounded-md bg-[var(--color-surface-sunken)] px-2 py-1 font-mono text-[11px] text-[var(--color-text)]">
							{confirm.url}
						</div>
						<div className="flex justify-end gap-2">
							<button
								type="button"
								className="gui-pane-action !w-auto px-2.5 py-1"
								onClick={() => {
									void api?.managedBrowserConfirmResult({ requestId: confirm.requestId, allow: false });
									setConfirm(null);
								}}
							>
								{t("deny")}
							</button>
							<button
								type="button"
								className="gui-pane-action !w-auto bg-[var(--color-accent)] px-2.5 py-1 text-[var(--color-on-accent)]"
								onClick={() => {
									void api?.managedBrowserConfirmResult({ requestId: confirm.requestId, allow: true });
									setConfirm(null);
								}}
							>
								{t("allow")}
							</button>
						</div>
					</div>
				</div>
			)}
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
				<span className="gui-browser-start-kicker">{t("browser")}</span>
				<h2>{t("browser start title")}</h2>
				<p className="gui-browser-start-sub">{t("browser start subtitle")}</p>
			</div>
			<div className="gui-browser-start-section">
				<div className="gui-browser-start-section-head">
					<span>{t("browser quick links")}</span>
					<small>{t("browser quick links hint")}</small>
				</div>
				<div className="gui-browser-quick-grid">
					{QUICK_LINKS.map(link => (
						<button
							key={link.url}
							type="button"
							className="gui-browser-quick-card"
							onClick={() => onNavigate(link.url)}
						>
							<Icon name={link.icon} className="h-4 w-4" />
							<span>{link.label}</span>
						</button>
					))}
				</div>
			</div>
			<div className="gui-browser-start-section">
				<div className="gui-browser-start-section-head">
					<span>{t("browser recent visits")}</span>
					<small>{t("browser recent hint")}</small>
				</div>
				{recent.length === 0 ? (
					<div className="gui-browser-start-empty">
						<p>{t("browser no history")}</p>
						<p>{t("browser type or paste url")}</p>
						<button type="button" className="gui-browser-start-address" onClick={onFocusAddress}>
							<Icon name="compass-3" className="h-4 w-4" />
							<span>{t("browser search placeholder")}</span>
						</button>
					</div>
				) : (
					<div className="gui-browser-recent-list">
						{recent.map(entry => (
							<button
								key={entry.url}
								type="button"
								className="gui-browser-recent-item"
								title={entry.url}
								onClick={() => onNavigate(entry.url)}
							>
								<span className="gui-browser-recent-icon">
									<Icon name="history" className="h-3.5 w-3.5" />
								</span>
								<span className="gui-browser-recent-copy">
									<span>{entry.title || labelFromUrl(entry.url)}</span>
									<small>{hostnameFromUrl(entry.url)}</small>
								</span>
								<span className="gui-browser-recent-open">{t("browser open")}</span>
							</button>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
