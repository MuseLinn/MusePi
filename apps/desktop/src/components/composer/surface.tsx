import { createContext, useContext } from "react";
import type { useAttachments } from "./use-attachments";

/** The entry's contract with the two skins (ADR 0004 step 2). Only values a
 *  skin may also receive as props live here: a direct mount (tests, alternate
 *  hosts) keeps working without a provider. State stays in `Composer`. */
/** One send payload for both skins (ADR 0004 step 2). Hero sends fill the
 *  create-session fields, session sends fill the delivery fields; the entry
 *  routes them to the right handler, so the future single body calls one
 *  function regardless of variant. */
export interface ComposerSendPayload {
	thinkingLevel?: string | null;
	modelId?: string | null;
	images?: { type: "image"; data: string; mimeType: string }[];
	displayContext?: unknown;
	files?: File[];
	videos?: { type: "video"; mimeType: string; url?: string; data?: string }[];
	planMode?: boolean;
	goalMode?: boolean;
	guidedGoal?: boolean;
	deliverAs?: "prompt" | "steer" | "followUp" | "continue";
	/** Send identity minted by the host BEFORE the DOM changes (a send flight
	 *  has to know which row it is aiming at before the echo exists). Threaded
	 *  through to the RPC so the daemon stamps the same identity on the
	 *  message it persists. */
	correlation?: { clientId: string; clientRequestId: string };
}

export interface ComposerSurface {
	variant: "hero" | "session";
	intake: ReturnType<typeof useAttachments>;
	initialDraft: string;
	onDraftChange(text: string): void;
	/** The one send contract: the entry dispatches to the active variant. */
	send(text: string, payload?: ComposerSendPayload): void | Promise<void>;
	carryDraft?: string;
	carryChips?: boolean;
}

export const ComposerSurfaceContext = createContext<ComposerSurface | null>(null);

/** A skin reads the entry's surface when mounted through `Composer`; outside
 *  the provider it falls back to its own props/state. */
export function useComposerSurface(): ComposerSurface | null {
	return useContext(ComposerSurfaceContext);
}

/**
 * Route one send payload to the variant's handler. Lives here (pure, no React)
 * so the contract is testable without mounting either skin — the entry keeps
 * only the wiring.
 */
export function createSurfaceSend(handlers: {
	variant: "hero" | "session";
	onSubmit?: (text: string, payload?: ComposerSendPayload) => void | Promise<void>;
	onSend?: (
		text: string,
		images?: ComposerSendPayload["images"],
		deliverAs?: ComposerSendPayload["deliverAs"],
		displayContext?: ComposerSendPayload["displayContext"],
		videos?: ComposerSendPayload["videos"],
		correlation?: ComposerSendPayload["correlation"],
	) => void;
}): (text: string, payload?: ComposerSendPayload) => void | Promise<void> {
	return (text, payload = {}) => {
		if (handlers.variant === "hero") {
			return handlers.onSubmit?.(text, payload);
		}
		return handlers.onSend?.(
			text,
			payload.images,
			payload.deliverAs,
			payload.displayContext,
			payload.videos,
			payload.correlation,
		);
	};
}
