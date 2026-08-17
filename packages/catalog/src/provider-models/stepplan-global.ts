import type { ModelManagerOptions } from "../model-manager";
import type { getBundledModels } from "../models";
import type { FetchImpl } from "../types";
import { createSimpleOpenAICompletionsOptions } from "./openai-compat";

// International Step Plan endpoint — https://platform.stepfun.ai. Mainland
// China uses the separate `stepplan` provider factory.
const STEPPLAN_GLOBAL_BASE_URL = "https://api.stepfun.ai/step_plan/v1";

export interface StepPlanGlobalModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function stepplanGlobalModelManagerOptions(
	config?: StepPlanGlobalModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions(
		"stepplan-global" as Parameters<typeof getBundledModels>[0],
		config?.baseUrl ?? STEPPLAN_GLOBAL_BASE_URL,
		config,
	);
}
