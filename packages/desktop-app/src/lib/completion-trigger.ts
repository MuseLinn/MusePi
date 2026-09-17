/**
 * Trigger rules for the composer's inline completion panels (`/` commands,
 * `@` mentions, `#` session refs).
 *
 * These live in one module because BOTH composers use them — the session
 * composer (`composer/use-completion`) and the welcome composer
 * (`WelcomeComposer`) — and they had drifted: the session one was fixed for
 * "中文正文或标点紧邻 @ 也能唤起面板" while the welcome one still demanded a
 * line-leading token, so the empty state and an open session behaved
 * differently for the same keystroke.
 *
 * The rule for all three tokens is the same: the character opens its panel
 * when it is not glued to an ASCII word character, so a line start, whitespace,
 * CJK body text ("请看@文件") and punctuation ("（@组件") all trigger, while an
 * email-ish `foo@bar` and a path-ish `foo/bar` do not.
 */

/** A token opens its panel when the preceding character is not `[A-Za-z0-9_]`. */
export function isTokenTrigger(line: string, index: number): boolean {
	if (index <= 0) return true; // line start
	return !/[A-Za-z0-9_]/.test(line[index - 1] ?? "");
}

/**
 * Index of the LAST `token` occurrence in `line` that passes `isTokenTrigger`,
 * or -1 when the token never opens a panel on this line.
 *
 * Scanning backwards (rather than taking `lastIndexOf` outright) matters:
 * `foo@bar @baz` must anchor on the second `@`, not on the one inside the
 * email-ish token.
 */
export function lastTokenIndex(line: string, token: string): number {
	for (let i = line.lastIndexOf(token); i >= 0; i = line.lastIndexOf(token, i - 1)) {
		if (isTokenTrigger(line, i)) return i;
	}
	return -1;
}

/** The active line a caret position sits on, plus the index that line starts at. */
export function currentLine(value: string): { line: string; lineStart: number } {
	const lineStart = value.lastIndexOf("\n") + 1;
	return { line: value.slice(lineStart), lineStart };
}

/**
 * Query text a completion panel should filter by, or `null` when the panel must
 * stay closed.
 *
 * All three tokens are single words — a mention never contains whitespace, and a
 * space after a `/` means the user moved on to prose ("/clear then do X") — so a
 * whitespace-bearing tail closes the panel rather than filtering by it.
 */
export function tokenQuery(line: string, token: string): { query: string; anchor: number } | null {
	const anchor = lastTokenIndex(line, token);
	if (anchor < 0) return null;
	const query = line.slice(anchor + 1);
	if (!/^\S*$/.test(query)) return null;
	return { query, anchor };
}
