import type { HookDialect, MatcherGroup } from "./types";

/**
 * Matcher semantics, ported from the reference dialects.
 *
 * Claude Code: a pattern made only of word characters and `|` is a
 * pipe-separated LITERAL alternative list; anything else is an unanchored
 * regex. Codex: every non-empty pattern is an unanchored regex. Absent, empty
 * and `*` match everything. An invalid regex is a non-match at dispatch time;
 * `matcherDiagnostic` lets a config loader reject it before registration.
 */

function isMatchAll(matcher: string | undefined): boolean {
	return matcher === undefined || matcher === "" || matcher === "*";
}

const CLAUDE_LITERAL = /^[A-Za-z0-9_|]+$/;

function compile(pattern: string): RegExp | undefined {
	try {
		return new RegExp(pattern);
	} catch {
		return undefined;
	}
}

export function matcherDiagnostic(matcher: string | undefined, mode: HookDialect): string | undefined {
	if (isMatchAll(matcher)) return undefined;
	const pattern = matcher as string;
	if (mode === "claude-code" && CLAUDE_LITERAL.test(pattern)) return undefined;
	return compile(pattern) === undefined ? `invalid ${mode} regex matcher ${JSON.stringify(pattern)}` : undefined;
}

export function matchesMatcher(matcher: string | undefined, query: string, mode: HookDialect): boolean {
	if (isMatchAll(matcher)) return true;
	const pattern = matcher as string;
	if (mode === "claude-code" && CLAUDE_LITERAL.test(pattern)) {
		return pattern.split("|").includes(query);
	}
	return compile(pattern)?.test(query) ?? false;
}

/** Groups in config order whose matcher selects `query`. */
export function selectHookGroups(
	groups: readonly MatcherGroup[] | undefined,
	query: string,
	mode: HookDialect,
): MatcherGroup[] {
	return (groups ?? []).filter(group => group.hooks.length > 0 && matchesMatcher(group.matcher, query, mode));
}
