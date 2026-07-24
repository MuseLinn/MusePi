import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/api/openai-completions.ts";
import { getModel } from "../src/compat.ts";
import type {
	AssistantMessage,
	Context,
	Model,
	OpenAICompletionsCompat,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "../src/types.ts";

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const compat: Omit<Required<OpenAICompletionsCompat>, "deferredToolsMode"> & {
	deferredToolsMode?: OpenAICompletionsCompat["deferredToolsMode"];
} = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	chatTemplateKwargs: {},
	zaiToolStream: false,
	supportsStrictMode: true,
	cacheControlFormat: "anthropic",
	sendSessionAffinityHeaders: false,
	supportsOpenAIGrammarTools: true,
	sessionAffinityFormat: "openai",
	supportsLongCacheRetention: true,
};

function videoModel(): Model<"openai-completions"> {
	const { compat: _compat, ...baseModel } = getModel("moonshotai", "kimi-k3");
	return { ...baseModel, api: "openai-completions" };
}

function nonVideoModel(): Model<"openai-completions"> {
	const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
	return { ...baseModel, api: "openai-completions", input: ["text", "image"] };
}

function buildAssistant(now: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "clip.mp4" } }],
		api: "openai-completions",
		provider: "moonshotai",
		model: "kimi-k3",
		usage: emptyUsage,
		stopReason: "toolUse",
		timestamp: now,
	};
}

function buildVideoToolResult(toolCallId: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [
			{ type: "text", text: "Read video file [video/mp4]" },
			{ type: "video", data: "ZmFrZQ==", mimeType: "video/mp4" },
		],
		isError: false,
		timestamp,
	};
}

describe("openai-completions video conversion", () => {
	it("declares video input for moonshotai kimi-k3", () => {
		const model = getModel("moonshotai", "kimi-k3");
		expect(model.input).toContain("video");
	});

	it("converts user-message video blocks to video_url parts", () => {
		const now = Date.now();
		const user: UserMessage = {
			role: "user",
			content: [
				{ type: "text", text: "What happens in this clip?" },
				{ type: "video", data: "ZmFrZQ==", mimeType: "video/mp4" },
			],
			timestamp: now,
		};

		const messages = convertMessages(videoModel(), { messages: [user] }, compat);
		expect(messages.length).toBe(1);
		const content = messages[0].content as Array<{ type?: string; video_url?: { url: string } }>;
		expect(Array.isArray(content)).toBe(true);
		const videoPart = content.find((part) => part?.type === "video_url");
		expect(videoPart).toBeTruthy();
		expect(videoPart?.video_url?.url).toBe("data:video/mp4;base64,ZmFrZQ==");
	});

	it("batches tool-result videos into a trailing user message", () => {
		const now = Date.now();
		const context: Context = {
			messages: [
				{ role: "user", content: "Read the clip", timestamp: now - 1 },
				buildAssistant(now),
				buildVideoToolResult("tool-1", now + 1),
			],
		};

		const messages = convertMessages(videoModel(), context, compat);
		const roles = messages.map((message) => message.role);
		expect(roles).toEqual(["user", "assistant", "tool", "user"]);

		const toolMessage = messages[2] as { role: "tool"; content: string };
		expect(toolMessage.content).toContain("Read video file [video/mp4]");

		const mediaMessage = messages[messages.length - 1];
		const content = mediaMessage.content as Array<{ type?: string; text?: string; video_url?: { url: string } }>;
		expect(content[0]?.text).toBe("Attached video(s) from tool result:");
		const videoParts = content.filter((part) => part?.type === "video_url");
		expect(videoParts.length).toBe(1);
		expect(videoParts[0]?.video_url?.url).toBe("data:video/mp4;base64,ZmFrZQ==");
	});

	it("uses '(see attached video)' for video-only tool results", () => {
		const now = Date.now();
		const videoOnlyResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "tool-1",
			toolName: "read",
			content: [{ type: "video", data: "ZmFrZQ==", mimeType: "video/mp4" }],
			isError: false,
			timestamp: now + 1,
		};
		const context: Context = {
			messages: [
				{ role: "user", content: "Read the clip", timestamp: now - 1 },
				buildAssistant(now),
				videoOnlyResult,
			],
		};

		const messages = convertMessages(videoModel(), context, compat);
		const toolMessage = messages.find((m) => m.role === "tool") as { role: "tool"; content: string } | undefined;
		expect(toolMessage?.content).toBe("(see attached video)");
	});

	it("downgrades videos to a placeholder for models without video input", () => {
		const now = Date.now();
		const user: UserMessage = {
			role: "user",
			content: [
				{ type: "text", text: "Watch this" },
				{ type: "video", data: "ZmFrZQ==", mimeType: "video/mp4" },
			],
			timestamp: now,
		};

		const messages = convertMessages(nonVideoModel(), { messages: [user] }, compat);
		const content = messages[0].content as Array<{ type?: string; text?: string }>;
		expect(content.some((part) => part?.type === "video_url")).toBe(false);
		expect(content.some((part) => part?.text === "(video omitted: model does not support videos)")).toBe(true);
	});

	it("downgrades tool-result videos to a placeholder for models without video input", () => {
		const now = Date.now();
		const context: Context = {
			messages: [
				{ role: "user", content: "Read the clip", timestamp: now - 1 },
				buildAssistant(now),
				buildVideoToolResult("tool-1", now + 1),
			],
		};

		const messages = convertMessages(nonVideoModel(), context, compat);
		const serialized = JSON.stringify(messages);
		expect(serialized).not.toContain("video_url");
		expect(serialized).toContain("(tool video omitted: model does not support videos)");
	});
});
