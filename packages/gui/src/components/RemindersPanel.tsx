import { relTime, t } from "@musepi/desktop-web";
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Icon } from "../vendor/oc-icons";

/** One row of the welcome-scene reminders (kimi 实时提醒 parity). */
export interface ReminderRow {
	id: string;
	title: string;
	/** Session updatedAt (epoch ms) — shown as relative time on unread rows. */
	timestamp: number;
	/** Live session with a running agent turn → 进行中 status. */
	working: boolean;
	/** Completed-but-unread session → bullet row. */
	unread: boolean;
	/** Session workspace (cwd basename) — shown as a project badge. */
	project?: string;
}

/** Persisted collapse preference: 1 = collapsed, 0 = expanded. */
const COLLAPSED_KEY = "musepi-gui-reminders-collapsed";

/** Row height budget (px): row padding 7+7 + 13px line ≈ 33 — keep a
 *  small headroom so the computed list height never clips a row. */
const ROW_H = 34;
/** List vertical padding (px): 2 top + 4 bottom in .gui-reminders-list. */
const LIST_PAD = 6;
/** Cap: beyond this many rows the list scrolls INSIDE the card, so the
 *  welcome composer is never pushed off-screen by unread growth. */
const MAX_LIST_H = 200;

function loadCollapsed(): boolean {
	try {
		return localStorage.getItem(COLLAPSED_KEY) === "1";
	} catch {
		return false;
	}
}

/**
 * Welcome-scene reminders (kimi 实时提醒 parity): below the empty-state
 * composer, background-working sessions (进行中) first, then completed-but-
 * unread ones. Click a row to open the session; 一键已读 clears the unread
 * markers. Renders nothing while there is nothing to remind about.
 *
 * The card is collapsible (header toggle, preference persisted) and the
 * list height tracks the row count — idle states occupy a single header
 * row or a few rows, busy states grow up to MAX_LIST_H and scroll inside
 * the card, so the empty-state composer never shifts.
 */
export function RemindersPanel({
	reminders,
	onSelect,
	onMarkAllRead,
}: {
	reminders: readonly ReminderRow[];
	onSelect(sessionId: string): void;
	onMarkAllRead(): void;
}): ReactNode {
	const [collapsed, setCollapsed] = useState(loadCollapsed);

	// Persist the preference (side effect outside the state updater).
	useEffect(() => {
		try {
			localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
		} catch {
			// storage unavailable
		}
	}, [collapsed]);

	const toggle = useCallback((): void => {
		setCollapsed(prev => !prev);
	}, []);

	if (reminders.length === 0) return null;
	const unreadCount = reminders.reduce((n, r) => n + (r.unread ? 1 : 0), 0);
	// Dynamic list height: content-scaled up to the cap (scrolls beyond),
	// driven through a CSS var so height transitions animate both ways.
	const listH = Math.min(reminders.length * ROW_H + LIST_PAD, MAX_LIST_H);
	return (
		<section className="gui-reminders" aria-label={t("real-time reminders")}>
			<div className="gui-reminders-head">
				<button
					type="button"
					className="gui-reminders-toggle"
					onClick={toggle}
					aria-expanded={!collapsed}
					title={collapsed ? t("expand reminders") : t("collapse reminders")}
				>
					<Icon name="arrow-down-s" className={`gui-reminders-chevron${collapsed ? " is-collapsed" : ""}`} />
					<span className="gui-reminders-title">{t("real-time reminders")}</span>
					{unreadCount > 0 && <span className="gui-reminders-count">{unreadCount}</span>}
				</button>
				{unreadCount > 0 && (
					<button type="button" className="gui-reminders-readall" onClick={onMarkAllRead}>
						{t("mark all read")}
					</button>
				)}
			</div>
			<div
				className="gui-reminders-list"
				data-collapsed={collapsed ? "" : undefined}
				style={{ "--list-h": `${listH}px` } as CSSProperties}
				aria-hidden={collapsed}
			>
				{reminders.map(r => (
					<button
						key={r.id}
						type="button"
						className={`gui-reminder-row${r.working ? " gui-reminder-row--working" : ""}`}
						title={r.title}
						onClick={() => onSelect(r.id)}
					>
						<span className="gui-reminder-bullet" aria-hidden />
						<span className="gui-reminder-title">{r.title}</span>
						{r.project && (
							<span className="gui-reminder-project" title={r.project}>
								<Icon name="folder" className="h-3 w-3" />
								<span>{r.project}</span>
							</span>
						)}
						{r.working ? (
							<span className="gui-reminder-status" aria-label={t("in progress")}>
								<span className="gui-reminder-dot" aria-hidden />
								{t("in progress")}
							</span>
						) : (
							<span className="gui-reminder-time">{relTime(r.timestamp)}</span>
						)}
					</button>
				))}
			</div>
		</section>
	);
}
