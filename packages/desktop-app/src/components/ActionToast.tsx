import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import {
	type ActionToast,
	dismissActionToast,
	getToasts,
	pauseActionToast,
	resumeActionToast,
	subscribeActionToasts,
} from "../lib/action-toast";
import { Icon } from "../vendor/oc-icons";

function ActionToastItem({ toast }: { toast: ActionToast }): ReactNode {
	const interaction = useRef({ hover: false, focus: false });
	const resumeIfIdle = (): void => {
		if (!interaction.current.hover && !interaction.current.focus) resumeActionToast(toast.id);
	};
	const isError = toast.kind === "error";

	return (
		<div
			className={`gui-action-toast gui-action-toast--${toast.kind}`}
			role={isError ? "alert" : "status"}
			aria-live={isError ? "assertive" : "polite"}
			aria-atomic="true"
			onMouseEnter={() => {
				interaction.current.hover = true;
				pauseActionToast(toast.id);
			}}
			onMouseLeave={() => {
				interaction.current.hover = false;
				resumeIfIdle();
			}}
			onFocusCapture={() => {
				interaction.current.focus = true;
				pauseActionToast(toast.id);
			}}
			onBlurCapture={event => {
				if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
				interaction.current.focus = false;
				resumeIfIdle();
			}}
		>
			<Icon
				name={toast.kind === "success" ? "check" : isError ? "error-warning" : "information"}
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
			<button
				type="button"
				className="gui-action-toast-close gui-update-toast-close"
				onClick={() => dismissActionToast(toast.id)}
				title={t("settings.dismiss")}
				aria-label={t("settings.dismiss")}
			>
				<span aria-hidden="true">×</span>
			</button>
		</div>
	);
}

/** Unified bottom-right stack for local actions and application notices. */
export function ActionToastStack(): ReactNode {
	const toasts = useSyncExternalStore(subscribeActionToasts, getToasts);
	useEffect(() => {
		const timers = toasts
			.filter(toast => Number.isFinite(toast.expiresAt))
			.map(toast =>
				window.setTimeout(() => dismissActionToast(toast.id), Math.max(0, toast.expiresAt - Date.now())),
			);
		return () => {
			for (const timer of timers) window.clearTimeout(timer);
		};
	}, [toasts]);

	if (toasts.length === 0) return null;
	return (
		<div className="gui-action-toasts">
			{toasts.map(toast => (
				<ActionToastItem key={toast.id} toast={toast} />
			))}
		</div>
	);
}

/** i18n key for the archive confirmation body (shared by every archive site). */
export function archivedToastMessage(): string {
	return t("general.sessionArchived");
}
