import type { ReactNode } from "react";
import type { SlashEntry } from "../SlashRow";

/**
 * Slash-command badge tip (TUI parity: the terminal editor paints the
 * command token in the accent color while typing — the desktop composer
 * shows a badge row instead). Detects line-leading command tokens in the
 * draft and renders one badge per command the daemon actually knows:
 * `⚡ /queue — Queue a message…`. Unknown `/tokens` (mid-line slashes,
 * escaped `//` prefixes, or names not in the registry) render nothing —
 * that is the point: a badge means the command will take effect, its
 * absence means it is just text.
 */

/** Line-leading command token: `/name` at the start of a line (or the
 *  whole draft); `//` is an escape (literal text), `/` alone is empty. */
const LINE_COMMAND_RE = /^\/[A-Za-z][\w-]*/;

export interface SlashCommandTipProps {
	text: string;
	/** Full command registry (commands.list) — null until fetched. */
	commands: SlashEntry[] | null;
}

/** Detect line-leading, registry-known commands in a draft (pure). */
export function detectLineCommands(text: string, known: ReadonlySet<string>): string[] {
	const hits: string[] = [];
	for (const line of text.split("\n")) {
		if (!line.startsWith("/") || line.startsWith("//")) continue;
		const token = LINE_COMMAND_RE.exec(line)?.[0];
		if (!token) continue;
		const name = token.slice(1);
		if (known.has(name)) hits.push(name);
	}
	// De-duplicate, keep first-occurrence order.
	return [...new Set(hits)];
}

function describe(commands: SlashEntry[] | null, name: string): string {
	const entry = commands?.find(c => c.name === name);
	if (entry?.description) return entry.description;
	return name;
}

/** Badge row under the composer input: one chip per effective command. */
export function SlashCommandTip({ text, commands }: SlashCommandTipProps): ReactNode {
	if (!commands || commands.length === 0) return null;
	const known = new Set(commands.map(c => c.name));
	const hits = detectLineCommands(text, known);
	if (hits.length === 0) return null;
	return (
		<div className="gui-magic-tip" role="status" aria-live="polite">
			{hits.map(name => (
				<span key={name} className="gui-magic-tip-row">
					<span className="gui-slash-badge">/ {name}</span>
					<span className="gui-magic-tip-desc">— {describe(commands, name)}</span>
				</span>
			))}
		</div>
	);
}
