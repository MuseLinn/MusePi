import { useMemo, useState, type ReactNode } from "react";
import type { BashExecutionMessage } from "@musepi/pi-wire";
import { t } from "../../i18n/index.js";

/** Rows of output shown in the collapsed state; the rest folds behind a toggle. */
const MAX_PREVIEW_ROWS = 12;
const MAX_PREVIEW_BYTES = 8000;

/**
 * User-initiated shell command card (TUI !/!! parity): the `!cmd` /
 * `!!cmd` composer path appends a bashExecution message to the session,
 * which the daemon streams as a wire message entry. This renders it as a
 * terminal-style block — command line, output (truncatable), exit badge.
 */
export function BashCard({ message }: { message: BashExecutionMessage }): ReactNode {
	const [expanded, setExpanded] = useState(false);

	const { preview, hasMore } = useMemo(() => {
		const out = message.output;
		if (out.length <= MAX_PREVIEW_BYTES && !expanded) {
			const lines = out.split("\n");
			if (lines.length <= MAX_PREVIEW_ROWS) {
				return { preview: out, hasMore: false };
			}
			return { preview: lines.slice(0, MAX_PREVIEW_ROWS).join("\n"), hasMore: true };
		}
		return { preview: out, hasMore: false };
	}, [message.output, expanded]);

	const status = message.cancelled ? "cancelled" : message.exitCode === 0 ? "ok" : "error";

	return (
		<div className="tr-bash">
			<div className="tr-bash-cmd">
				<span className="tr-bash-prompt" aria-hidden="true">
					$
				</span>
				<code>{message.command}</code>
				{message.excludeFromContext && <span className="tr-bash-excluded">{t("bash output excluded from context")}</span>}
			</div>
			{message.output.length > 0 && (
				<pre className="tr-bash-out">
					{preview}
					{hasMore && !expanded ? "…" : ""}
				</pre>
			)}
			<div className="tr-bash-meta">
				<span className={`tr-bash-badge tr-bash-badge--${status}`}>
					{message.cancelled
						? t("cancelled")
						: message.exitCode === undefined
							? "?"
							: `${t("exit code")} ${message.exitCode}`}
				</span>
				{message.truncated && <span className="tr-bash-truncated">{t("output truncated")}</span>}
				{hasMore && (
					<button type="button" className="tr-bash-toggle" onClick={() => setExpanded(v => !v)}>
						{expanded ? t("collapse") : `${t("show all")} (${message.output.split("\n").length} ${t("lines")})`}
					</button>
				)}
			</div>
		</div>
	);
}
