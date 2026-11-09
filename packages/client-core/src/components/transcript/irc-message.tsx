/**
 * Inter-agent IRC traffic rows (`irc:incoming` / `irc:autoreply` / `irc:relay`).
 * The display shape and the `details`-over-`content` rule live in `lib/irc`;
 * this module owns the transcript row and the consecutive-pair key.
 */

import type { SessionEntry } from "@musepi/pi-wire";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n/index.js";
import { type IrcPresentation, ircPresentation } from "../../lib/irc";
import { useCollapseHeight } from "../../lib/use-collapse";
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

/**
 * Clamped IRC body with the shared collapse morph (`useCollapseHeight`): the
 * clamp comes OFF when expanding so the body grows out of the preview height,
 * and back ON once a collapse settles so it shrinks INTO the preview instead
 * of snapping to three lines. The preview height is cached while the clamp is
 * mounted — the hook measures after the class already flipped.
 */
function ClampedIrcBody({ children }: { children: ReactNode }): ReactNode {
	const [expanded, setExpanded] = useState(false);
	const [clamped, setClamped] = useState(true);
	const bodyRef = useRef<HTMLDivElement | null>(null);
	const previewHRef = useRef(0);
	useEffect(() => {
		if (clamped && bodyRef.current) previewHRef.current = bodyRef.current.clientHeight;
	});
	useCollapseHeight(expanded, bodyRef, {
		closedHeight: () => previewHRef.current,
		onSettled: open => {
			if (!open) setClamped(true);
		},
	});
	return (
		<>
			<div ref={bodyRef} className={`tr-irc-body${clamped ? " tr-irc-body--clamped" : ""}`}>
				{children}
			</div>
			<button
				type="button"
				className="tr-irc-more"
				aria-expanded={expanded}
				onClick={() => {
					if (expanded) {
						// The clamp reapplies when the collapse settles.
						setExpanded(false);
					} else {
						// Unclamp first so the morph starts from the preview.
						setClamped(false);
						setExpanded(true);
					}
				}}
			>
				{expanded ? t("transcript.ircShowLess") : t("transcript.ircShowMore")}
			</button>
		</>
	);
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
	const { kind, from, to, body, replyTo } = presentation;
	const clampable = body.split("\n").filter(line => line.trim() !== "").length > IRC_CLAMP_LINES;
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
			{clampable ? <ClampedIrcBody>{children}</ClampedIrcBody> : <div className="tr-irc-body">{children}</div>}
		</div>
	);
}
