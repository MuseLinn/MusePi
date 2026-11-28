import { t } from "@musepi/client-core";
import { PanelLeftClose as PanelLeftCloseIconData, PanelLeftOpen as PanelLeftOpenIconData } from "lucide";
import { MorphIcon } from "morphicons/react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
	type CapabilityTab,
	emitCapabilityNavAction,
	readCapabilityNav,
	subscribeCapabilityNav,
} from "../lib/capability-nav";
import type { SidebarPanelId } from "../lib/rail-peek";
import { emitTaskNavAction, readTaskNav, subscribeTaskNav } from "../lib/scheduled-task-nav";
import { Icon } from "../vendor/oc-icons";
import { MenuPopup } from "./MenuPopup";

export interface SidebarQuickSession {
	id: string;
	label: string;
}

export function SidebarToggleButton({
	collapsed,
	panelId,
	onToggle,
	sessions,
	selectedId,
	onSelectSession,
	onNewSession,
}: {
	collapsed: boolean;
	panelId: SidebarPanelId;
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
				{panelId === "home" ? (
					<SessionQuickMenu
						sessions={sessions}
						selectedId={selectedId}
						onSelectSession={onSelectSession}
						onNewSession={onNewSession}
						close={close}
						cancelClose={cancelClose}
						closeSoon={closeSoon}
					/>
				) : panelId === "scheduled" ? (
					<ScheduledQuickMenu close={close} cancelClose={cancelClose} closeSoon={closeSoon} />
				) : (
					<CapabilityQuickMenu close={close} cancelClose={cancelClose} closeSoon={closeSoon} />
				)}
			</MenuPopup>
		</>
	);
}

interface QuickMenuBehavior {
	close(): void;
	cancelClose(): void;
	closeSoon(): void;
}

function QuickMenuFrame({
	title,
	actionLabel,
	onAction,
	actionDisabled = false,
	children,
	close,
	cancelClose,
	closeSoon,
}: QuickMenuBehavior & {
	title: string;
	actionLabel: string;
	onAction(): void;
	actionDisabled?: boolean;
	children: ReactNode;
}): ReactNode {
	return (
		<section aria-label={title} onPointerEnter={cancelClose} onPointerLeave={closeSoon}>
			<header className="gui-session-quick-head">
				<strong>{title}</strong>
				<button
					type="button"
					className="gui-session-quick-new"
					disabled={actionDisabled}
					onClick={() => {
						close();
						onAction();
					}}
				>
					<Icon name="add" className="h-3.5 w-3.5" />
					{actionLabel}
				</button>
			</header>
			<div className="gui-session-quick-list">{children}</div>
		</section>
	);
}

function SessionQuickMenu({
	sessions,
	selectedId,
	onSelectSession,
	onNewSession,
	...behavior
}: QuickMenuBehavior & {
	sessions: readonly SidebarQuickSession[];
	selectedId?: string | null;
	onSelectSession(id: string): void;
	onNewSession(): void;
}): ReactNode {
	return (
		<QuickMenuFrame
			{...behavior}
			title={t("general.sessions")}
			actionLabel={t("settings.newTask")}
			onAction={onNewSession}
		>
			{sessions.slice(0, 6).map(session => (
				<button
					type="button"
					key={session.id}
					data-session-id={session.id}
					className="gui-session-quick-row"
					data-active={session.id === selectedId ? "true" : undefined}
					onClick={() => {
						behavior.close();
						onSelectSession(session.id);
					}}
				>
					<span>{session.label}</span>
				</button>
			))}
		</QuickMenuFrame>
	);
}

function ScheduledQuickMenu(behavior: QuickMenuBehavior): ReactNode {
	const nav = useSyncExternalStore(subscribeTaskNav, readTaskNav, readTaskNav);
	return (
		<QuickMenuFrame
			{...behavior}
			title={t("settings.scheduledTasks")}
			actionLabel={t("settings.scheduledNew")}
			actionDisabled={nav.busy}
			onAction={() => emitTaskNavAction({ type: "new" })}
		>
			{nav.tasks.slice(0, 6).map(task => (
				<button
					type="button"
					key={task.id}
					data-task-id={task.id}
					className="gui-session-quick-row"
					data-active={task.id === nav.selectedId ? "true" : undefined}
					onClick={() => {
						behavior.close();
						emitTaskNavAction({ type: "select", id: task.id });
					}}
				>
					<span>{task.name || t("settings.scheduledUntitled")}</span>
				</button>
			))}
		</QuickMenuFrame>
	);
}

function CapabilityQuickMenu(behavior: QuickMenuBehavior): ReactNode {
	const nav = useSyncExternalStore(subscribeCapabilityNav, readCapabilityNav, readCapabilityNav);
	const entries: { id: CapabilityTab; label: string }[] = [
		{ id: "skills", label: t("tools.skillsTab") },
		{ id: "plugins", label: t("settings.plugins") },
		{ id: "marketplace", label: t("guest.marketplace") },
	];
	return (
		<QuickMenuFrame
			{...behavior}
			title={t("tools.capabilityCenter")}
			actionLabel={t("tools.capabilityPanelAdd")}
			onAction={() => emitCapabilityNavAction({ type: "add" })}
		>
			{entries.map(entry => (
				<button
					type="button"
					key={entry.id}
					data-capability-tab={entry.id}
					className="gui-session-quick-row"
					data-active={entry.id === nav.tab ? "true" : undefined}
					onClick={() => {
						behavior.close();
						emitCapabilityNavAction({ type: "select", tab: entry.id });
					}}
				>
					<span>{entry.label}</span>
				</button>
			))}
		</QuickMenuFrame>
	);
}
