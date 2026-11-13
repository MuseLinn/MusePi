import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
	type ActionToast,
	dismissActionToast,
	getToasts,
	pauseActionToast,
	resumeActionToast,
	setActionToastTtl,
	subscribeActionToasts,
	ttlFor,
} from "../lib/action-toast";
import { Icon } from "../vendor/oc-icons";

/** Matches the exit keyframe; the row stays mounted for this long. */
const EXIT_MS = 180;

function ActionToastItem({
	toast,
	closing,
	front,
	paused,
	onDismiss,
}: {
	toast: ActionToast;
	closing: boolean;
	front: boolean;
	paused: boolean;
	onDismiss(toast: ActionToast): void;
}): ReactNode {
	const isError = toast.kind === "error";
	const className = [
		"gui-action-toast",
		`gui-action-toast--${toast.kind}`,
		front ? "gui-action-toast--front" : "",
		closing ? "gui-action-toast--closing" : "",
	]
		.filter(Boolean)
		.join(" ");

	return (
		<div
			className={className}
			role={isError ? "alert" : undefined}
			aria-live={isError ? "assertive" : undefined}
			aria-atomic={isError ? "true" : undefined}
			data-paused={paused ? "true" : undefined}
		>
			<Icon
				name={
					toast.kind === "success"
						? "check"
						: isError
							? "error-warning"
							: toast.kind === "warning"
								? "alert"
								: "information"
				}
				className="gui-action-toast-icon"
			/>
			<div className="gui-action-toast-content">
				{toast.title && <div className="gui-action-toast-title">{toast.title}</div>}
				<div className="gui-action-toast-msg">{toast.message}</div>
				{toast.details && <div className="gui-action-toast-details">{toast.details}</div>}
			</div>
			{toast.cancelLabel && (
				<button
					type="button"
					className="gui-action-toast-cancel"
					onClick={() => {
						toast.onCancel?.();
						onDismiss(toast);
					}}
				>
					{toast.cancelLabel}
				</button>
			)}
			{toast.actionLabel && (
				<button
					type="button"
					className="gui-action-toast-btn"
					onClick={() => {
						toast.onAction?.();
						onDismiss(toast);
					}}
				>
					{toast.actionLabel}
				</button>
			)}
			<button
				type="button"
				className="gui-action-toast-close gui-update-toast-close"
				onClick={() => onDismiss(toast)}
				title={t("settings.dismiss")}
				aria-label={t("settings.dismiss")}
			>
				{!isError && (
					<svg
						className="gui-toast-ring"
						viewBox="0 0 24 24"
						aria-hidden="true"
						style={{ animationDuration: `${ttlFor(toast.kind)}ms` }}
					>
						<circle
							cx="12"
							cy="12"
							r="10.5"
							pathLength="100"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
						/>
					</svg>
				)}
				<span aria-hidden="true">×</span>
			</button>
		</div>
	);
}

/** Unified bottom-right stack for local actions and application notices. */
export function ActionToastStack(): ReactNode {
	const toasts = useSyncExternalStore(subscribeActionToasts, getToasts);
	const [hovered, setHovered] = useState(false);
	const [focused, setFocused] = useState(false);
	const [leaving, setLeaving] = useState<readonly ActionToast[]>([]);
	const exitTimers = useRef(new Set<number>());
	const paused = hovered || focused;

	const dismiss = useCallback((toast: ActionToast): void => {
		setLeaving(previous => (previous.some(item => item.id === toast.id) ? previous : [...previous, toast]));
		dismissActionToast(toast.id);
		const timer = window.setTimeout(() => {
			exitTimers.current.delete(timer);
			setLeaving(previous => previous.filter(item => item.id !== toast.id));
		}, EXIT_MS);
		exitTimers.current.add(timer);
	}, []);

	useEffect(() => {
		return () => {
			for (const timer of exitTimers.current) window.clearTimeout(timer);
			exitTimers.current.clear();
		};
	}, []);

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
			.map(toast => window.setTimeout(() => dismiss(toast), Math.max(0, toast.expiresAt - Date.now())));
		return () => {
			for (const timer of timers) window.clearTimeout(timer);
		};
	}, [dismiss, paused, toasts]);

	// A toast created while unfocused stays until the user returns, then gets
	// a short dismissal window instead of expiring before it is ever seen.
	useEffect(() => {
		const onFocus = (): void => {
			for (const toast of getToasts()) {
				if (toast.dedupeKey?.startsWith("notify:") && toast.expiresAt === Number.POSITIVE_INFINITY) {
					setActionToastTtl(toast.id, 8000);
				}
			}
		};
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [toasts]);

	const frontId = toasts.at(-1)?.id;
	const activeIds = new Set(toasts.map(toast => toast.id));
	const keyOf = (toast: ActionToast): string => toast.dedupeKey ?? `message:${toast.message}`;
	const activeKeys = new Set(toasts.map(keyOf));
	const closingByKey = new Map<string, ActionToast>();
	for (const toast of leaving) {
		const key = keyOf(toast);
		if (activeKeys.has(key)) continue;
		const previous = closingByKey.get(key);
		if (!previous || previous.id < toast.id) closingByKey.set(key, toast);
	}
	const rows = [...toasts, ...closingByKey.values()].sort((a, b) => a.id - b.id);
	const isExpanded = paused || toasts.length <= 1;

	return (
		<div
			className="gui-action-toasts"
			role="status"
			aria-live="polite"
			aria-atomic="false"
			data-expanded={isExpanded ? "true" : "false"}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			onFocusCapture={() => setFocused(true)}
			onBlurCapture={event => {
				if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
				setFocused(false);
			}}
		>
			{rows.map(toast => (
				<ActionToastItem
					key={toast.id}
					toast={toast}
					closing={!activeIds.has(toast.id)}
					front={toast.id === frontId}
					paused={paused}
					onDismiss={dismiss}
				/>
			))}
		</div>
	);
}

/** i18n key for the archive confirmation body (shared by every archive site). */
export function archivedToastMessage(): string {
	return t("general.sessionArchived");
}
