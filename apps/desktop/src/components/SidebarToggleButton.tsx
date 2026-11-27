import { t } from "@musepi/client-core";
import { PanelLeftClose as PanelLeftCloseIconData, PanelLeftOpen as PanelLeftOpenIconData } from "lucide";
import { MorphIcon } from "morphicons/react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../vendor/oc-icons";
import { MenuPopup } from "./MenuPopup";

export interface SidebarQuickSession {
	id: string;
	label: string;
}

export function SidebarToggleButton({
	collapsed,
	onToggle,
	sessions,
	selectedId,
	onSelectSession,
	onNewSession,
}: {
	collapsed: boolean;
	onToggle(anchor: HTMLButtonElement): void;
	sessions: readonly SidebarQuickSession[];
	selectedId?: string | null;
	onSelectSession(id: string): void;
	onNewSession(): void;
}): ReactNode {
	const [open, setOpen] = useState(false);
	const anchorRef = useRef<HTMLButtonElement | null>(null);
	const timerRef = useRef<number | null>(null);
	const label = collapsed ? t("transcript.openSidebar") : t("transcript.closeSidebar");
	const cancelClose = (): void => {
		if (timerRef.current !== null) window.clearTimeout(timerRef.current);
		timerRef.current = null;
	};
	const close = (): void => {
		cancelClose();
		setOpen(false);
	};
	const closeSoon = (): void => {
		cancelClose();
		timerRef.current = window.setTimeout(() => setOpen(false), 140);
	};
	useEffect(() => {
		if (!collapsed) close();
		return cancelClose;
	}, [collapsed]);
	useEffect(() => {
		if (!open) return;
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopImmediatePropagation();
			close();
			anchorRef.current?.focus();
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, [open]);
	return (
		<>
			<button
				type="button"
				ref={anchorRef}
				className="gui-sidebar-toggle"
				data-collapsed={collapsed ? "true" : "false"}
				title={label}
				aria-label={label}
				aria-expanded={!collapsed}
				aria-controls="gui-sidebar-list-region"
				aria-haspopup={collapsed ? "menu" : undefined}
				onPointerEnter={() => {
					cancelClose();
					if (collapsed) setOpen(true);
				}}
				onPointerLeave={() => {
					if (collapsed) closeSoon();
				}}
				onClick={event => {
					close();
					onToggle(event.currentTarget);
				}}
			>
				<MorphIcon
					icon={collapsed ? PanelLeftOpenIconData : PanelLeftCloseIconData}
					size={16}
					spring="snappy"
					reducedMotion="user"
					className="h-4 w-4"
				/>
			</button>
			<MenuPopup
				open={open && collapsed}
				className="gui-session-quick-menu"
				anchor={anchorRef.current}
				align="left"
				onOpenChange={setOpen}
			>
				<section aria-label={t("general.sessions")} onPointerEnter={cancelClose} onPointerLeave={closeSoon}>
					<header className="gui-session-quick-head">
						<strong>{t("general.sessions")}</strong>
						<button
							type="button"
							className="gui-session-quick-new"
							onClick={() => {
								close();
								onNewSession();
							}}
						>
							<Icon name="add" className="h-3.5 w-3.5" />
							{t("settings.newTask")}
						</button>
					</header>
					<div className="gui-session-quick-list">
						{sessions.slice(0, 6).map(session => (
							<button
								type="button"
								key={session.id}
								data-session-id={session.id}
								className="gui-session-quick-row"
								data-active={session.id === selectedId ? "true" : undefined}
								onClick={() => {
									close();
									onSelectSession(session.id);
								}}
							>
								<span>{session.label}</span>
							</button>
						))}
					</div>
				</section>
			</MenuPopup>
		</>
	);
}
