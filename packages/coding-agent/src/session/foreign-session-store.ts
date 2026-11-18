import type { ForeignSessionSource } from "./foreign-session-source-ids";
import type { SessionManager } from "./session-manager";

export type { ForeignSessionSource } from "./foreign-session-source-ids";

/** Lightweight source metadata used to choose a foreign session before loading its transcript. */
export interface ForeignSessionInfo {
	readonly source: ForeignSessionSource;
	readonly id: string;
	readonly path: string;
	readonly cwd: string;
	/**
	 * Extra workspace roots recorded by the source beside `cwd`, in their
	 * recorded order. Importers seed these into the session header so a
	 * multi-root workspace does not collapse into its primary directory.
	 */
	readonly additionalDirectories?: readonly string[];
	readonly title?: string;
	readonly created: Date;
	readonly modified: Date;
	readonly messageCount?: number;
	readonly firstMessage?: string;
}

/** Lists and converts sessions owned by another coding agent. */
export interface ForeignSessionStore {
	readonly source: ForeignSessionSource;
	/** Lists source sessions without parsing complete transcripts. */
	list(): Promise<ForeignSessionInfo[]>;
	/** Converts one source session into a non-persistent MusePi session. */
	load(session: ForeignSessionInfo): Promise<SessionManager>;
	/** Releases any handle the store holds open (a source database, a watcher). */
	close?(): void;
}
