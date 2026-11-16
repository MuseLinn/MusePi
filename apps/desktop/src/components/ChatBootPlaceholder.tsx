/**
 * The chat surface's placeholder while its plugin mounts.
 *
 * The session view is a plugin-contributed surface; between the shell's first
 * paint and that mount the content area is empty, which reads as a freeze. This
 * holds the space with the brand and one quiet motion so the hand-off looks like
 * loading rather than a hang. It is deliberately cheap — three dots and a
 * gradient, no canvas — because it renders on the same path it is waiting for.
 */
import { t } from "@musepi/client-core";
import type { ReactNode } from "react";

export function ChatBootPlaceholder(): ReactNode {
	return (
		<div className="gui-chat-boot" role="status" aria-live="polite" aria-label={t("transcript.bootPreparing")}>
			<div className="gui-chat-boot-mark">
				<span className="gui-brand-mark">π</span>
			</div>
			<div className="gui-chat-boot-dots" aria-hidden="true">
				<span />
				<span />
				<span />
			</div>
		</div>
	);
}
