/**
 * The transcript's tail presence: the agent's mark, what it is doing right now,
 * and how long the turn has run — the row that stands where the reply will land
 * while the model works and has not answered yet.
 *
 * The avatar and the expandable detail are injected by the host: this module
 * lives in the shared client and must not reach for the desktop's AgentAvatar.
 * Without them the row degrades to the phrase and the timer, which is what the
 * mobile surface and the subagent panel want.
 *
 * Three rules it must keep (docs/gui-design.md §3a and the design spec):
 *   1. the glyphs never move — the band sweeps and the bright copy inside it
 *      counter-translates, so only the light travels (the stylesheet's
 *      `presence-band` / `presence-bright` pair is the whole contract);
 *   2. the phrase is one line, ellipsised — this is a status reminder, not copy
 *      to read, so the full wording lives in the title and the detail card;
 *   3. a long silence is stated, never diagnosed: no "stuck", no retry.
 */
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { t } from "../../i18n/index.js";
import { collapseStyle, useCollapseHeight } from "../../lib/use-collapse.js";
import type { LivePhrase } from "./live-phrase";
import { phraseAt, phraseHoldMs } from "./live-phrase";
import { useWorkingNow } from "./use-working-now";

/** The sheen's period; the band's initial offset is spread across it so two
 *  rows on screen (main session + subagent panel) never sweep in lockstep. */
const SHEEN_PERIOD_MS = 2200;
/** Past this the row admits it has heard nothing new. Below it, silence is
 *  just a slow step and saying so would read as a fault. */
const QUIET_NOTICE_MS = 30_000;
/** Past this it also says how long, because "a while" stops being useful. */
const QUIET_MINUTES_MS = 90_000;

export interface TailPresenceProps {
	/** Host-injected agent mark. Omitted on surfaces without one. */
	avatar?: ReactNode;
	visible: boolean;
	phrase: LivePhrase;
	/** Stable per-conversation seed: rotation order and sheen offset. */
	seed: string;
	/** Turn start, epoch ms — the timer's anchor. */
	since?: number;
	/** Milliseconds since the last new activity, when the host knows it. */
	quietMs?: number;
	/** The expandable body: what this turn is running. */
	detail?: ReactNode;
	detailLabel?: string;
	className?: string;
}

/** How a long silence reads. Factual, never a diagnosis. */
function quietText(quietMs: number | undefined): string | null {
	if (quietMs === undefined || quietMs < QUIET_NOTICE_MS) return null;
	if (quietMs < QUIET_MINUTES_MS) return t("transcript.workingQuiet");
	return t("transcript.workingSilent", { minutes: Math.floor(quietMs / 60_000) });
}

/**
 * Rotates the phrase inside one phase. The step resets whenever the phase key
 * changes, so switching tools restarts the rotation instead of inheriting the
 * previous tool's step; the timer is re-armed on every step, which is what
 * makes the hold vary.
 */
function useRotatingPhrase(phrase: LivePhrase, seed: string, active: boolean): string {
	const phaseSeed = `${seed}|${phrase.phase}`;
	const [clock, setClock] = useState({ phaseSeed, step: 0 });
	if (clock.phaseSeed !== phaseSeed) setClock({ phaseSeed, step: 0 });
	const step = clock.phaseSeed === phaseSeed ? clock.step : 0;

	useEffect(() => {
		if (!active || phrase.phrases.length < 2) return;
		const timer = setTimeout(() => setClock({ phaseSeed, step: step + 1 }), phraseHoldMs(phaseSeed, step));
		return () => clearTimeout(timer);
	}, [active, phrase.phrases.length, phaseSeed, step]);

	return phraseAt(phrase.phrases, phaseSeed, step);
}

export function TailPresence({
	avatar,
	visible,
	phrase,
	seed,
	since,
	quietMs,
	detail,
	detailLabel,
	className,
}: TailPresenceProps): ReactNode {
	const [open, setOpen] = useState(false);
	const [sheenDelay] = useState(() => `-${Date.now() % SHEEN_PERIOD_MS}ms`);
	const now = useWorkingNow(visible && since !== undefined);
	const current = useRotatingPhrase(phrase, seed, visible);
	const bodyRef = useRef<HTMLDivElement>(null);
	const toggleRef = useRef<HTMLButtonElement>(null);
	const detailId = useId();
	const expandable = detail !== undefined;

	useCollapseHeight(open, bodyRef);

	useEffect(() => {
		if (!expandable) setOpen(false);
	}, [expandable]);

	useEffect(() => {
		if (!open) return;
		const fold = (event: KeyboardEvent): void => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			const inside = Boolean(bodyRef.current?.contains(document.activeElement));
			if (!inside && document.activeElement && document.activeElement !== document.body) return;
			event.preventDefault();
			setOpen(false);
			if (inside) toggleRef.current?.focus();
		};
		document.addEventListener("keydown", fold);
		return () => document.removeEventListener("keydown", fold);
	}, [open]);

	if (!visible) return null;

	const quiet = quietText(quietMs);
	const elapsed = since === undefined ? null : formatElapsed(now - since);

	const status = (
		<>
			<span className="presence-phrase" title={current}>
				{current}
			</span>
			<span className="presence-sheen" aria-hidden="true">
				<span
					className="presence-band"
					data-text={current}
					style={{ "--presence-sheen-delay": sheenDelay } as React.CSSProperties}
				/>
			</span>
		</>
	);

	return (
		<div className={`presence${className ? ` ${className}` : ""}`}>
			{avatar !== undefined && <span className="presence-avatar">{avatar}</span>}
			<span className="presence-body">
				{expandable ? (
					<button
						ref={toggleRef}
						type="button"
						className="presence-toggle"
						aria-expanded={open}
						aria-controls={detailId}
						aria-label={detailLabel ?? t("transcript.presenceDetailLabel")}
						onClick={() => setOpen(shown => !shown)}
					>
						{status}
					</button>
				) : (
					<span className="presence-slot">{status}</span>
				)}
				{elapsed !== null && (
					<>
						<span className="presence-sep" aria-hidden="true">
							·
						</span>
						<span className="presence-timer">{elapsed}</span>
					</>
				)}
				{quiet !== null && (
					<>
						<span className="presence-sep" aria-hidden="true">
							·
						</span>
						<span className="presence-quiet">{quiet}</span>
					</>
				)}
			</span>
			{/* The one live region: the canonical phrase (never the truncated
			 *  display) plus the timer's start, keyed by phase so the rotation
			 *  itself does not re-announce. */}
			<span className="presence-sr" role="status" aria-live="polite" key={phrase.phase}>
				{phrase.phrases[0] ?? ""}
			</span>
			{expandable && (
				<div
					ref={bodyRef}
					id={detailId}
					role="region"
					aria-label={detailLabel ?? t("transcript.presenceDetailLabel")}
					className="presence-detail"
					style={collapseStyle(open)}
				>
					<div className="presence-detail-inner">{detail}</div>
				</div>
			)}
		</div>
	);
}

/** mm:ss, or m:ss past an hour. Kept local: the transcript's own formatter
 *  lives in a module this component does not otherwise need. */
function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
