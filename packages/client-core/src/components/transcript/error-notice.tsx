/**
 * The two surfaces a failed turn can reach, split by who owns the failure.
 *
 * Both come from the same fact, so both had to be reconciled with the rule the
 * reference implementations use: one failure, one owning surface.
 *
 *  - {@link TurnErrorBody} is the message-level surface. The turn failed while
 *    (or before) producing its reply, so its reason stands in for the reply, in
 *    the message column, in ordinary body typography. It stays in history,
 *    because scrolling back to read why a turn stopped is a legitimate thing to
 *    want, and it takes no alarm colours: severity here is carried by the words
 *    and a small mark, not by painting a paragraph red.
 *  - {@link SessionErrorBanner} is the session-level surface. The runtime gave
 *    up on the round rather than reporting it into a message, so it docks above
 *    the composer instead of joining the flow, and it shows only while that round
 *    is the current one — sending again supersedes it. There is no close button
 *    on purpose: the next prompt is the dismissal.
 *
 * The banner is the liquid-glass treatment the rest of the docked composer
 * surfaces use, tinted with the error hue rather than the accent.
 *
 * Long provider bodies fold through {@link LongErrorText} on both surfaces. The
 * threshold is on the whole text, not on a line width, because a provider error
 * is typically one enormous line and a width-based cut would hide the provider's
 * own message at the tail.
 */
import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { LongErrorText } from "./long-error-text.js";

/** Which way the turn ended, so the body can say so in words. */
export type TurnErrorKind = "error" | "aborted";

export interface TurnErrorBodyProps {
	kind: TurnErrorKind;
	/** The provider's text. Nothing renders when this is empty. */
	raw?: string | undefined;
	/**
	 * Attempt count, merged in from a co-located `retry_failure` row. The body is
	 * the surface that owns the reason, so the count belongs to it too rather
	 * than to a second row repeating a failure the reader has already passed.
	 */
	attempt?: number | undefined;
}

/**
 * A failed turn, rendered as that turn's own text.
 *
 * No live region: this sits inside the transcript, which announces its own
 * messages, and a second region describing the same fact makes a screen reader
 * say it twice.
 */
export function TurnErrorBody({ kind, raw, attempt }: TurnErrorBodyProps): ReactNode {
	const text = (raw ?? "").trim();
	if (!text) return null;
	const label = kind === "aborted" ? t("request interrupted") : t("request failed");

	return (
		<div className="tr-error-body" data-error-kind={kind}>
			<div className="tr-error-body-head">
				<span className="tr-error-body-mark" aria-hidden="true" />
				<span className="tr-error-body-label">{label}</span>
				{attempt !== undefined ? (
					<span className="tr-error-body-meta">{t("retry attempt {count}", { count: String(attempt) })}</span>
				) : null}
			</div>
			<LongErrorText text={text}>{visible => <div className="tr-error-body-text">{visible}</div>}</LongErrorText>
		</div>
	);
}

export interface SessionErrorBannerProps {
	title: string;
	/** The provider's text. When empty, only the title and `action` render. */
	raw?: string | undefined;
	/** Trailing metadata, e.g. how many attempts were spent. */
	meta?: ReactNode;
	/** Offered when there is no text to show, e.g. a link to the runtime status. */
	action?: ReactNode;
}

/**
 * A round the runtime stopped without reporting into any message.
 *
 * `role="status"` rather than `alert`: this is a standing fact about the current
 * round, not something that just happened at the moment it appeared, and an
 * assertive region would interrupt whatever the transcript was saying.
 */
export function SessionErrorBanner({ title, raw, meta, action }: SessionErrorBannerProps): ReactNode {
	const text = (raw ?? "").trim();
	return (
		<div className="tr-error-banner" role="status" data-error-kind="session">
			<div className="tr-error-banner-head">
				<span className="tr-error-banner-mark" aria-hidden="true" />
				<span className="tr-error-banner-title">{title}</span>
				{meta !== undefined && meta !== null ? <span className="tr-error-banner-meta">{meta}</span> : null}
			</div>
			{text ? (
				<LongErrorText text={text}>
					{visible => <div className="tr-error-banner-text">{visible}</div>}
				</LongErrorText>
			) : null}
			{!text && action !== undefined && action !== null ? (
				<div className="tr-error-banner-action">{action}</div>
			) : null}
		</div>
	);
}
