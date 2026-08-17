/**
 * Managed in-app browser pane (Proma 吸收, BrowserPanel/BrowserSlot parity).
 *
 * Electron path: the panel content is a plain div slot; the REAL page is an
 * Electron `WebContentsView` owned by the main process (managed-browser.cjs),
 * which projects the slot's CSS rect onto the native view via
 * `managed-browser:set-layout`. The renderer only reads projected state and
 * drives navigation controls over IPC — it never touches WebContents/CDP.
 *
 * The agent's browser tool drives the SAME views through the loopback CDP
 * bridge (`browser.gui`), so user and agent share one browser instance and
 * its persistent login state; agent operations surface in the activity line
 * and auto-open the panel (ContextPanel listens for agentActivity).
 */
import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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

export function ManagedBrowserPane(): ReactNode {
	const api = window.electronAPI;
	const [state, setState] = useState<ManagedBrowserState | null>(null);
	const [url, setUrl] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [confirm, setConfirm] = useState<ManagedBrowserConfirmRequest | null>(null);
	const [picking, setPicking] = useState(false);
	const [pickedSelector, setPickedSelector] = useState<string | null>(null);
	const slotRef = useRef<HTMLDivElement | null>(null);
	const urlRef = useRef<HTMLInputElement | null>(null);

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
				visible: visible && !hasBlockingOverlay(),
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
	}, []);

	// Sync the URL bar from state, but never while the user is typing
	// (loading/navigation state pushes must not clobber the input).
	useEffect(() => {
		const el = urlRef.current;
		if (el && document.activeElement === el) return;
		setUrl(state?.tabs.find(tab => tab.id === state.activeTabId)?.url ?? "");
	}, [state?.activeTabId, state?.tabs]);

	const navigate = useCallback(async () => {
		if (!api || !url.trim()) return;
		const result = await api.managedBrowserNavigate({ url: url.trim() }).catch(() => null);
		setError(result && !result.ok ? (result.error ?? t("public http https only")) : null);
		if (result?.ok) setUrl(result.url ?? url);
	}, [url]);

	const activeTabId = state?.activeTabId ?? null;
	const activity = state?.activity ?? null;

	return (
		<div className="relative flex h-full min-h-0 flex-col">
			{/* Toolbar: back / forward / reload / URL bar / new tab / close */}
			<div className="flex items-center gap-1 px-1 pb-1 pt-1">
				<button
					type="button"
					className="gui-pane-action !w-auto px-1.5"
					aria-label={t("back")}
					title={t("back")}
					disabled={!state?.canGoBack}
					onClick={() => void api?.managedBrowserGoBack()}
				>
					<Icon name="arrow-left" className="h-3.5 w-3.5" />
				</button>
				<button
					type="button"
					className="gui-pane-action !w-auto px-1.5"
					aria-label={t("forward")}
					title={t("forward")}
					disabled={!state?.canGoForward}
					onClick={() => void api?.managedBrowserGoForward()}
				>
					<Icon name="arrow-right" className="h-3.5 w-3.5" />
				</button>
				<button
					type="button"
					className="gui-pane-action !w-auto px-1.5"
					aria-label={t("refresh")}
					title={t("refresh")}
					onClick={() => void api?.managedBrowserReload()}
				>
					<Icon name="refresh" className="h-3.5 w-3.5" />
				</button>
				<button
					type="button"
					className={`gui-pane-action !w-auto px-1.5${picking ? " gui-pane-action--active" : ""}`}
					aria-label={t("pick element")}
					title={t("pick element")}
					disabled={picking}
					onClick={() => void pickElement()}
				>
					<Icon name="target" className="h-3.5 w-3.5" />
				</button>
				<form
					className="flex min-w-0 flex-1 items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--color-surface-sunken)] px-2 py-1"
					onSubmit={e => {
						e.preventDefault();
						void navigate();
					}}
				>
					<Icon name="global" className="h-3 w-3 flex-shrink-0 text-[var(--color-text-faint)]" />
					<input
						ref={urlRef}
						className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--color-text)] outline-none"
						value={url}
						spellCheck={false}
						placeholder={t("public http https only")}
						onChange={e => setUrl(e.target.value)}
					/>
				</form>
				<button
					type="button"
					className="gui-pane-action !w-auto px-2"
					aria-label={t("new browser tab")}
					title={t("new browser tab")}
					onClick={() => void api?.managedBrowserNewTab()}
				>
					<Icon name="stack" className="h-3.5 w-3.5" />
				</button>
			</div>
			{/* Tab strip (Agent-created tabs are badged; selecting only changes
			 * what the user sees — the agent keeps its own working tab). */}
			{state && state.tabs.length > 0 && (
				<div className="flex items-center gap-1 overflow-x-auto px-1 pb-1">
					{state.tabs.map(tab => (
						<button
							key={tab.id}
							type="button"
							className={`gui-pane-tool flex-shrink-0 px-1.5 py-0.5 text-[11px] ${
								tab.id === activeTabId ? "gui-pane-tool--active" : ""
							}`}
							title={tab.url}
							aria-label={`${tab.title}${tab.openedByAgent ? ` (${t("agent created tab")})` : ""}`}
							onClick={() => void api?.managedBrowserSelectTab(tab.id)}
						>
							<span className="max-w-[110px] truncate">{tab.title || t("new browser tab")}</span>
							{tab.openedByAgent && (
								<span className="ml-1 rounded bg-[var(--color-accent)]/15 px-1 py-px text-[9px] font-medium text-[var(--color-accent)]">
									{t("agent created tab")}
								</span>
							)}
						</button>
					))}
				</div>
			)}
			{/* Agent activity ledger (sanitized in main — never page text,
			 * cookies or script source). */}
			{activity && (
				<div
					className="flex min-h-6 items-center gap-2 border-b border-[var(--border)] bg-[var(--color-accent)]/[0.04] px-2 py-0.5 text-[11px]"
					role="status"
					aria-live="polite"
				>
					<span className="flex-shrink-0 font-medium text-[var(--color-accent)]">{t("agent activity")}</span>
					<span className="flex-shrink-0 text-[var(--color-text-faint)]">{statusLabel(activity.status)}</span>
					<span className="truncate text-[var(--color-text-muted)]">
						{activity.summary}
						{activity.domain ? ` · ${activity.domain}` : ""}
					</span>
					{activity.status === "dispatched" && (
						<button
							type="button"
							className="gui-pane-action ml-auto !w-auto px-1.5"
							aria-label={t("stop agent operation")}
							title={t("stop agent operation")}
							onClick={() => void api?.managedBrowserStop(activity.tabId)}
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
			{/* The native WebContentsView renders over this slot via layout
			 * projection; a plain-browser build (no electronAPI) shows the
			 * fallback instead. */}
			{state?.port ? (
				<div
					ref={slotRef}
					className="min-h-0 flex-1 overflow-hidden rounded-lg border border-[var(--border)] bg-white"
					aria-label={t("managed browser")}
				/>
			) : (
				<div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--color-surface-sunken)] px-4 text-center">
					<div className="text-[12px] leading-relaxed text-[var(--color-text-faint)]">
						{t("managed browser unavailable")}
					</div>
				</div>
			)}
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
