import type { WorkspaceSessionInfo } from "@musepi/pi-wire";
import { ArrowLeft, CalendarClock, Folder, LayoutDashboard, LogOut, MessageSquare, PanelRight } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { type TranslationKey, t } from "../../i18n/index.js";
import { useBackLayer } from "../../lib/back-stack";
import type { SessionClient } from "../../lib/client";
import { fmtPercent, shortenPath } from "../../lib/format";
import { useGuestSelector } from "../../lib/use-guest";
import { AccentToggle } from "./AccentToggle";
import { LanguageToggle } from "./LanguageToggle";
import { ServerSwitcher } from "./ServerSwitcher";
import { SessionsSheet } from "./SessionsSheet";
import { ThemeToggle } from "./ThemeToggle";

/** Guest side panels reachable from the header nav. */
export type GuestPanel = "board" | "scheduled" | "files" | "workbench";

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
}

const PANEL_BUTTONS: ReadonlyArray<{ panel: GuestPanel; icon: ReactNode; title: TranslationKey }> = [
	{ panel: "board", icon: <LayoutDashboard size={14} />, title: "board" },
	{ panel: "scheduled", icon: <CalendarClock size={14} />, title: "scheduled tasks" },
	{ panel: "files", icon: <Folder size={14} />, title: "files" },
	{ panel: "workbench", icon: <PanelRight size={14} />, title: "workbench" },
];

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
}: HeaderBarProps): ReactNode {
	// Field-level subscriptions: the header only re-renders when its own
	// fields change, never on every transcript/notice frame.
	const header = useGuestSelector(client, s => s.header);
	const state = useGuestSelector(client, s => s.state);
	const phase = useGuestSelector(client, s => s.phase);
	const readOnly = useGuestSelector(client, s => s.readOnly);
	const subCount = useGuestSelector(client, s => s.agents.filter(a => a.kind === "sub").length);
	const title = header?.title ?? state?.sessionName ?? t("session");
	const usage = state?.contextUsage;
	let pct: number | null = null;
	if (usage) {
		pct =
			usage.percent ??
			(usage.tokens != null && usage.contextWindow !== null && usage.contextWindow > 0
				? (usage.tokens / usage.contextWindow) * 100
				: null);
	}

	// The session switcher sheet is only reachable on multi-session hosts.
	const canSwitch = sessions != null && sessions.length > 0;
	const [sheetOpen, setSheetOpen] = useState(false);

	// Narrow phones: 4 panel buttons + theme + server + rail + leave overflow
	// a 390px header. Collapse the panel buttons into one "panels" menu
	// (design doc §4.3: panels are core entries, kept — but folded).
	const [narrow, setNarrow] = useState(() => {
		if (typeof window === "undefined" || !window.matchMedia) return false;
		return window.matchMedia("(max-width: 520px)").matches;
	});
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
	useEffect(() => {
		if (typeof window === "undefined" || !window.matchMedia) return;
		const mq = window.matchMedia("(max-width: 520px)");
		const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches);
		setNarrow(mq.matches);
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, []);

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
						title={t("back to chat")}
					>
						<MessageSquare size={14} />
					</button>
				)}
				{onBack && (
					<button type="button" className="sh-btn sh-btn-icon" onClick={onBack} title={t("back to workspace")}>
						<ArrowLeft size={14} />
					</button>
				)}
				{canSwitch ? (
					<button
						type="button"
						className={`sh-title sh-title-btn${sheetOpen ? " sh-title--open" : ""}`}
						onClick={() => setSheetOpen(open => !open)}
						title={t("sessions")}
					>
						{title}
					</button>
				) : (
					<span className="sh-title" title={title}>
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
					<span className="sh-chip" title={t("read-only link — watching only")}>
						{t("read-only")}
					</span>
				)}
				{state?.model && <span className="sh-chip sh-chip-meta">{state.model.name}</span>}
				{state?.thinkingLevel && <span className="sh-chip sh-chip-meta">{state.thinkingLevel}</span>}
				{pct != null && (
					<span
						className={pct > 80 ? "sh-gauge sh-gauge-warn" : "sh-gauge"}
						title={`${t("context · {pct}", { pct: fmtPercent(pct) })}`}
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
								title={`${p.name} · ${p.role}${p.readOnly ? ` · ${t("view-only")}` : ""}`}
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
							title={t("panels")}
						>
							<LayoutDashboard size={14} />
						</button>
						{panelMenuOpen && (
							<>
								<div className="sh-switcher-overlay" onClick={() => setPanelMenuOpen(false)} />
								<div className="sh-switcher-pop sh-panel-menu-pop" role="menu" aria-label={t("panels")}>
									<div className="sh-switcher-title">{t("panels")}</div>
									{PANEL_BUTTONS.map(({ panel, icon, title }) => (
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
							</>
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
					</span>
				)}
				<ThemeToggle />
				<AccentToggle />
				<LanguageToggle />
				<ServerSwitcher currentLink={currentLink} onSwitchTo={onSwitchTo} />
				<button
					type="button"
					className={railOpen ? "sh-btn sh-btn-icon sh-btn-on" : "sh-btn sh-btn-icon"}
					onClick={onToggleRail}
					title={railOpen ? t("hide agents") : t("show agents")}
				>
					<PanelRight size={14} />
					{subCount > 0 && <span className="sh-badge">{subCount}</span>}
				</button>
				<button type="button" className="sh-btn sh-btn-icon" onClick={onLeave} title={t("leave session")}>
					<LogOut size={14} />
				</button>
			</div>
			{sessions != null && (
				<SessionsSheet
					sessions={sessions}
					currentId={focusedSessionId}
					onSelect={onSelectSession}
					open={sheetOpen}
					onClose={() => setSheetOpen(false)}
				/>
			)}
		</header>
	);
}
