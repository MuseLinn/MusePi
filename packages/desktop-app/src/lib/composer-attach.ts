import type { MutableRefObject } from "react";

/**
 * File intake published by the mounted composer.
 *
 * The chat-level drop anchor stages OS files for the composer without owning
 * its attachment state: the composer fills this ref while it is mounted, and
 * the anchor reads it at drop time. One object per mount, so a scene
 * cross-fade cannot leave a stale entry behind.
 */
export interface ComposerAttachApi {
	addFiles(files: File[]): Promise<void>;
}

export type ComposerAttachRef = MutableRefObject<ComposerAttachApi | null>;
