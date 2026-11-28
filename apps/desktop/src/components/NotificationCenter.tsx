import { t, useLocale } from "@musepi/client-core";
import {
	clearNotificationHistory,
	listNotificationHistory,
	markAllNotificationHistoryRead,
	subscribeNotificationHistory,
	unreadNotificationHistoryCount,
} from "@musepi/client-core/src/lib/notification-history";
import type { ReactNode } from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "../vendor/oc-icons";
import { MenuPopup } from "./MenuPopup";

function relativeTime(createdAt: number, now: number, locale: string): string {
	const minutes = Math.max(0, Math.floor((now - createdAt) / 60_000));
	const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
	if (minutes < 1) return formatter.format(0, "second");
	if (minutes < 60) return formatter.format(-minutes, "minute");
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return formatter.format(-hours, "hour");
	return formatter.format(-Math.floor(hours / 24), "day");
}

export function NotificationCenter(): ReactNode {
	const locale = useLocale();
	const entries = useSyncExternalStore(subscribeNotificationHistory, listNotificationHistory);
	const unread = unreadNotificationHistoryCount();
	const [open, setOpen] = useState(false);
	const [now, setNow] = useState(() => Date.now());
	const anchorRef = useRef<HTMLButtonElement | null>(null);
	const label = unread > 0 ? t("shell.notificationsWithUnread", { count: unread }) : t("shell.notifications");

	useEffect(() => {
		if (!open) return;
		const timer = window.setInterval(() => setNow(Date.now()), 60_000);
		return () => window.clearInterval(timer);
	}, [open]);

	const toggleOpen = (): void => {
		if (!open) {
			setNow(Date.now());
			markAllNotificationHistoryRead();
		}
		setOpen(value => !value);
	};

	return (
		<>
			<button
				type="button"
				ref={anchorRef}
				className="gui-tool-btn gui-tool-btn--p2 gui-notification-trigger"
				title={label}
				aria-label={label}
				aria-expanded={open}
				aria-controls="gui-notification-center"
				onClick={toggleOpen}
			>
				<Icon name="notification-3" className="h-4 w-4" />
				{unread > 0 && (
					<span className="gui-notification-badge" aria-hidden="true">
						{unread > 99 ? "99+" : unread}
					</span>
				)}
			</button>
			<MenuPopup
				open={open}
				className="gui-notification-center"
				anchor={anchorRef.current}
				align="right"
				onOpenChange={setOpen}
			>
				<section id="gui-notification-center" aria-label={t("shell.notifications")}>
					<header className="gui-notification-head">
						<strong>{t("shell.notifications")}</strong>
						{entries.length > 0 && (
							<button type="button" className="gui-notification-clear" onClick={clearNotificationHistory}>
								{t("shell.clearAllNotifications")}
							</button>
						)}
					</header>
					{entries.length === 0 ? (
						<div className="gui-notification-empty">{t("shell.noNotifications")}</div>
					) : (
						<ul className="gui-notification-list">
							{entries.map(entry => (
								<li key={entry.id} className="gui-notification-row" data-kind={entry.kind}>
									<Icon
										name={
											entry.kind === "success"
												? "check"
												: entry.kind === "error"
													? "error-warning"
													: entry.kind === "warning"
														? "alert"
														: "information"
										}
										className="gui-notification-kind"
									/>
									<div className="gui-notification-copy">
										{entry.title && <div className="gui-notification-title">{entry.title}</div>}
										<div className="gui-notification-message">{entry.message}</div>
									</div>
									<time className="gui-notification-time" dateTime={new Date(entry.createdAt).toISOString()}>
										{relativeTime(entry.createdAt, now, locale)}
									</time>
								</li>
							))}
						</ul>
					)}
				</section>
			</MenuPopup>
		</>
	);
}
