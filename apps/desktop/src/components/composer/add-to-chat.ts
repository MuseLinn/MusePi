/**
 * File-menu "Add to chat": the right-click hand-off from the workspace tree
 * into the mounted session draft.
 *
 * The menu and the composer are separate surfaces (the file pane owns the
 * menu, the session surface owns the draft), so the capability is published
 * here instead of threaded through every host between them: the intake that
 * can upload files registers `addWorkspaceFile`, the composer registers the
 * insertion side, and the menu reads one availability answer and runs one
 * action.
 *
 * Insertion reuses the staged-chip path — the file becomes a `file` chip and
 * the draft gets its ordinal `@文件N` token — so the reference is the same
 * atomic pill an `@`-mention produces: painted, deleted as one unit, and
 * expanded at send time. The path itself never enters the draft, which is why
 * a name containing spaces, quotes or brackets cannot break the token.
 *
 * Constraints the menu depends on: the draft is read again when the item runs
 * (an editor can unmount between opening the menu and clicking), existing text
 * and the current selection are preserved, and nothing here can submit.
 *
 * Several composers can be live at once (the main chat plus a side session),
 * so this is a registry keyed by composer, not a pair of slots. The key is the
 * attachment setter both halves already hold — the draft the token enters and
 * the chip array it joins are then the same array by construction, so a hero
 * draft (no session to upload into) can never pair with a session's intake.
 * Resolution prefers the draft that holds focus, then the most recently used
 * one, and the answer is "unavailable" only when no live composer can take the
 * reference.
 */
import { t } from "../../i18n/index.js";

/** One workspace file the menu can hand over. */
export interface AddToChatFile {
	/** Absolute path on this machine; the daemon reads the bytes itself. */
	path: string;
	name: string;
	size?: number;
}

/** A right-click target: directories cannot ride a file chip. */
export interface AddToChatTarget extends AddToChatFile {
	isDir: boolean;
}

export interface AddToChatFilesApi {
	/** Stage the file as a chip and resolve with its ordinal mention label;
	 *  null when this intake cannot upload (no session draft yet). */
	addWorkspaceFile(file: AddToChatFile): Promise<string | null>;
}

export interface AddToChatDraftApi {
	/** Read whenever the menu renders and again before inserting. */
	canInsert(): boolean;
	/** Insert the mention token after the retained selection, then focus. */
	insertMention(label: string): void;
	/** True when the document's focus sits inside this draft's editor. */
	containsFocus?(): boolean;
}

/** One composer's identity: the `setAttachments` setter of the intake whose
 *  chips its draft renders. Both halves receive it, so pairing needs no
 *  extra plumbing from the entry. */
export type AddToChatKey = object;

interface Surface {
	files: AddToChatFilesApi | null;
	draft: AddToChatDraftApi | null;
	/** Order of the last user interaction, never wall-clock. */
	lastUsedAt: number;
}

const surfaces = new Map<AddToChatKey, Surface>();
/** Monotonic recency counter; ties keep the first-registered composer. */
let useClock = 0;

function surfaceFor(key: AddToChatKey): Surface {
	const existing = surfaces.get(key);
	if (existing) return existing;
	const created: Surface = { files: null, draft: null, lastUsedAt: 0 };
	surfaces.set(key, created);
	return created;
}

export function registerAddToChatFiles(key: AddToChatKey, api: AddToChatFilesApi): () => void {
	const surface = surfaceFor(key);
	surface.files = api;
	return () => {
		if (surface.files === api) surface.files = null;
		if (!surface.files && !surface.draft) surfaces.delete(key);
	};
}

export function registerAddToChatDraft(key: AddToChatKey, api: AddToChatDraftApi): () => void {
	const surface = surfaceFor(key);
	surface.draft = api;
	return () => {
		if (surface.draft === api) surface.draft = null;
		if (!surface.files && !surface.draft) surfaces.delete(key);
	};
}

/** The user worked in this composer: focus or a pointer press on its editor.
 *  This is what lets a second live composer win only once it is actually used. */
export function noteAddToChatFocus(key: AddToChatKey): void {
	const surface = surfaces.get(key);
	if (surface) surface.lastUsedAt = ++useClock;
}

export function addToChatUnavailableReason(): string | null {
	return resolveSurface() ? null : t("settings.addToChatUnavailable");
}

/** Stage `target` and insert its token. Never sends, never replaces the
 *  selection; a failure surfaces a notice because the menu item looked live. */
export async function addFileToChat(target: AddToChatTarget): Promise<boolean> {
	if (target.isDir) return false;
	// One surface for the whole action: the file read yields, and re-resolving
	// afterwards could pair this chip with another composer's draft.
	const surface = resolveSurface();
	if (!surface) {
		toast(t("settings.addToChatUnavailable"));
		return false;
	}
	let label: string | null = null;
	try {
		label = await surface.files.addWorkspaceFile({ path: target.path, name: target.name, size: target.size });
	} catch {
		label = null;
	}
	if (!label) {
		toast(t("settings.addToChatFailed", { name: target.name }));
		return false;
	}
	// The draft is re-read: the file read above yields, so a closed or
	// read-only composer must not receive the staged chip's token.
	if (!surface.draft.canInsert()) {
		toast(t("settings.addToChatUnavailable"));
		return false;
	}
	surface.draft.insertMention(label);
	return true;
}

/** The composer this action belongs to: the one holding focus, else the most
 *  recently used one, and only among surfaces that can take the reference. */
function resolveSurface(): { files: AddToChatFilesApi; draft: AddToChatDraftApi } | null {
	const live: { files: AddToChatFilesApi; draft: AddToChatDraftApi; lastUsedAt: number }[] = [];
	for (const surface of surfaces.values()) {
		if (!surface.files || !surface.draft?.canInsert()) continue;
		live.push({ files: surface.files, draft: surface.draft, lastUsedAt: surface.lastUsedAt });
	}
	const focused = live.find(entry => entry.draft.containsFocus?.() === true);
	if (focused) return { files: focused.files, draft: focused.draft };
	let best: (typeof live)[number] | null = null;
	for (const entry of live) if (!best || entry.lastUsedAt > best.lastUsedAt) best = entry;
	return best ? { files: best.files, draft: best.draft } : null;
}

function toast(text: string): void {
	window.dispatchEvent(new CustomEvent("musepi-gui-toast", { detail: text }));
}
