import type { WorkspaceSessionInfo } from "@musepi/pi-wire";
import {
	ArrowLeft,
	AudioLines,
	CalendarClock,
	FolderGit2,
	LayoutDashboard,
	LogOut,
	MessageSquare,
	Package,
	PanelRight,
	Settings,
	SquarePen,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { type TranslationKey, t } from "../../i18n/index.js";
import { useBackLayer } from "../../lib/back-stack";
import { isMobileShell } from "../../lib/capacitor";
import type { SessionClient } from "../../lib/client";
import { fmtPercent, shortenPath } from "../../lib/format";
import { useShellLayout } from "../../lib/responsive-shell";
import { sessionTitleMorphId, useMorphTarget } from "../../lib/scene-morph";
import { useGuestSelector } from "../../lib/use-guest";
import { AccentToggle } from "./AccentToggle";
import { HostManager } from "./HostManager";
import { LanguageToggle } from "./LanguageToggle";
import { SessionsSheet } from "./SessionsSheet";
import { ThemeToggle } from "./ThemeToggle";

/** Guest side panels reachable from the header nav. */
export type GuestPanel = "board" | "scheduled" | "files" | "marketplace" | "workbench" | "voice" | "settings";

export interface HeaderBarProps {
	client: SessionClient;
	railOpen: boolean;
	onToggleRail(): void;
	onLeave(): void;
	/** Workspace back button (shown while a session is focused). */
	onBack?(): void;
	/** Currently open guest panel; null = transcript. */
	activePanel: GuestPanel | null;
	onSelectPanel(panel: GuestPanel | null): void;
	/** Current connection link (highlighted in the switcher). */
	currentLink: string;
	/** Jump to another saved connection. */
	onSwitchTo(link: string, name: string): void;
	/** Live sessions on this host; null = single-session/no workspace (no sheet). */
	sessions: readonly WorkspaceSessionInfo[] | null;
	/** Currently focused session (accent-highlighted in the sheet). */
	focusedSessionId: string | null;
	/** Focus a session from the switcher sheet. */
	onSelectSession(id: string): void;
	/** Return to an empty draft without creating a session until the first send. */
	onNewSession(): void;
}

const PANEL_BUTTONS: ReadonlyArray<{ panel: GuestPanel; icon: ReactNode; title: TranslationKey }> = [
	{ panel: "board", icon: <LayoutDashboard size={14} />, title: "settings.board" },
	{ panel: "scheduled", icon: <CalendarClock size={14} />, title: "settings.scheduledTasks" },
	{ panel: "files", icon: <FolderGit2 size={14} />, title: "tools.workspace" },
	{ panel: "marketplace", icon: <Package size={14} />, title: "guest.marketplace" },
	{ panel: "workbench", icon: <PanelRight size={14} />, title: "settings.workbench" },
	{ panel: "voice", icon: <AudioLines size={14} />, title: "settings.voice" },
];

/**
 * Settings is not a content panel, but it has to be reachable from every shell
 * shape: the settings page, the host manager and "disconnect" all live behind
 * it. It is normally reached through the sessions sheet footer, and a
 * single-session host (`sessions === null`) has no sheet at all — while the
 * compact header hides the theme, host and leave buttons. So: always in the
 * narrow panel menu, and in the wide toolbar only when there is no sheet to
 * reach it from.
 */
const SETTINGS_ENTRY: { panel: GuestPanel; icon: ReactNode; title: TranslationKey } = {
	panel: "settings",
	icon: <Settings size={14} />,
	title: "settings.settings",
};

/** Narrow menu = content panels + settings: on a phone it is the only door. */
const PANEL_MENU_BUTTONS = [...PANEL_BUTTONS, SETTINGS_ENTRY];

export function HeaderBar({
	client,
	railOpen,
	onToggleRail,
	onLeave,
	onBack,
	activePanel,
	onSelectPanel,
	currentLink,
	onSwitchTo,
	sessions,
	focusedSessionId,
	onSelectSession,
	onNewSession,
}: HeaderBarProps): ReactNode {
	// Field-level subscriptions: the header only re-renders when its own
	// fields change, never on every transcript/notice frame.
	const mobile = isMobileShell();
	const layout = useShellLayout();
	const narrow = layout !== "wide";
	const header = useGuestSelector(client, s => s.header);
	const state = useGuestSelector(client, s => s.state);
	const phase = useGuestSelector(client, s => s.phase);
	const readOnly = useGuestSelector(client, s => s.readOnly);
	const subCount = useGuestSelector(client, s => s.agents.filter(a => a.kind === "sub").length);
	const draftSession = mobile && sessions !== null && focusedSessionId === null;
	const title =
		activePanel === "settings"
			? t("settings.settings")
			: draftSession
				? t("settings.newSession")
				: (header?.title ?? state?.sessionName ?? t("settings.session2"));
	// Mobile 列表↔会话 morph target (M1.10 §3.3 批次 B): the title flies in
	// from the tapped workspace card's title (shared session-title id). The
	// id is absent on the directory view, where no counterpart exists. The
	// two hooks cover the button/span variants — exactly one renders, so
	// exactly one effect ever finds an element to fly.
	const titleMorphId = focusedSessionId != null ? sessionTitleMorphId(focusedSessionId) : null;
	const titleBtnMorphRef = useMorphTarget<HTMLButtonElement>(titleMorphId);
	const titleSpanMorphRef = useMorphTarget<HTMLSpanElement>(titleMorphId);
	const usage = state?.contextUsage;
	let pct: number | null = null;
	if (usage) {
		pct =
			usage.percent ??
			(usage.tokens != null && usage.contextWindow !== null && usage.contextWindow > 0
				? (usage.tokens / usage.contextWindow) * 100
				: null);
	}

	// Compact browser windows get the same reachable session/settings sheet as
	// native shells, including when the workspace has no sessions yet.
	const canSwitch = activePanel !== "settings" && sessions != null && (mobile || narrow || sessions.length > 0);
	const [sheetOpen, setSheetOpen] = useState(false);
	const [hostManagerOpen, setHostManagerOpen] = useState(false);
	const [panelMenuOpen, setPanelMenuOpen] = useState(false);
	// Android back key closes the collapsed panels menu before the layers
	// beneath (rail/panel/workspace) — priority 84, under the server
	// switcher 85, above the agents rail 80.
	useBackLayer(
		84,
		panelMenuOpen,
		useCallback(() => {
			setPanelMenuOpen(false);
			return true;
		}, []),
	);

	const togglePanel = (panel: GuestPanel): void => {
		onSelectPanel(activePanel === panel ? null : panel);
		setPanelMenuOpen(false);
	};

	return (
		<header className="sh-header">
			<div className="sh-header-left">
				{activePanel !== null && (
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={() => onSelectPanel(null)}
						title={t("guest.backChat")}
					>
						<MessageSquare size={14} />
					</button>
				)}
				{onBack && (
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={onBack}
						title={t("settings.backWorkspace")}
					>
						<ArrowLeft size={14} />
					</button>
				)}
				{canSwitch ? (
					<button
						type="button"
						ref={titleBtnMorphRef}
						data-morph-id={titleMorphId ?? undefined}
						className={`sh-title sh-title-btn${sheetOpen ? " sh-title--open" : ""}`}
						onClick={() => setSheetOpen(open => !open)}
						title={t("general.sessions")}
					>
						{title}
					</button>
				) : (
					<span
						ref={titleSpanMorphRef}
						className="sh-title"
						title={title}
						data-morph-id={titleMorphId ?? undefined}
					>
						{title}
					</span>
				)}
				{state?.cwd && (
					<span className="sh-cwd" title={state.cwd}>
						{shortenPath(state.cwd)}
					</span>
				)}
			</div>
			<div className="sh-header-right">
				{readOnly && (
					<span className="sh-chip" title={t("shell.readOnlyLinkWatching")}>
						{t("shell.readOnly")}
					</span>
				)}
				{state?.model && <span className="sh-chip sh-chip-meta">{state.model.name}</span>}
				{state?.thinkingLevel && <span className="sh-chip sh-chip-meta">{state.thinkingLevel}</span>}
				{pct != null && (
					<span
						className={pct > 80 ? "sh-gauge sh-gauge-warn" : "sh-gauge"}
						title={`${t("shell.contextWithPct", { pct: fmtPercent(pct) })}`}
					>
						<span className="sh-gauge-track">
							<span className="sh-gauge-fill" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
						</span>
						<span className="sh-gauge-pct">{fmtPercent(pct)}</span>
					</span>
				)}
				{state && state.participants.length > 0 && (
					<span className="sh-avatars">
						{state.participants.map((p, i) => (
							<span
								key={`${p.name}:${i}`}
								className={p.role === "host" ? "sh-avatar sh-avatar-host" : "sh-avatar"}
								title={`${p.name} · ${p.role}${p.readOnly ? ` · ${t("composer.viewOnly")}` : ""}`}
							>
								{(p.name[0] ?? "?").toUpperCase()}
							</span>
						))}
					</span>
				)}
				<span className={`sh-dot sh-dot-${phase}`} title={phase} />
				{narrow ? (
					<span className="sh-header-nav">
						<button
							type="button"
							className={activePanel !== null ? "sh-btn sh-btn-icon sh-btn-on" : "sh-btn sh-btn-icon"}
							onClick={() => setPanelMenuOpen(open => !open)}
							title={t("general.panels")}
						>
							<LayoutDashboard size={14} />
						</button>
						{panelMenuOpen &&
							createPortal(
								<>
									<div className="sh-switcher-overlay" onClick={() => setPanelMenuOpen(false)} />
									<div
										className="sh-switcher-pop sh-panel-menu-pop"
										role="menu"
										aria-label={t("general.panels")}
									>
										<div className="sh-switcher-title">{t("general.panels")}</div>
										{PANEL_MENU_BUTTONS.map(({ panel, icon, title }) => (
											<button
												key={panel}
												type="button"
												role="menuitem"
												className={
													activePanel === panel
														? "sh-switcher-item sh-panel-menu-item sh-switcher-item--cur"
														: "sh-switcher-item sh-panel-menu-item"
												}
												onClick={() => togglePanel(panel)}
											>
												{icon}
												<span>{t(title)}</span>
											</button>
										))}
									</div>
								</>,
								document.body,
							)}
					</span>
				) : (
					<span className="sh-header-nav">
						{PANEL_BUTTONS.map(({ panel, icon, title }) => (
							<button
								key={panel}
								type="button"
								className={activePanel === panel ? "sh-btn sh-btn-icon sh-btn-on" : "sh-btn sh-btn-icon"}
								onClick={() => onSelectPanel(activePanel === panel ? null : panel)}
								title={t(title)}
							>
								{icon}
							</button>
						))}
						{/* Wide toolbar: when there is no sessions sheet to reach
						 * settings from (single-session host), and on desktop web,
						 * whose sheet footer — the mobile-only navigation strip —
						 * does not render at all. */}
						{(sessions == null || !mobile) && (
							<button
								type="button"
								className={activePanel === "settings" ? "sh-btn sh-btn-icon sh-btn-on" : "sh-btn sh-btn-icon"}
								onClick={() => onSelectPanel(activePanel === "settings" ? null : "settings")}
								title={t("settings.settings")}
								aria-label={t("settings.settings")}
							>
								<Settings size={14} />
							</button>
						)}
					</span>
				)}
				{(mobile || narrow) &&
					sessions !== null &&
					activePanel === null &&
					(mobile || focusedSessionId !== null) && (
						<button
							type="button"
							className="sh-btn sh-btn-icon"
							onClick={onNewSession}
							title={t("settings.newSession")}
							aria-label={t("settings.newSession")}
						>
							<SquarePen size={16} />
						</button>
					)}
				{!mobile && !narrow && (
					<>
						<ThemeToggle />
						<AccentToggle />
						<LanguageToggle />
						<HostManager currentLink={currentLink} phase={phase} onSwitchTo={onSwitchTo} onLeave={onLeave} />
					</>
				)}
				<button
					type="button"
					className={railOpen ? "sh-btn sh-btn-icon sh-btn-on" : "sh-btn sh-btn-icon"}
					onClick={onToggleRail}
					title={railOpen ? t("shell.hideAgents") : t("shell.showAgents")}
				>
					<PanelRight size={14} />
					{subCount > 0 && <span className="sh-badge">{subCount}</span>}
				</button>
				{!mobile && !narrow && (
					<button type="button" className="sh-btn sh-btn-icon" onClick={onLeave} title={t("shell.leaveSession")}>
						<LogOut size={14} />
					</button>
				)}
			</div>
			{sessions != null && (
				<SessionsSheet
					client={client}
					sessions={sessions}
					currentId={focusedSessionId}
					onSelect={onSelectSession}
					open={sheetOpen}
					onClose={() => setSheetOpen(false)}
					onNewSession={() => {
						setSheetOpen(false);
						onNewSession();
					}}
					onOpenSettings={() => {
						setSheetOpen(false);
						onSelectPanel("settings");
					}}
					onOpenHosts={() => {
						setSheetOpen(false);
						setHostManagerOpen(true);
					}}
				/>
			)}
			{(mobile || narrow) && (
				<HostManager
					currentLink={currentLink}
					phase={phase}
					onSwitchTo={onSwitchTo}
					onLeave={onLeave}
					open={hostManagerOpen}
					onOpenChange={setHostManagerOpen}
					hideTrigger
				/>
			)}
		</header>
	);
}
