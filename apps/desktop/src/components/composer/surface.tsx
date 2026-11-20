import { createContext, useContext } from "react";
import type { useAttachments } from "./use-attachments";

/** The entry's contract with the two skins (ADR 0004 step 2). Only values a
 *  skin may also receive as props live here: a direct mount (tests, alternate
 *  hosts) keeps working without a provider. State stays in `Composer`. */
export interface ComposerSurface {
	variant: "hero" | "session";
	intake: ReturnType<typeof useAttachments>;
	initialDraft: string;
	onDraftChange(text: string): void;
	carryDraft?: string;
	carryChips?: boolean;
}

export const ComposerSurfaceContext = createContext<ComposerSurface | null>(null);

/** A skin reads the entry's surface when mounted through `Composer`; outside
 *  the provider it falls back to its own props/state. */
export function useComposerSurface(): ComposerSurface | null {
	return useContext(ComposerSurfaceContext);
}
