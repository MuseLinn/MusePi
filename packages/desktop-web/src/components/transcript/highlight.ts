/**
 * Code-highlight plumbing shared by the desktop GUI and browser guests.
 *
 * The GUI supplies an async highlighter — the same Rust tree-sitter
 * `highlightCode` the TUI uses, reached over Electron IPC (the sandboxed
 * renderer cannot load native modules). Browser guests pass no highlighter
 * and render plain blocks. Only the pure ANSI → HTML conversion lives here:
 * no bridge, no native imports, so it is unit-testable and guest-safe.
 */

/** Highlighter supplied by the host app; null → plain code blocks. */
export type CodeHighlightFn = (code: string, lang: string | undefined) => string | null | Promise<string | null>;

export function escapeHtml(s: string): string {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/** Any SGR sequence: `\x1b[…m` (color open/close, resets, styles…). */
const CSI_SGR = /\x1b\[([0-9;]*)m/g;
/** Foreground RGB: `38;2;R;G;B`. */
const FG_RGB = /^38;2;(\d{1,3});(\d{1,3});(\d{1,3})$/;

/**
 * Convert one line of natives output — plain text interleaved with
 * `\x1b[38;2;R;G;Bm` … `\x1b[39m` segments — into escaped HTML spans.
 *
 * The highlighter keeps newlines token-internal (e.g. a comment's closing
 * reset lands on the next line), so lines are parsed standalone: an unclosed
 * color auto-closes at end of line, a stray reset with no open span is a
 * no-op, and the split token re-opens on the following line.
 */
export function ansiLineToHtml(line: string): string {
	const parts: string[] = [];
	let last = 0;
	let open = false;
	for (const match of line.matchAll(CSI_SGR)) {
		const idx = match.index;
		if (idx > last) parts.push(escapeHtml(line.slice(last, idx)));
		const rgb = FG_RGB.exec(match[1]);
		if (rgb) {
			if (open) parts.push("</span>");
			parts.push(`<span style="color:rgb(${rgb[1]},${rgb[2]},${rgb[3]})">`);
			open = true;
		} else if (open) {
			parts.push("</span>");
			open = false;
		}
		last = idx + match[0].length;
	}
	if (last < line.length) parts.push(escapeHtml(line.slice(last)));
	if (open) parts.push("</span>");
	return parts.join("");
}

/**
 * Convert natives output (ANSI-colored lines) into the same inner-HTML shape
 * the plain code renderer emits: one `.tr-code-line` span per line, trailing
 * newline preserved, so line numbers and wrapping CSS keep working.
 *
 * The line's token spans are wrapped in a `.tr-code-line-content` element
 * (openchamber parity): the line-numbers grid `.tr-code-line {
 * grid-template-columns: 2.2em minmax(0, 1fr) }` would otherwise make EVERY
 * token span a separate grid item and stack them one per row.
 */
export function highlightToCodeHtml(ansiOutput: string): string {
	const trimmed = ansiOutput.endsWith("\n") ? ansiOutput.slice(0, -1) : ansiOutput;
	return `${trimmed
		.split("\n")
		.map(line => `<span class="tr-code-line"><span class="tr-code-line-content">${ansiLineToHtml(line)}</span></span>`)
		.join("\n")}\n`;
}
