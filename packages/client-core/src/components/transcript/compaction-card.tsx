import type { CompactionEntry } from "@musepi/pi-wire";
import { ChevronRight, Minimize2 } from "lucide-react";
import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { fmtTokens } from "../../lib/format";

/**
 * The checkpoint a compaction leaves in the transcript.
 *
 * It carries what the pass bought — the before/after counts and the tokens it
 * freed — so the reader does not have to open the summary to judge whether a
 * compaction was worth it, and the chevron opens that summary in the host's
 * side panel. The same card closes it: `open` is the host's answer to "is this
 * entry's summary the focused tab", so the control reads as a toggle rather
 * than a one-way link.
 */
export function CompactionCard({
	entry,
	open = false,
	onOpen,
	onClose,
}: {
	entry: CompactionEntry;
	open?: boolean;
	onOpen?(entry: CompactionEntry): void;
	onClose?(): void;
}): ReactNode {
	const saved = entry.tokensAfter === undefined ? 0 : Math.max(0, entry.tokensBefore - entry.tokensAfter);
	const title = entry.tokensAfter === undefined ? t("transcript.compactedPlain") : t("transcript.compactedAuto");
	const delta =
		entry.tokensAfter === undefined
			? ""
			: `${fmtTokens(entry.tokensBefore)} → ${fmtTokens(entry.tokensAfter)} tokens`;
	const body = (
		<>
			<span className="tr-compact-chip" aria-hidden>
				<Minimize2 size={12} />
			</span>
			<span className="tr-compact-title">{title}</span>
			{delta !== "" && <span className="tr-compact-tokens">{delta}</span>}
			{saved > 0 && (
				<span className="tr-compact-saved">{t("transcript.compactionSaved", { saved: fmtTokens(saved) })}</span>
			)}
			{onOpen && (
				<span className="tr-compact-chevron" aria-hidden>
					<ChevronRight size={12} />
				</span>
			)}
		</>
	);
	return (
		<div className="tr-compact-card" title={entry.shortSummary ?? entry.summary}>
			{onOpen ? (
				<button
					type="button"
					className="tr-compact-open"
					aria-expanded={open}
					onClick={() => (open && onClose ? onClose() : onOpen(entry))}
				>
					{body}
				</button>
			) : (
				<span className="tr-compact-static">{body}</span>
			)}
		</div>
	);
}
