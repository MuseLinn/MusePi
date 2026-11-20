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
