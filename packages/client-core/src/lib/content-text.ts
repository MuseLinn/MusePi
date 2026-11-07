/** Text of a wire content payload (string or text blocks). */
export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is { type: "text"; text: string } => typeof b === "object" && b !== null && b.type === "text")
		.map(b => b.text)
		.join(" ");
}
