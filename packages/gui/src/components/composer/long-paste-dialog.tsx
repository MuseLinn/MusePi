import { useState } from "react";
import { t } from "../../i18n/index.js";

export type LongPasteAction = "inline" | "code-block" | "file";

/**
 * Dialog for gating a large text paste behind a user-choice menu.
 * Shows line count summary and three action buttons.
 */
export function LongPasteDialog({
	lineCount,
	charCount,
	onAction,
	onDismiss,
}: {
	lineCount: number;
	charCount: number;
	onAction(action: LongPasteAction): void;
	onDismiss(): void;
}) {
	const [dismissing, setDismissing] = useState(false);

	const handleAction = (action: LongPasteAction) => {
		setDismissing(true);
		onAction(action);
	};

	return (
		<div className="gui-long-paste-dialog" data-dismissing={dismissing ? "" : undefined}>
			<div className="gui-long-paste-header">
				<div className="gui-long-paste-summary">
					{t("Pasted {lines} lines ({chars} chars)", { lines: lineCount, chars: charCount })}
				</div>
				<button
					type="button"
					className="gui-long-paste-close"
					onClick={() => {
						setDismissing(true);
						onDismiss();
					}}
					aria-label={t("discard paste")}
				>
					✕
				</button>
			</div>
			<div className="gui-long-paste-actions">
				<button type="button" className="gui-long-paste-btn" onClick={() => handleAction("inline")}>
					{t("paste inline")}
				</button>
				<button type="button" className="gui-long-paste-btn" onClick={() => handleAction("code-block")}>
					{t("wrap as code block")}
				</button>
				<button type="button" className="gui-long-paste-btn" onClick={() => handleAction("file")}>
					{t("attach as file")}
				</button>
			</div>
		</div>
	);
}