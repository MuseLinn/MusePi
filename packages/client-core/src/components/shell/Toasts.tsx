import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { t } from "../../i18n/index.js";
import {
	type ActionToast,
	dismissActionToast,
	getToasts,
	pauseActionToast,
	resumeActionToast,
	subscribeActionToasts,
} from "../../lib/action-toast";

function ToastItem({ toast }: { toast: ActionToast }): ReactNode {
	const isError = toast.kind === "error";

	return (
		<div
			className={`sh-toast sh-toast-${toast.kind}`}
			role={isError ? "alert" : undefined}
			aria-live={isError ? "assertive" : undefined}
			aria-atomic={isError ? "true" : undefined}
		>
			<span className="sh-toast-msg">{toast.message}</span>
			<button
				type="button"
				className="sh-toast-close"
				onClick={() => dismissActionToast(toast.id)}
				title={t("settings.dismiss")}
				aria-label={t("settings.dismiss")}
			>
				<X size={12} />
			</button>
		</div>
	);
}

/** Bottom-strip presentation of the shared in-app toast store (guest/mobile shell). */
export function Toasts(): ReactNode {
	const toasts = useSyncExternalStore(subscribeActionToasts, getToasts);
	const [hovered, setHovered] = useState(false);
	const [focused, setFocused] = useState(false);
	const paused = hovered || focused;

	useEffect(() => {
		if (!paused) return;
		for (const toast of toasts) {
			if (Number.isFinite(toast.expiresAt)) pauseActionToast(toast.id);
		}
	}, [paused, toasts]);

	useEffect(() => {
		if (paused) return;
		for (const toast of toasts) resumeActionToast(toast.id);
	}, [paused, toasts]);

	useEffect(() => {
		if (paused) return;
		const timers = toasts
			.filter(toast => Number.isFinite(toast.expiresAt))
			.map(toast =>
				window.setTimeout(() => dismissActionToast(toast.id), Math.max(0, toast.expiresAt - Date.now())),
			);
		return () => {
			for (const timer of timers) window.clearTimeout(timer);
		};
	}, [paused, toasts]);

	return (
		<div
			className="sh-toasts"
			role="status"
			aria-live="polite"
			aria-atomic="false"
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			onFocusCapture={() => setFocused(true)}
			onBlurCapture={event => {
				if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
				setFocused(false);
			}}
		>
			{toasts.map(toast => (
				<ToastItem key={toast.id} toast={toast} />
			))}
		</div>
	);
}
