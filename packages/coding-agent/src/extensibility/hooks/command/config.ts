import { matcherDiagnostic } from "./matcher";
import {
	COMMAND_HOOK_EVENTS,
	type CommandHook,
	type CommandHookConfig,
	type CommandHookEvent,
	type HookDialect,
	type MatcherGroup,
	type SkippedHook,
} from "./types";

/**
 * Parse a Claude Code or Codex hook config into the shared matcher-group shape.
 *
 * Both dialects accept either a bare event map or a `{ hooks: … }` wrapper
 * (Claude settings files). Only command hooks run: other handler types are
 * reported so the bridge can warn instead of silently ignoring them, and
 * Claude's `async` field (Codex only) is the same kind of skip. Malformed
 * groups are dropped rather than failing startup; an invalid regex matcher is
 * the one hard error, because accepting it would make a group match nothing at
 * runtime without saying so.
 */

const CLAUDE_EVENTS = [...COMMAND_HOOK_EVENTS, "SubagentStart", "SubagentStop"] as const;
const CODEX_EVENTS = [...COMMAND_HOOK_EVENTS] as const;

export interface SubstitutionVars {
	pluginRoot?: string;
	projectDir?: string;
}

export interface ParsedHookConfig {
	config: CommandHookConfig;
	skipped: SkippedHook[];
}

/** `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PROJECT_DIR}` substitution, unset tokens verbatim. */
export function substituteCommand(command: string, vars: SubstitutionVars): string {
	let out = command;
	if (vars.pluginRoot !== undefined) out = out.split("${CLAUDE_PLUGIN_ROOT}").join(vars.pluginRoot);
	if (vars.projectDir !== undefined) out = out.split("${CLAUDE_PROJECT_DIR}").join(vars.projectDir);
	return out;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function supported(event: string): event is CommandHookEvent {
	return (COMMAND_HOOK_EVENTS as readonly string[]).includes(event);
}

/** Matcher fields are meaningless on these points; the reference dialects discard them. */
function hasMatcherSubject(event: CommandHookEvent): boolean {
	return event === "SessionStart" || event === "PreToolUse" || event === "PostToolUse";
}

export function parseHookConfig(raw: unknown, dialect: HookDialect, vars: SubstitutionVars = {}): ParsedHookConfig {
	const config: CommandHookConfig = {};
	const skipped: SkippedHook[] = [];
	const root = record(raw);
	const hooksMap = root ? (record(root.hooks) ?? root) : undefined;
	if (!hooksMap) return { config, skipped };

	const events = dialect === "claude-code" ? CLAUDE_EVENTS : CODEX_EVENTS;
	for (const event of events) {
		const rawGroups = hooksMap[event];
		if (!Array.isArray(rawGroups)) continue;
		if (!supported(event)) {
			skipped.push({ event, reason: "event is not bridged by this host" });
			continue;
		}
		const groups: MatcherGroup[] = [];
		for (const rawGroup of rawGroups) {
			const group = record(rawGroup);
			if (!group || !Array.isArray(group.hooks)) continue;
			const commands: CommandHook[] = [];
			for (const rawHook of group.hooks) {
				const hook = record(rawHook);
				if (!hook) continue;
				const type = typeof hook.type === "string" ? hook.type : "command";
				if (type !== "command") {
					skipped.push({ event, reason: `unsupported "${type}" hook` });
					continue;
				}
				if (hook.async === true) {
					skipped.push({ event, reason: "async hook" });
					continue;
				}
				if (typeof hook.command !== "string" || hook.command.trim() === "") continue;
				const timeout =
					typeof hook.timeout === "number"
						? hook.timeout
						: typeof hook.timeoutSec === "number"
							? hook.timeoutSec
							: undefined;
				commands.push({
					command: dialect === "claude-code" ? substituteCommand(hook.command, vars) : hook.command,
					...(timeout !== undefined ? { timeoutSec: timeout } : {}),
				});
			}
			if (commands.length === 0) continue;
			const matcher = hasMatcherSubject(event) && typeof group.matcher === "string" ? group.matcher : undefined;
			const diagnostic = matcherDiagnostic(matcher, dialect);
			if (diagnostic !== undefined) throw new SyntaxError(`${diagnostic} on event ${JSON.stringify(event)}`);
			groups.push({ ...(matcher !== undefined ? { matcher } : {}), hooks: commands });
		}
		if (groups.length > 0) config[event] = groups;
	}
	return { config, skipped };
}
