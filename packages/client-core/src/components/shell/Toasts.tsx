import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../i18n/index.js";
import type { Notice, SessionClient } from "../../lib/client";
import { useGuestSelector } from "../../lib/use-guest";

const INFO_TTL_MS = 4000;
const WARNING_TTL_MS = 8000;
const MAX_VISIBLE = 4;

function ToastItem({ notice, onDismiss }: { notice: Notice; onDismiss(id: number): void }): ReactNode {
	const [expiresAt, setExpiresAt] = useState(
		() => notice.at + (notice.level === "info" ? INFO_TTL_MS : WARNING_TTL_MS),
	);
	const [paused, setPaused] = useState(false);
	const pausedRef = useRef(false);
	const remaining = useRef(0);
	const interaction = useRef({ hover: false, focus: false });
	const isError = notice.level === "error";

	useEffect(() => {
		if (paused || isError) return;
		const timer = window.setTimeout(() => onDismiss(notice.id), Math.max(0, expiresAt - Date.now()));
		return () => window.clearTimeout(timer);
	}, [expiresAt, isError, notice.id, onDismiss, paused]);

	const pause = (): void => {
		if (pausedRef.current) return;
		pausedRef.current = true;
		remaining.current = Math.max(0, expiresAt - Date.now());
		setPaused(true);
	};
	const resumeIfIdle = (): void => {
		if (interaction.current.hover || interaction.current.focus || !pausedRef.current) return;
		pausedRef.current = false;
		setExpiresAt(Date.now() + remaining.current);
		setPaused(false);
	};

	return (
		<div
			className={`sh-toast sh-toast-${notice.level}`}
			role={isError ? "alert" : "status"}
			aria-live={isError ? "assertive" : "polite"}
			aria-atomic="true"
			onMouseEnter={() => {
				interaction.current.hover = true;
				pause();
			}}
			onMouseLeave={() => {
				interaction.current.hover = false;
				resumeIfIdle();
			}}
			onFocusCapture={() => {
				interaction.current.focus = true;
				pause();
			}}
			onBlurCapture={event => {
				if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
				interaction.current.focus = false;
				resumeIfIdle();
			}}
		>
			<span className="sh-toast-msg">{notice.message}</span>
			<button
				type="button"
				className="sh-toast-close"
				onClick={() => onDismiss(notice.id)}
				title={t("settings.dismiss")}
				aria-label={t("settings.dismiss")}
			>
				<X size={12} />
			</button>
		</div>
	);
}

export function Toasts({ client }: { client: SessionClient }): ReactNode {
	const notices = useGuestSelector(client, s => s.notices);
	const [dismissed, setDismissed] = useState<Set<number>>(() => new Set());
	const close = useCallback((id: number): void => {
		setDismissed(prev => {
			if (prev.has(id)) return prev;
			const next = new Set(prev);
			next.add(id);
			return next;
		});
	}, []);

	const visible = notices.filter(n => !dismissed.has(n.id)).slice(-MAX_VISIBLE);
	if (visible.length === 0) return null;

	return (
		<div className="sh-toasts">
			{visible.map(n => (
				<ToastItem key={n.id} notice={n} onDismiss={close} />
			))}
		</div>
	);
}
