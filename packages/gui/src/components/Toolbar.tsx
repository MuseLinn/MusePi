import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { Icon } from "../vendor/oc-icons";
import { AgentAvatar } from "./AgentAvatar";

/**
 * openchamber-style full-width window toolbar: rides the immersive top edge
 * across every state (welcome included) so pane toggles never leave the
 * window. Layout mirrors the reference app — left cluster (view/settings),
 * centered session title, right cluster (model picker, status, pane toggle).
 * The empty spans carry the drag region; interactive buttons opt out with
 * -webkit-app-region: no-drag.
 */
export function Toolbar({
	title,
	working,
	onToggleSidebar,
	onNewSession,
	onOpenSettings,
	onToggleContext,
	terminalOpen,
	onToggleTerminal,
}: {
	title: string;
	working: boolean;
	onToggleSidebar(): void;
	onNewSession(): void;
	onOpenSettings(): void;
	onToggleContext(): void;
	terminalOpen: boolean;
	onToggleTerminal(): void;
}): ReactNode {
	return (
		<header className="gui-toolbar">
			<div className="gui-toolbar-drag" aria-hidden="true" />
			{/* Left cluster: pane toggle, new session, settings (openchamber's
			 * view/generic buttons). */}
			<button
				type="button"
				className="gui-tool-btn"
				title={t("toggle sidebar")}
				aria-label={t("toggle sidebar")}
				onClick={onToggleSidebar}
			>
				<Icon name="menu-2" className="h-[18px] w-[18px]" />
			</button>
			<button
				type="button"
				className="gui-tool-btn"
				title={t("new task")}
				aria-label={t("new task")}
				onClick={onNewSession}
			>
				<Icon name="add-circle" className="h-[18px] w-[18px]" />
			</button>
			<button
				type="button"
				className="gui-tool-btn"
				title={t("settings")}
				aria-label={t("settings")}
				onClick={onOpenSettings}
			>
				<Icon name="settings-3" className="h-[18px] w-[18px]" />
			</button>
			{/* Centered session title (openchamber: title + username below). */}
			<div className="gui-toolbar-title">{title}</div>
			<div className="ml-auto flex items-center gap-1.5">
				{working && <AgentAvatar state="working" size={20} />}
				<button
					type="button"
					className={`gui-tool-btn${terminalOpen ? " gui-tool-btn--active" : ""}`}
					title={t("toggle terminal")}
					aria-label={t("toggle terminal")}
					onClick={onToggleTerminal}
				>
					<Icon name="terminal-box" className="h-[18px] w-[18px]" />
				</button>
				<button
					type="button"
					className="gui-tool-btn"
					title={t("toggle panel")}
					aria-label={t("toggle panel")}
					onClick={onToggleContext}
				>
					<Icon name="equalizer-2" className="h-[18px] w-[18px]" />
				</button>
			</div>
		</header>
	);
}
