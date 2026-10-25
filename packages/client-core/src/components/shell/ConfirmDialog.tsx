import type { ReactNode } from "react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { t } from "../../i18n/index.js";
import { isTopModal, useModalFocus } from "../../lib/modal-focus";

export function ConfirmDialog({
	open,
	title,
	confirmLabel,
	busy = false,
	destructive = false,
	error = null,
	onConfirm,
	onClose,
}: {
	open: boolean;
	title: string;
	confirmLabel?: string;
	busy?: boolean;
	destructive?: boolean;
	error?: string | null;
	onConfirm(): void;
	onClose(): void;
}): ReactNode {
	const dialogRef = useModalFocus<HTMLDivElement>(open);

	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent): void => {
			const dialog = dialogRef.current;
			if (!dialog || !isTopModal(dialog)) return;
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				if (!busy) onClose();
			} else if (event.key === "Enter") {
				event.preventDefault();
				event.stopPropagation();
				if (!busy && !destructive) onConfirm();
			}
		};
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	}, [open, busy, destructive, onConfirm, onClose, dialogRef]);

	if (!open) return null;
	return createPortal(
		<div className="ss-backdrop" onClick={busy ? undefined : onClose}>
			<div
				ref={dialogRef}
				className="ss-card ss-card--confirm"
				role="dialog"
				aria-modal="true"
				aria-label={title}
				aria-busy={busy}
				onClick={event => event.stopPropagation()}
			>
				<div className="ss-card-head">
					<h2 className="ss-card-title">{title}</h2>
				</div>
				{error !== null && (
					<p className="sh-panel-error" role="alert">
						{error}
					</p>
				)}
				<div className="sh-files-actions">
					<button type="button" className="sh-btn" disabled={busy} onClick={onClose}>
						{t("settings.cancel")}
					</button>
					<button type="button" className="sh-btn" disabled={busy} onClick={onConfirm}>
						{confirmLabel ?? t("settings.confirm")}
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
