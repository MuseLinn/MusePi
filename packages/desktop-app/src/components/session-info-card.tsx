/**
 * Floating session info card (desktop GUI).
 *
 * The right panel owns the session's metadata while it is open, so this card is
 * the collapsed panel's stand-in: it floats over the transcript's right edge and
 * repeats the few facts that otherwise cost a panel open — session title, model
 * reference ("provider/id"), working-tree diff totals, the open panel tabs, and
 * the surfaces that can still be opened from here.
 *
 * Wiring split: app.tsx owns the open state (per-session, see
 * `useSessionInfoCardVisibility`), ChatView supplies the panel tabs + surface
 * callbacks, and this module reads only what the daemon already exposes —
 * `session.contextUsage` for the model and `git.numstat` for the diff totals.
 */
import { type TranslationKey, t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PanelTab } from "../lib/panel-tabs";
import type { RpcClient } from "../lib/rpc";
import { readHiddenSurfaces, SURFACE_HIDDEN_KEY, SURFACES, surfaceVisible } from "../lib/surfaces/registry";
import { Icon, type IconName } from "../vendor/oc-icons";

/** One preference per session; the `musepi-gui-` prefix is the GUI's key rule. */
const SESSION_INFO_STORAGE_PREFIX = "musepi-gui-session-info-";

/** Tabs past this fold behind 「查看更多」 so the card stays a glanceable tile. */
const VISIBLE_TAB_LIMIT = 6;

/** Same cadence as StatusCards' git poll — the two read the same working tree. */
const POLL_MS = 15_000;

/** Wire shape of `session.contextUsage` (only the model field is read here). */
interface UsageView {
	model?: string | null;
}

/** Wire shape of `git.numstat`. */
interface NumstatView {
	files?: Array<{ path: string; added: number; removed: number; binary: boolean }>;
	error?: string;
}

interface ChangesView {
	added: number;
	removed: number;
	files: number;
}

type UsageState = "loading" | "ready" | "error";
type ChangesState = "loading" | "ready" | "none" | "error";

function sessionInfoStorageKey(sessionId: string): string {
	return `${SESSION_INFO_STORAGE_PREFIX}${sessionId}`;
}

/** Stored preference, or null when this session never chose. */
function readSessionInfoPreference(sessionId: string | null): boolean | null {
	if (!sessionId) return null;
	try {
		const raw = localStorage.getItem(sessionInfoStorageKey(sessionId));
		if (raw === "1") return true;
		if (raw === "0") return false;
		return null;
	} catch {
		return null;
	}
}

function writeSessionInfoPreference(sessionId: string | null, open: boolean): void {
	if (!sessionId) return;
	try {
		localStorage.setItem(sessionInfoStorageKey(sessionId), open ? "1" : "0");
	} catch {
		/* Storage full / disabled — the card's visibility is cosmetic. */
	}
}

interface SessionInfoVisibility {
	open: boolean;
	toggle(): void;
}

/**
 * Per-session open state.
 *
 * The panel's own state supplies the DEFAULT: a collapsed panel shows the card,
 * an expanded one hides it. A manual toggle wins until the panel next changes
 * state; switching sessions restores that session's stored choice instead of
 * carrying the previous session's toggle across.
 */
export function useSessionInfoCardVisibility({
	sessionId,
	panelOpen,
}: {
	sessionId: string | null;
	panelOpen: boolean;
}): SessionInfoVisibility {
	const [open, setOpen] = useState<boolean>(() => readSessionInfoPreference(sessionId) ?? !panelOpen);
	// Last panel state this hook observed. Comparing against it makes the panel
	// effect a real-change trigger only: a session switch must not reset the
	// per-session choice it just restored.
	const panelOpenRef = useRef(panelOpen);

	useEffect(() => {
		setOpen(readSessionInfoPreference(sessionId) ?? !panelOpenRef.current);
	}, [sessionId]);

	useEffect(() => {
		if (panelOpenRef.current === panelOpen) return;
		panelOpenRef.current = panelOpen;
		const next = !panelOpen;
		setOpen(next);
		writeSessionInfoPreference(sessionId, next);
	}, [panelOpen, sessionId]);

	const toggle = useCallback((): void => {
		setOpen(current => {
			const next = !current;
			writeSessionInfoPreference(sessionId, next);
			return next;
		});
	}, [sessionId]);

	return { open, toggle };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function hasChangesOf(changes: ChangesView | null): changes is ChangesView {
	return changes !== null && changes.files > 0;
}

interface SessionInfoCardProps {
	sessionId: string | null;
	rpc: RpcClient | null;
	/** Working tree the diff totals describe. */
	cwd?: string | null;
	/** Session title; falls back to the untitled-session copy. */
	title?: string | null;
	/** Open panel tabs, in strip order. */
	tabs: readonly PanelTab[];
	activeTabId?: string | null;
	/** Px from the chat column's top — keeps the card clear of the header row. */
	top?: number;
	onSelectTab?(id: string): void;
	onOpenSurface?(id: string): void;
}

export function SessionInfoCard({
	sessionId,
	rpc,
	cwd,
	title,
	tabs,
	activeTabId = null,
	top = 54,
	onSelectTab,
	onOpenSurface,
}: SessionInfoCardProps): ReactNode {
	const [usage, setUsage] = useState<UsageView | null>(null);
	const [usageState, setUsageState] = useState<UsageState>("loading");
	const [changes, setChanges] = useState<ChangesView | null>(null);
	const [changesState, setChangesState] = useState<ChangesState>("loading");
	const [changesError, setChangesError] = useState<string | null>(null);
	const [reloadToken, setReloadToken] = useState(0);
	const [showAllTabs, setShowAllTabs] = useState(false);

	useEffect(() => {
		if (!rpc || !sessionId) return;
		let alive = true;
		const load = async (): Promise<void> => {
			const [usageResult, numstatResult] = await Promise.allSettled([
				rpc.request<UsageView | null>("session.contextUsage", { sessionId }),
				cwd ? rpc.request<NumstatView>("git.numstat", { cwd }) : Promise.resolve(null),
			]);
			if (!alive) return;

			if (usageResult.status === "fulfilled") {
				setUsage({ model: usageResult.value?.model ?? null });
				setUsageState("ready");
			} else {
				setUsageState("error");
			}

			if (!cwd) {
				setChanges({ added: 0, removed: 0, files: 0 });
				setChangesState("none");
				setChangesError(null);
				return;
			}
			if (numstatResult.status === "rejected") {
				setChangesState("error");
				setChangesError(errorText(numstatResult.reason));
				return;
			}
			const value = numstatResult.value;
			const failure = typeof value?.error === "string" ? value.error : null;
			if (failure === "not a git repository") {
				// Outside a repository there is nothing to diff, and that is a
				// readout, not a failure.
				setChanges({ added: 0, removed: 0, files: 0 });
				setChangesState("none");
				setChangesError(null);
				return;
			}
			if (failure) {
				setChangesState("error");
				setChangesError(failure);
				return;
			}
			const files = value?.files ?? [];
			setChanges({
				added: files.reduce((sum, file) => sum + file.added, 0),
				removed: files.reduce((sum, file) => sum + file.removed, 0),
				files: files.length,
			});
			setChangesState("ready");
			setChangesError(null);
		};
		setUsageState("loading");
		setChangesState("loading");
		void load();
		const timer = setInterval(() => void load(), POLL_MS);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [rpc, sessionId, cwd, reloadToken]);

	// A hidden-surface edit in another part of the GUI arrives as a storage event;
	// re-reading on it keeps 「可打开」 honest without polling.
	const [hiddenSurfaces, setHiddenSurfaces] = useState<readonly string[]>(readHiddenSurfaces);
	useEffect(() => {
		const onStorage = (event: StorageEvent): void => {
			if (event.key === SURFACE_HIDDEN_KEY) setHiddenSurfaces(readHiddenSurfaces());
		};
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, []);

	const openSurfaces = useMemo(() => new Set(tabs.map(item => item.surface)), [tabs]);
	const surfaces = useMemo(() => {
		const hidden = new Set(hiddenSurfaces);
		return SURFACES.filter(
			surface =>
				!hidden.has(surface.id) && surfaceVisible(surface, { rpc, sessionId, cwd: cwd ?? undefined, openSurfaces }),
		);
	}, [rpc, sessionId, cwd, openSurfaces, hiddenSurfaces]);

	const visibleTabs = showAllTabs ? tabs : tabs.slice(0, VISIBLE_TAB_LIMIT);
	const foldedTabCount = tabs.length - visibleTabs.length;
	const sessionTitle = title?.trim() || t("general.sessionInfoUntitled");
	const model = usage?.model ?? null;
	const retry = useCallback((): void => setReloadToken(token => token + 1), []);

	return (
		<aside
			className="gui-session-info"
			role="region"
			aria-label={t("sessionInfo.title")}
			style={{ top: `${top}px`, maxHeight: `calc(100% - ${top + 12}px)` }}
		>
			<header className="gui-session-info-head">
				<Icon name="information" className="gui-session-info-head-icon" />
				<span className="gui-session-info-title" title={sessionTitle}>
					{sessionTitle}
				</span>
			</header>

			<div className="gui-session-info-model" data-state={usageState} title={model ?? undefined}>
				<Icon name="ai-agent" className="gui-session-info-row-icon" />
				<span className="gui-session-info-row-label">{t("sessionInfo.model")}</span>
				<span className="gui-session-info-model-value">
					{model ?? (usageState === "loading" ? t("sessionInfo.loading") : t("sessionInfo.unavailable"))}
				</span>
			</div>

			<section className="gui-session-info-changes" data-state={changesState}>
				<div className="gui-session-info-section-label">{t("general.sessionInfoChanges")}</div>
				{changesState === "loading" ? (
					<p className="gui-session-info-note">{t("sessionInfo.loading")}</p>
				) : changesState === "error" ? (
					<div className="gui-session-info-error" role="alert">
						<span className="gui-session-info-note">{t("sessionInfo.error")}</span>
						{changesError ? <span className="gui-session-info-error-detail">{changesError}</span> : null}
						<button type="button" className="gui-session-info-retry" onClick={retry}>
							{t("sessionInfo.retry")}
						</button>
					</div>
				) : changesState === "ready" && hasChangesOf(changes) ? (
					<div className="gui-session-info-nums">
						<span className="gui-session-info-num-add">+{changes.added}</span>
						<span className="gui-session-info-num-del">−{changes.removed}</span>
					</div>
				) : (
					<p className="gui-session-info-note">{t("general.sessionInfoNoChanges")}</p>
				)}
			</section>

			<section className="gui-session-info-tabs">
				<div className="gui-session-info-section-label">{t("general.sessionInfoOpenTabs")}</div>
				{tabs.length === 0 ? (
					<p className="gui-session-info-note gui-session-info-tabs-empty">{t("general.sessionInfoNoTabs")}</p>
				) : (
					<ul className="gui-session-info-list">
						{visibleTabs.map(item => {
							const active = item.id === activeTabId;
							return (
								<li key={item.id}>
									<button
										type="button"
										className={`gui-session-info-item${active ? " gui-session-info-item--active" : ""}`}
										title={item.label}
										aria-current={active ? "true" : undefined}
										onClick={() => onSelectTab?.(item.id)}
									>
										<Icon name={surfaceIcon(item.surface)} className="gui-session-info-row-icon" />
										<span className="gui-session-info-item-label">{item.label}</span>
									</button>
								</li>
							);
						})}
					</ul>
				)}
				{foldedTabCount > 0 ? (
					<button type="button" className="gui-session-info-more" onClick={() => setShowAllTabs(true)}>
						{t("general.sessionInfoMore", { count: foldedTabCount })}
					</button>
				) : null}
			</section>

			<section className="gui-session-info-surfaces">
				<div className="gui-session-info-section-label">{t("general.sessionInfoSurfaces")}</div>
				<div className="gui-session-info-surface-grid">
					{surfaces.map(surface => (
						<button
							key={surface.id}
							type="button"
							className="gui-session-info-surface"
							title={t(surface.label as TranslationKey)}
							onClick={() => onOpenSurface?.(surface.id)}
						>
							<Icon name={surface.icon as IconName} className="gui-session-info-row-icon" />
							<span className="gui-session-info-surface-label">{t(surface.label as TranslationKey)}</span>
						</button>
					))}
				</div>
			</section>
		</aside>
	);
}

/** Tab icons come from the surface registry; extension tabs get a generic glyph. */
function surfaceIcon(surface: string): IconName {
	const descriptor = SURFACES.find(entry => entry.id === surface);
	return (descriptor?.icon ?? "stack") as IconName;
}
