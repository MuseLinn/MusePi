import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

// China (mainland) Step Plan endpoint — https://platform.stepfun.com. The
// international Step Plan lives under the separate `stepplan-global` provider.
const STEPPLAN_BASE_URL = "https://api.stepfun.com/step_plan/v1";

export const loginStepPlan = createApiKeyLogin({
	providerLabel: "StepPlan (CN)",
	authUrl: "https://platform.stepfun.com/interface-key",
	instructions:
		"Create or copy your StepPlan API key from the StepFun Open Platform (https://platform.stepfun.com/interface-key)",
	promptMessage: "Paste your StepPlan API key",
	placeholder: "sk-...",
	validation: {
		kind: "chat-completions",
		provider: "StepPlan (CN)",
		baseUrl: STEPPLAN_BASE_URL,
		model: "step-3.7-flash",
	},
});

export const stepplanProvider = {
	id: "stepplan",
	name: "StepFun StepPlan（中国版）",
	envKeys: "STEPPLAN_API_KEY",
	login: (cb: OAuthLoginCallbacks) => loginStepPlan(cb),
} as const satisfies ProviderDefinition;
