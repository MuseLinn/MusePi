/**
 * Dialect-neutral vocabulary for command hooks.
 *
 * Two external dialects share one shape: Claude Code's `hooks.json` and Codex's
 * `hooks.json` both describe an event → matcher group → command list. The
 * shared layer owns parsing, matching, execution, decoding and merging; a
 * dialect plugin owns only what actually differs (its event list, matcher mode,
 * payload fields and defaults). This is dsh's `hook-protocol` split without
 * importing its package: the contract stays inside MusePi's extension events.
 *
 * A command hook is a shell line, never a plugin: its whole interface with the
 * harness is stdin (one JSON payload), environment, exit code and stdout.
 */

export type HookDialect = "claude-code" | "codex";

/** The hook points both dialects can express. */
export const COMMAND_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"] as const;

export type CommandHookEvent = (typeof COMMAND_HOOK_EVENTS)[number];

/** One configured command hook (`{ type: "command", command, timeout? }`). */
export interface CommandHook {
	/** Shell command line. */
	command: string;
	/** Per-hook timeout in SECONDS (the wire unit both dialects use). */
	timeoutSec?: number;
}

/** A matcher pattern plus the commands it selects. Absent/empty/`*` = all. */
export interface MatcherGroup {
	matcher?: string;
	hooks: CommandHook[];
}

/** Parsed config: event name → its matcher groups (command hooks only). */
export type CommandHookConfig = Partial<Record<CommandHookEvent, MatcherGroup[]>>;

/** A hook the dialect cannot run, kept so the bridge can warn instead of hide it. */
export interface SkippedHook {
	event: string;
	reason: string;
}

/**
 * The dialect-neutral outcome of one hook process.
 *
 * Exit 0: stdout may carry structured JSON. Exit 2: block, stderr is the
 * reason. Any other exit (or a spawn failure, `exitCode: undefined`) is a
 * non-blocking error.
 */
export interface HookOutput {
	exitCode: number | undefined;
	/** Trimmed stderr — the reason source for a blocking exit. */
	stderr: string;
	/** Trimmed stdout, verbatim (plain text matters to SessionStart/UserPromptSubmit). */
	stdout: string;
	/** `false` asks the run to stop; pairs with `stopReason`. */
	continue?: boolean;
	stopReason?: string;
	/** Normalized decision: `block`/`deny` forbid, `allow`/`approve` permit, `ask` requests confirmation. */
	decision?: "approve" | "allow" | "block" | "deny" | "ask";
	reason?: string;
	/** Event discriminator claimed by `hookSpecificOutput`. */
	hookEventName?: string;
	/** Extra text for the next model request. */
	additionalContext?: string;
	/** A warning for the user. */
	systemMessage?: string;
}

/** The most-restrictive decision a hook point resolved to. */
export type MergedDecision = "allow" | "ask" | "deny" | "none";

/** The folded outcome of every hook that matched one point. */
export interface MergedHookOutcome {
	decision: MergedDecision;
	reason?: string;
	/** Any hook asked to halt (`continue: false`). */
	stop: boolean;
	stopReason?: string;
	/** In hook order; the bridge decides how to deliver them. */
	additionalContext: string[];
	/** In hook order; surfaced as user warnings. */
	systemMessages: string[];
}

/** One hook run, for logging/diagnostics and the bridge's own reporting. */
export interface HookRunRecord {
	group: number;
	hook: CommandHook;
	output: HookOutput;
	durationMs: number;
}
