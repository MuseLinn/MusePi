import type { ForeignSessionInfo, ForeignSessionStore } from "./foreign-session-store";
import type { SessionInfo } from "./session-listing";
import type { SessionManager } from "./session-manager";

export {
	createForeignSessionStore,
	type ForeignSessionSourceDescriptor,
	foreignSessionSourceDescriptors,
	foreignSessionSourceName,
	foreignSessionSources,
} from "./foreign-session-sources";
export type { ForeignSessionInfo, ForeignSessionSource, ForeignSessionStore } from "./foreign-session-store";

/**
 * One scanned foreign session, as the import picker receives it over RPC.
 *
 * Dates are ISO strings because the list crosses a JSON boundary; the picker
 * formats them itself. `additionalDirectories` mirrors the source's ordered
 * reference roots and is omitted when the session has only its primary
 * directory, so a single-root row carries no empty array to interpret.
 */
export interface ForeignSessionRow {
	readonly id: string;
	readonly path: string;
	readonly title: string;
	readonly cwd: string;
	readonly created: string;
	readonly modified: string;
	readonly messageCount: number;
	readonly firstMessage: string;
	readonly additionalDirectories?: readonly string[];
	readonly importedSessionId: string | null;
}

/** Project one listed session onto the picker's row shape. */
export function foreignSessionRow(info: ForeignSessionInfo, importedSessionId: string | null): ForeignSessionRow {
	return {
		id: info.id,
		path: info.path,
		title: info.title ?? "",
		cwd: info.cwd,
		created: info.created.toISOString(),
		modified: info.modified.toISOString(),
		messageCount: info.messageCount ?? 0,
		firstMessage: info.firstMessage ?? "",
		additionalDirectories: info.additionalDirectories?.length ? [...info.additionalDirectories] : undefined,
		importedSessionId,
	};
}

/** Convert lightweight foreign metadata for the existing session picker. */
export function foreignSessionInfoToSessionInfo(info: ForeignSessionInfo): SessionInfo {
	const firstMessage = info.firstMessage ?? "(no messages)";
	return {
		path: info.path,
		id: info.id,
		cwd: info.cwd,
		title: info.title,
		created: info.created,
		modified: info.modified,
		messageCount: info.messageCount ?? 0,
		size: 0,
		firstMessage,
		allMessagesText: firstMessage,
	};
}

/**
 * Import and persist one foreign session under a fresh MusePi session identity.
 *
 * The session keeps the workspace it ran in even when that folder is absent on
 * this machine: a foreign store may name a directory from another host, and
 * moving the copy to `fallbackCwd` would file it under the wrong project. The
 * fallback applies only when the source recorded no cwd at all.
 */
export async function persistForeignSession(
	store: ForeignSessionStore,
	info: ForeignSessionInfo,
	options?: { fallbackCwd?: string; sessionDir?: string; suppressBreadcrumb?: boolean },
): Promise<SessionManager> {
	const imported = await store.load(info);
	imported.appendCustomEntry("foreign_session_import", {
		source: info.source,
		sourceId: info.id,
		sourcePath: info.path,
		sourceCwd: info.cwd,
	});
	if (options?.fallbackCwd && !imported.getCwd()) {
		await imported.moveTo(options.fallbackCwd);
	}
	return await imported.persistCopy(options);
}
