import type { ModelManagerOptions } from "../model-manager";
import type { getBundledModels } from "../models";
import type { FetchImpl } from "../types";
import { createSimpleOpenAICompletionsOptions } from "./openai-compat";

// China (mainland) Step Plan endpoint — https://platform.stepfun.com. The
// international Step Plan lives under `stepplan-global`.
const STEPPLAN_BASE_URL = "https://api.stepfun.com/step_plan/v1";

export interface StepPlanModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function stepplanModelManagerOptions(
	config?: StepPlanModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions(
		"stepplan" as Parameters<typeof getBundledModels>[0],
		config?.baseUrl ?? STEPPLAN_BASE_URL,
		config,
	);
}
