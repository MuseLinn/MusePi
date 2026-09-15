import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import type { SessionClient } from "../../lib/client";
import { useGuestSelector } from "../../lib/use-guest";

/** Circumference of the r=9 progress track (2πr ≈ 56.55). */
const CIRC = 2 * Math.PI * 9;

/** Composer context ring — live context-window usage from
 *  `SessionState.contextUsage` (already on the wire; zero protocol work).
 *  Track = white 9%, fill = accent; turns amber past 80%. Hidden entirely
 *  when the host hasn't reported usage (null percent, e.g. idle sessions). */
export function ContextRing({ client }: { client: SessionClient }): ReactNode {
	const percent = useGuestSelector(client, s => s.state?.contextUsage?.percent ?? null);
	if (percent === null) return null;
	const clamped = Math.max(0, Math.min(100, percent));
	const warn = clamped > 80;
	const title = `${t("context usage")} ${Math.round(clamped)}%`;
	return (
		<span className={`sh-ctx-ring${warn ? " sh-ctx-ring--warn" : ""}`} role="img" aria-label={title} title={title}>
			<svg width={22} height={22} viewBox="0 0 22 22" aria-hidden="true">
				<circle className="sh-ctx-ring-track" cx={11} cy={11} r={9} fill="none" strokeWidth={2.5} />
				<circle
					className="sh-ctx-ring-fill"
					cx={11}
					cy={11}
					r={9}
					fill="none"
					strokeWidth={2.5}
					strokeLinecap="round"
					strokeDasharray={`${(clamped / 100) * CIRC} ${CIRC}`}
					transform="rotate(-90 11 11)"
				/>
			</svg>
		</span>
	);
}
