import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
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

/** Status glyph per kind — the only colour cue on an otherwise neutral card. */
const TOAST_ICON = {
	info: Info,
	success: CheckCircle2,
	warning: AlertTriangle,
	error: XCircle,
} as const;

function ToastItem({ toast }: { toast: ActionToast }): ReactNode {
	const isError = toast.kind === "error";
	const Glyph = TOAST_ICON[toast.kind];

	return (
		<div
			className={`sh-toast sh-toast-${toast.kind}`}
			role={isError ? "alert" : undefined}
			aria-live={isError ? "assertive" : undefined}
			aria-atomic={isError ? "true" : undefined}
		>
			<Glyph size={14} className="sh-toast-icon" aria-hidden />
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

/** Stable empty snapshot for the server render (and the first hydration pass). */
const EMPTY_TOASTS = [] as const;

/** Bottom-strip presentation of the shared in-app toast store (guest/mobile shell). */
export function Toasts(): ReactNode {
	const toasts = useSyncExternalStore(subscribeActionToasts, getToasts, () => EMPTY_TOASTS);
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
