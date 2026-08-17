import type { ModelManagerOptions } from "../model-manager";
import type { getBundledModels } from "../models";
import type { FetchImpl } from "../types";
import { createSimpleOpenAICompletionsOptions } from "./openai-compat";

const AGNES_BASE_URL = "https://api.agnes-ai.cn/v1";

export interface AgnesModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function agnesModelManagerOptions(config?: AgnesModelManagerConfig): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions(
		"agnes" as Parameters<typeof getBundledModels>[0],
		config?.baseUrl ?? AGNES_BASE_URL,
		config,
	);
}
