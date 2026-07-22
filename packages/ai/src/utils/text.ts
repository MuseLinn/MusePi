import type { ImageContent, TextContent, ThinkingContent, ToolCall, VideoContent } from "../types.ts";

type Content = TextContent | ImageContent | VideoContent | ThinkingContent | ToolCall;

/** Extract and join text from message content. */
export function contentText(content: string | readonly Content[], separator = "\n"): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join(separator);
}
