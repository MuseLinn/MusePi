import { ClaudeSessionStore } from "./claude-session-store";
import { CodebuddySessionStore } from "./codebuddy-session-store";
import { CodexSessionStore } from "./codex-session-store";
import { DshSessionStore } from "./dsh-session-store";
import type { FOREIGN_SESSION_SOURCE_IDS, ForeignSessionSource } from "./foreign-session-source-ids";
import type { ForeignSessionInfo, ForeignSessionStore } from "./foreign-session-store";
import { GrokSessionStore } from "./grok-session-store";
import { KimiSessionStore } from "./kimi-session-store";
import { OpencodeSessionStore } from "./opencode-session-store";
import { SdkCompatSessionStore } from "./sdk-compat-session-store";
import { WorkbuddySessionStore } from "./workbuddy-session-store";

/**
 * One importable source: how it is identified, what it is called, and how to
 * read it.
 */
export interface ForeignSessionSourceDescriptor {
	readonly source: ForeignSessionSource;
	/** Name shown wherever the source is listed. */
	readonly name: string;
	/** Construct the reader for this source. */
	readonly create: () => ForeignSessionStore;
}

/**
 * Every importable source, in display order.
 *
 * The list is the single place a source is declared: the picker, the CLI and
 * the daemon all read it, so adding one is a store plus one entry here rather
 * than a switch in each of them.
 */
const SOURCE_DESCRIPTORS = [
	{ source: "omp", name: "OMP", create: () => new SdkCompatSessionStore("omp") },
	{ source: "pi", name: "Pi", create: () => new SdkCompatSessionStore("pi") },
	{ source: "opencode", name: "OpenCode", create: () => new OpencodeSessionStore() },
	{ source: "grok", name: "Grok", create: () => new GrokSessionStore() },
	{ source: "kimicode", name: "Kimi Code", create: () => new KimiSessionStore() },
	{ source: "workbuddy", name: "WorkBuddy", create: () => new WorkbuddySessionStore() },
	{ source: "codebuddy", name: "CodeBuddy", create: () => new CodebuddySessionStore() },
	{ source: "dsh", name: "DeepSeek Harness", create: () => new DshSessionStore() },
	{ source: "claude", name: "Claude", create: () => new ClaudeSessionStore() },
	{ source: "codex", name: "Codex", create: () => new CodexSessionStore() },
] as const satisfies readonly ForeignSessionSourceDescriptor[];

/**
 * A source id with no entry in the list cannot be constructed, and an entry
 * no id names is unreachable. Declaring the check this way makes the compiler
 * reject the file when the two lists drift apart.
 */
type MissingSource = Exclude<
	(typeof FOREIGN_SESSION_SOURCE_IDS)[number],
	(typeof SOURCE_DESCRIPTORS)[number]["source"]
>;

type UnlistedSource = Exclude<
	(typeof SOURCE_DESCRIPTORS)[number]["source"],
	(typeof FOREIGN_SESSION_SOURCE_IDS)[number]
>;

/** Compile error while either set is non-empty. */
type AssertNoGaps = MissingSource extends never ? (UnlistedSource extends never ? true : never) : never;

const _exhaustive: AssertNoGaps = true;

const DESCRIPTORS_BY_SOURCE = new Map(SOURCE_DESCRIPTORS.map(d => [d.source, d]));

/** Construct the importer for a supported foreign session source. */
export function createForeignSessionStore(source: ForeignSessionSource): ForeignSessionStore {
	const descriptor = DESCRIPTORS_BY_SOURCE.get(source);
	if (!descriptor) throw new Error(`unknown import source: ${source}`);
	return descriptor.create();
}

/** Display name for a supported foreign session source. */
export function foreignSessionSourceName(source: ForeignSessionSource): string {
	return DESCRIPTORS_BY_SOURCE.get(source)?.name ?? source;
}

/** All importable sources, in display order. */
export function foreignSessionSources(): ForeignSessionSource[] {
	return SOURCE_DESCRIPTORS.map(d => d.source);
}

/** The declared sources, for a caller that needs names as well as ids. */
export function foreignSessionSourceDescriptors(): readonly ForeignSessionSourceDescriptor[] {
	return SOURCE_DESCRIPTORS;
}

export type { ForeignSessionInfo, ForeignSessionSource, ForeignSessionStore };
