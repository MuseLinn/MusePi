import type { ModelManagerOptions } from "../model-manager";
import type { getBundledModels } from "../models";
import type { FetchImpl } from "../types";
import { createSimpleOpenAICompletionsOptions } from "./openai-compat";

// International Agnes endpoint — https://agnes-ai.com. Mainland China uses the
// separate `agnes` provider factory on https://api.agnes-ai.cn/v1.
const AGNES_GLOBAL_BASE_URL = "https://apihub.agnes-ai.com/v1";

export interface AgnesGlobalModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function agnesGlobalModelManagerOptions(
	config?: AgnesGlobalModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions(
		"agnes-global" as Parameters<typeof getBundledModels>[0],
		config?.baseUrl ?? AGNES_GLOBAL_BASE_URL,
		config,
	);
}
