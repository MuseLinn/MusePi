import { directoryExists } from "@musepi/pi-utils";
import { ClaudeSessionStore } from "./claude-session-store";
import { CodexSessionStore } from "./codex-session-store";
import { GenericJsonlSessionStore } from "./generic-jsonl-session-store";
import { OpencodeSessionStore } from "./opencode-session-store";
import { SdkCompatSessionStore } from "./sdk-compat-session-store";
import type { ForeignSessionInfo, ForeignSessionSource, ForeignSessionStore } from "./foreign-session-store";
import type { SessionInfo } from "./session-listing";
import type { SessionManager } from "./session-manager";

/** Construct the importer for a supported foreign session source. */
export function createForeignSessionStore(source: ForeignSessionSource): ForeignSessionStore {
	switch (source) {
		case "claude":
			return new ClaudeSessionStore();
		case "codex":
			return new CodexSessionStore();
		case "musepi":
			return new SdkCompatSessionStore("musepi");
		case "omp":
			return new SdkCompatSessionStore("omp");
		case "pi":
			return new SdkCompatSessionStore("pi");
		case "opencode":
			return new OpencodeSessionStore();
		case "grok":
			return new GenericJsonlSessionStore("grok");
		case "kimicode":
			return new GenericJsonlSessionStore("kimicode");
	}
}

/** Display name for a supported foreign session source. */
export function foreignSessionSourceName(source: ForeignSessionSource): string {
	switch (source) {
		case "claude":
			return "Claude";
		case "codex":
			return "Codex";
		case "musepi":
			return "MusePi";
		case "omp":
			return "OMP";
		case "pi":
			return "Pi";
		case "opencode":
			return "OpenCode";
		case "grok":
			return "Grok";
		case "kimicode":
			return "Kimi Code";
	}
}

/** All importable sources, in display order. */
export function foreignSessionSources(): ForeignSessionSource[] {
	return ["musepi", "omp", "pi", "opencode", "grok", "kimicode", "claude", "codex"];
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

/** Import and persist one foreign session under a fresh OMP session identity. */
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
	if (options?.fallbackCwd && !(await directoryExists(imported.getCwd()))) {
		await imported.moveTo(options.fallbackCwd);
	}
	return await imported.persistCopy(options);
}
