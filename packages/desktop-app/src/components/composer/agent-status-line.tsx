import { Square } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { t } from "../../i18n/index.js";

/** Braille spinner frames (cli-spinners "dots" parity): 10 frames at 80ms
 * reads as a rotating 2×4 dot matrix while the agent works. */
const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/**
 * Compaction status line — replaces the agent status line while the
 * session context is being compacted (manual ring action or daemon auto
 * compaction). Same floating chip above the input card, plus a stop
 * button: the TUI's Esc path (session.abort → AgentSession.abort →
 * abortCompaction) without a confirm — compaction is cheap to re-run.
 */
export function CompactionStatusLine({ onCancel }: { onCancel(): void }): ReactNode {
	const [braille, setBraille] = useState(0);
	useEffect(() => {
		const id = window.setInterval(() => setBraille(i => (i + 1) % BRAILLE_FRAMES.length), 80);
		return () => clearInterval(id);
	}, []);
	return (
		<div className="gui-compact-line" role="status" aria-live="polite">
			<span className="gui-agent-status-braille" aria-hidden>
				{BRAILLE_FRAMES[braille]}
			</span>
			<span className="gui-compact-line-text">{t("compacting…")}</span>
			<button
				type="button"
				className="gui-compact-line-stop"
				onClick={onCancel}
				title={t("stop compaction")}
				aria-label={t("stop compaction")}
			>
				<Square size={11} fill="currentColor" />
			</button>
		</div>
	);
}
