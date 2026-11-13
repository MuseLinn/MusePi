import { useState } from "react";
import { t } from "../../i18n/index.js";

export interface LongPasteEditorProps {
	lineCount: number;
	charCount: number;
	text: string;
	onSave(text: string): void;
	onDismiss(): void;
}

/** Collapsed-paste editor: view and edit the full text behind a chip. */
export function LongPasteDialog({ lineCount, charCount, text, onSave, onDismiss }: LongPasteEditorProps) {
	const [draft, setDraft] = useState(text);
	const [dismissing, setDismissing] = useState(false);
	const changed = draft !== text;

	const dismiss = (): void => {
		if (changed && !window.confirm(t("composer.pastedTextDiscardMessage"))) return;
		setDismissing(true);
		onDismiss();
	};

	return (
		<div className="gui-long-paste-dialog" data-dismissing={dismissing ? "" : undefined}>
			<div className="gui-long-paste-header">
				<div className="gui-long-paste-summary">
					{t("composer.pastedTextTitle")} ·{" "}
					{t("composer.pastedLinesWithLinesWithChars", { lines: lineCount, chars: charCount })}
				</div>
				<button
					type="button"
					className="gui-long-paste-close"
					onClick={dismiss}
					aria-label={t("composer.discardPaste")}
				>
					✕
				</button>
			</div>
			<textarea
				className="gui-long-paste-editor"
				value={draft}
				rows={Math.min(24, Math.max(6, lineCount))}
				onChange={e => setDraft(e.target.value)}
				aria-label={t("composer.pastedTextTitle")}
			/>
			<div className="gui-long-paste-actions">
				<button
					type="button"
					className="gui-long-paste-btn gui-long-paste-btn--primary"
					onClick={() => onSave(draft)}
				>
					{t("composer.pastedTextSave")}
				</button>
				<button type="button" className="gui-long-paste-btn" onClick={dismiss}>
					{t("composer.pastedTextDiscard")}
				</button>
			</div>
		</div>
	);
}
