import { ArrowLeft, CalendarClock, Folder, LayoutDashboard, LogOut, MessageSquare, PanelRight } from "lucide-react";
import type { ReactNode } from "react";
import { t, type TranslationKey } from "../../i18n/index.js";
import type { GuestSnapshot } from "../../lib/client";
import { fmtPercent, shortenPath } from "../../lib/format";
import { AccentToggle } from "./AccentToggle";
import { LanguageToggle } from "./LanguageToggle";
import { ThemeToggle } from "./ThemeToggle";

/** Guest side panels reachable from the header nav. */
export type GuestPanel = "board" | "scheduled" | "files";

export interface HeaderBarProps {
	snapshot: GuestSnapshot;
	subCount: number;
	railOpen: boolean;
	onToggleRail(): void;
	onLeave(): void;
	/** Workspace back button (shown while a session is focused). */
	onBack?(): void;
	/** Currently open guest panel; null = transcript. */
	activePanel: GuestPanel | null;
	onSelectPanel(panel: GuestPanel | null): void;
}

const PANEL_BUTTONS: ReadonlyArray<{ panel: GuestPanel; icon: ReactNode; title: TranslationKey }> = [
	{ panel: "board", icon: <LayoutDashboard size={14} />, title: "board" },
	{ panel: "scheduled", icon: <CalendarClock size={14} />, title: "scheduled tasks" },
	{ panel: "files", icon: <Folder size={14} />, title: "files" },
];

export function HeaderBar({
	snapshot,
	subCount,
	railOpen,
	onToggleRail,
	onLeave,
	onBack,
	activePanel,
	onSelectPanel,
}: HeaderBarProps): ReactNode {
	const { header, state, phase, readOnly } = snapshot;
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
				<span className="sh-title" title={title}>
					{title}
				</span>
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
				<ThemeToggle />
				<AccentToggle />
				<LanguageToggle />
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
		</header>
	);
}
