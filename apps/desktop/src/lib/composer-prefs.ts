/**
 * Composer preferences that both composers read at event time (not at
 * render time): the value decides what a paste does, so a settings toggle
 * must take effect without remounting the open conversation.
 *
 * Storage is plain `localStorage`, matching every other GUI preference
 * written by PrefToggle. Unset means ON — pasting an image should produce a
 * reference the user can keep or delete, not silently stage another chip.
 */

/** Settings → 输入框 → 粘贴图片时自动提及. */
export const PASTE_IMAGE_MENTION_KEY = "musepi-gui-paste-image-mention";

export function readPasteImageMention(): boolean {
	try {
		return localStorage.getItem(PASTE_IMAGE_MENTION_KEY) !== "0";
	} catch {
		return true;
	}
}
