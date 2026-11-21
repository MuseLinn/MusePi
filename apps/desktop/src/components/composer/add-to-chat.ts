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
 * One registration per side, last one wins. The composer entry mounts its own
 * intake and its skins keep a fallback intake for direct mounts, so the two can
 * register in one session; child effects run before the entry's, which leaves
 * the entry's intake — the one whose chips the frame renders — as the live
 * registration.
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
}

let filesApi: AddToChatFilesApi | null = null;
let draftApi: AddToChatDraftApi | null = null;

export function registerAddToChatFiles(api: AddToChatFilesApi): () => void {
	filesApi = api;
	return () => {
		if (filesApi === api) filesApi = null;
	};
}

export function registerAddToChatDraft(api: AddToChatDraftApi): () => void {
	draftApi = api;
	return () => {
		if (draftApi === api) draftApi = null;
	};
}

export function addToChatUnavailableReason(): string | null {
	if (!draftApi?.canInsert() || !filesApi) return t("settings.addToChatUnavailable");
	return null;
}

/** Stage `target` and insert its token. Never sends, never replaces the
 *  selection; a failure surfaces a notice because the menu item looked live. */
export async function addFileToChat(target: AddToChatTarget): Promise<boolean> {
	if (target.isDir) return false;
	const files = filesApi;
	const draft = draftApi;
	if (!files || !draft?.canInsert()) {
		toast(t("settings.addToChatUnavailable"));
		return false;
	}
	let label: string | null = null;
	try {
		label = await files.addWorkspaceFile({ path: target.path, name: target.name, size: target.size });
	} catch {
		label = null;
	}
	if (!label) {
		toast(t("settings.addToChatFailed", { name: target.name }));
		return false;
	}
	// The draft is re-read: the file read above yields, so a closed or
	// read-only composer must not receive the staged chip's token.
	if (!draft.canInsert()) {
		toast(t("settings.addToChatUnavailable"));
		return false;
	}
	draft.insertMention(label);
	return true;
}

function toast(text: string): void {
	window.dispatchEvent(new CustomEvent("musepi-gui-toast", { detail: text }));
}
