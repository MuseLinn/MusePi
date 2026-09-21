/** Markdown link targets that are local file paths (`[x](/a/b.ts)`,
 *  `[x](./rel.md)`, `[x](~/note.md)`, `file://…`) rather than web URLs. */
export function isLocalFilePath(href: string): boolean {
	if (/^(https?:|mailto:|data:|blob:|javascript:)/i.test(href)) return false;
	if (href.startsWith("file://")) return true;
	if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return false; // any other scheme
	if (href.startsWith("/") || href.startsWith("~/")) return true;
	if (/^\.{1,2}\//.test(href)) return true;
	// Scheme-less relative: a slash or a code/plain-text extension.
	return (
		href.includes("/") || /\.(ts|tsx|js|jsx|json|md|toml|ya?ml|css|html?|py|rs|go|c|h|cpp|sh|txt|log)$/i.test(href)
	);
}
