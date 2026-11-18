/**
 * External coding-agent session source supported by MusePi imports.
 *
 * The ids live in one list so the runtime catalogue and the type agree; a
 * contract test keeps them in step.
 */
export const FOREIGN_SESSION_SOURCE_IDS = [
	"omp",
	"pi",
	"opencode",
	"grok",
	"kimicode",
	"workbuddy",
	"codebuddy",
	"dsh",
	"claude",
	"codex",
] as const;

/** External coding-agent session source supported by MusePi imports. */
export type ForeignSessionSource = (typeof FOREIGN_SESSION_SOURCE_IDS)[number];
