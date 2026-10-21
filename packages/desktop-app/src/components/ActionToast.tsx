import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { dismissActionToast, getToasts, subscribeActionToasts } from "../lib/action-toast";
import { Icon } from "../vendor/oc-icons";

/**
 * The unified in-app toast stack: icon + message + one optional action,
 * bottom-right above the update toast's slot. Every transient notice —
 * undo offers, action feedback, routed `musepi-gui-toast` reports — lands
 * here so the app has ONE internal notification surface.
 */
export function ActionToastStack(): ReactNode {
	const toasts = useSyncExternalStore(subscribeActionToasts, getToasts);
	// Per-id timer ownership: a toast that is clicked and dismissed early must
	// not leave a timer that later removes a *different* toast's slot.
	const [, setTick] = useState(0);
	useEffect(() => {
		const timers = toasts.map(toast =>
			window.setTimeout(() => dismissActionToast(toast.id), Math.max(0, toast.expiresAt - Date.now())),
		);
		setTick(n => n + 1);
		return () => {
			for (const timer of timers) window.clearTimeout(timer);
		};
	}, [toasts]);

	if (toasts.length === 0) return null;
	return (
		<div className="gui-action-toasts" role="status" aria-live="polite">
			{toasts.map(toast => (
				<div key={toast.id} className={`gui-action-toast gui-action-toast--${toast.kind}`}>
					<Icon
						name={toast.kind === "success" ? "check" : toast.kind === "error" ? "error-warning" : "information"}
						className="gui-action-toast-icon"
					/>
					<span className="gui-action-toast-msg">{toast.message}</span>
					{toast.actionLabel && (
						<button
							type="button"
							className="gui-action-toast-btn"
							onClick={() => {
								toast.onAction?.();
								dismissActionToast(toast.id);
							}}
						>
							{toast.actionLabel}
						</button>
					)}
				</div>
			))}
		</div>
	);
}

/** i18n key for the archive confirmation body (shared by every archive site). */
export function archivedToastMessage(): string {
	return t("general.sessionArchived");
}
