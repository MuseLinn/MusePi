/**
 * Turn "本轮修改文件" card: the files a turn wrote, with per-file line counts
 * and a cap on how many rows stay visible.
 *
 * The card is not a diff viewer — a file whose tool result carried no diff
 * (a plain write) says so instead of pretending the change has no lines.
 */
import { FileDiff, FileText } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useState } from "react";
import { t } from "../../i18n/index.js";
import { openFileInPanel } from "./FileCards";
import { fileBaseName, type TurnFileChange, turnFileTotals } from "./turn-files.js";

/** Rows shown before "还有 N 个文件". */
export const TURN_FILES_VISIBLE = 5;

export const TurnFilesCard = memo(function TurnFilesCard({
	files,
	pending = false,
	onOpenFile,
}: {
	files: readonly TurnFileChange[];
	/** The turn's changes are still being collected — render the loading line. */
	pending?: boolean;
	/** Open a file in the right panel. Absent → the open action is disabled. */
	onOpenFile?: (path: string) => void;
}): ReactNode {
	const [expanded, setExpanded] = useState(false);
	if (files.length === 0 && !pending) return null;
	const totals = turnFileTotals(files);
	const shown = expanded ? files : files.slice(0, TURN_FILES_VISIBLE);
	const hidden = files.length - shown.length;
	// No window → no right-panel preview host (guest/export), so the action is
	// disabled rather than dispatching an event nothing listens to.
	const open = onOpenFile ?? (typeof window === "undefined" ? undefined : openFileInPanel);
	const title =
		files.length === 1
			? t("transcript.turnFilesTitleOne", { count: "1" })
			: t("transcript.turnFilesTitleWithCount", { count: String(files.length) });
	return (
		<div className="tr-turn-files">
			{files.length > 0 && (
				<div className="tr-turn-files-head">
					<FileDiff size={12} className="tr-turn-files-icon" aria-hidden="true" />
					<span className="tr-turn-files-title">{title}</span>
					{totals.added > 0 && <span className="tr-turn-files-add">+{totals.added}</span>}
					{totals.removed > 0 && <span className="tr-turn-files-remove">−{totals.removed}</span>}
				</div>
			)}
			{shown.map(file => (
				<div className="tr-turn-file" key={file.path}>
					<FileText size={12} className="tr-turn-file-icon" aria-hidden="true" />
					<span className="tr-turn-file-name" title={file.path}>
						{fileBaseName(file.path)}
					</span>
					<span className="tr-turn-file-path" title={file.path}>
						{file.path}
					</span>
					{file.hasDiff ? (
						<span className="tr-turn-file-stats">
							<span className="tr-turn-files-add">+{file.added}</span>
							<span className="tr-turn-files-remove">−{file.removed}</span>
						</span>
					) : (
						<span className="tr-turn-file-nodiff">{t("transcript.turnFilesDiffUnavailable")}</span>
					)}
					<button
						type="button"
						className="tr-turn-file-open"
						disabled={open === undefined}
						onClick={() => open?.(file.path)}
					>
						{t("transcript.turnFilesOpenFile")}
					</button>
				</div>
			))}
			{hidden > 0 && (
				<button type="button" className="tr-turn-files-more" onClick={() => setExpanded(true)}>
					{hidden === 1
						? t("transcript.turnFilesMoreOne")
						: t("transcript.turnFilesMoreWithCount", { count: String(hidden) })}
				</button>
			)}
			{expanded && files.length > TURN_FILES_VISIBLE && (
				<button type="button" className="tr-turn-files-more" onClick={() => setExpanded(false)}>
					{t("transcript.turnFilesShowLess")}
				</button>
			)}
			{pending && (
				<div className="tr-turn-files-pending" role="status">
					<span className="tr-working-spin" aria-hidden="true" />
					{t("transcript.turnFilesRebuilding")}
				</div>
			)}
		</div>
	);
});
