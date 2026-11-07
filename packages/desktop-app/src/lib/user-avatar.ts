/**
 * Chat-bubble avatar source (设置 → Git → 用户头像来源), shared by the
 * settings control and every mounted bubble.
 *
 * The bubble renders once per message row, so it reads these keys
 * synchronously instead of asking the daemon; one reader/writer per key keeps
 * the two surfaces from drifting, and a same-window event is required because
 * `storage` does not fire in the window that wrote it. Mirrors `git-prefs.ts`.
 */

export const USER_AVATAR_URL_KEY = "musepi-gui-user-avatar";
export const USER_AVATAR_MODE_KEY = "musepi-gui-user-avatar-mode";

/** Fired after the source mode or the GitHub picture changes. */
export const USER_AVATAR_EVENT = "omp-avatar-changed";

/** `auto` = GitHub photo → identity-derived pixel face → initial letter;
 *  `punk` = the user-chosen pixel face; `initial` = the letter chip only. */
export type UserAvatarMode = "auto" | "punk" | "initial";

export interface UserAvatarPrefs {
	mode: UserAvatarMode;
	url: string | null;
}

/**
 * Stored source, normalised: a missing, unknown, or corrupt value reads as
 * `auto`, so the settings control never mounts with no segment selected.
 */
export function readUserAvatarMode(): UserAvatarMode {
	try {
		const stored = localStorage.getItem(USER_AVATAR_MODE_KEY);
		return stored === "punk" || stored === "initial" ? stored : "auto";
	} catch {
		return "auto";
	}
}

/** Both keys in one read — the bubble needs them together. */
export function readUserAvatarPrefs(): UserAvatarPrefs {
	try {
		return {
			mode: readUserAvatarMode(),
			url: localStorage.getItem(USER_AVATAR_URL_KEY) || null,
		};
	} catch {
		return { mode: "auto", url: null };
	}
}

export function writeUserAvatarMode(mode: UserAvatarMode): void {
	try {
		localStorage.setItem(USER_AVATAR_MODE_KEY, mode);
	} catch {
		// storage unavailable — the in-memory state still drives this render
	}
	window.dispatchEvent(new CustomEvent(USER_AVATAR_EVENT));
}

/**
 * Publish the GitHub avatar to the chat bubbles. They read the key
 * synchronously and re-render on {@link USER_AVATAR_EVENT}, so writing
 * storage alone leaves every mounted bubble — and every bubble until the next
 * unrelated re-render — on the previous picture. Connecting, disabling, and
 * logging out all land here.
 *
 * The event fires only on a real change: the settings tab refreshes auth on
 * every open, and a needless broadcast re-renders the whole transcript.
 */
export function syncUserAvatarUrl(url: string | null): void {
	let changed = false;
	try {
		const previous = localStorage.getItem(USER_AVATAR_URL_KEY);
		if (url) {
			if (previous !== url) {
				localStorage.setItem(USER_AVATAR_URL_KEY, url);
				changed = true;
			}
		} else if (previous !== null) {
			localStorage.removeItem(USER_AVATAR_URL_KEY);
			changed = true;
		}
	} catch {
		// storage unavailable — nothing to publish
	}
	if (changed) window.dispatchEvent(new CustomEvent(USER_AVATAR_EVENT));
}

/** Subscribe to changes: the same-window event plus `storage` for other
 *  windows. Returns the unsubscribe handle. */
export function onUserAvatarChanged(listener: () => void): () => void {
	const onStorage = (event: StorageEvent): void => {
		if (!event.key || event.key === USER_AVATAR_URL_KEY || event.key === USER_AVATAR_MODE_KEY) listener();
	};
	window.addEventListener(USER_AVATAR_EVENT, listener);
	window.addEventListener("storage", onStorage);
	return () => {
		window.removeEventListener(USER_AVATAR_EVENT, listener);
		window.removeEventListener("storage", onStorage);
	};
}
