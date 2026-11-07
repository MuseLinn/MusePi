/**
 * Inter-agent IRC traffic rows (`irc:incoming` / `irc:autoreply` / `irc:relay`).
 * The display shape and the `details`-over-`content` rule live in `lib/irc`;
 * this module owns the transcript row and the consecutive-pair key.
 */

import type { SessionEntry } from "@musepi/pi-wire";
import type { ReactNode } from "react";
import { useState } from "react";
import { t } from "../../i18n/index.js";
import { type IrcPresentation, ircPresentation } from "../../lib/irc";
import { readLiveCustomMessage } from "./transcript-content.js";

export type { IrcKind, IrcPresentation } from "../../lib/irc";

/** Bodies above this many non-empty lines start clamped. */
const IRC_CLAMP_LINES = 3;

/** Stable identity of the two parties, whichever direction the message went:
 *  consecutive rows with the same key share one route header. */
export function ircPairKeyOf(entry: SessionEntry): string | null {
	const custom =
		entry.type === "custom_message"
			? { customType: entry.customType, content: entry.content, details: entry.details }
			: entry.type === "message"
				? readLiveCustomMessage(entry.message)
				: undefined;
	if (!custom?.customType.startsWith("irc:")) return null;
	const p = ircPresentation(custom.customType, custom.content, custom.details);
	const me = "\u0000me";
	return [p.from ?? me, p.to ?? me].sort().join("\u0000");
}

export function IrcCard({
	presentation,
	continued = false,
	children,
}: {
	presentation: IrcPresentation;
	continued?: boolean;
	children: ReactNode;
}): ReactNode {
	const [expanded, setExpanded] = useState(false);
	const { kind, from, to, body, replyTo } = presentation;
	const clampable = body.split("\n").filter(line => line.trim() !== "").length > IRC_CLAMP_LINES;
	const clamped = clampable && !expanded;
	const self = t("transcript.ircMe");
	const route =
		kind === "incoming" ? (
			<>
				<span className="tr-irc-arrow" aria-hidden>
					←
				</span>
				<span className="tr-irc-from">{from ?? "?"}</span>
			</>
		) : (
			<>
				<span className="tr-irc-from">{from ?? self}</span>
				<span className="tr-irc-arrow" aria-hidden>
					→
				</span>
				<span className="tr-irc-to">{to ?? "?"}</span>
			</>
		);
	return (
		<div className={`tr-irc tr-irc--${kind}${continued ? " tr-irc--continued" : ""}`}>
			{continued ? null : (
				<div className="tr-irc-head">
					<span className="tr-irc-route">{route}</span>
					{kind === "autoreply" && <span className="tr-irc-tag">{t("transcript.ircAuto")}</span>}
					{replyTo && <span className="tr-irc-tag">{t("transcript.ircReply")}</span>}
				</div>
			)}
			<div className={`tr-irc-body${clamped ? " tr-irc-body--clamped" : ""}`}>{children}</div>
			{clampable && (
				<button
					type="button"
					className="tr-irc-more"
					aria-expanded={expanded}
					onClick={() => setExpanded(open => !open)}
				>
					{expanded ? t("transcript.ircShowLess") : t("transcript.ircShowMore")}
				</button>
			)}
		</div>
	);
}
