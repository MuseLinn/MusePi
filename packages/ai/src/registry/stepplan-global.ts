import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

// International Step Plan endpoint — https://platform.stepfun.ai (Stripe
// billing, USD). Mainland China uses the separate `stepplan` provider.
const STEPPLAN_GLOBAL_BASE_URL = "https://api.stepfun.ai/step_plan/v1";

export const loginStepPlanGlobal = createApiKeyLogin({
	providerLabel: "StepPlan (Global)",
	authUrl: "https://platform.stepfun.ai/interface-key",
	instructions: "Create or copy your StepPlan API key from the StepFun API Platform (https://platform.stepfun.ai)",
	promptMessage: "Paste your StepPlan API key",
	placeholder: "sk-...",
	validation: {
		kind: "chat-completions",
		provider: "StepPlan (Global)",
		baseUrl: STEPPLAN_GLOBAL_BASE_URL,
		model: "step-3.7-flash",
	},
});

export const stepplanGlobalProvider = {
	id: "stepplan-global",
	name: "StepFun StepPlan (Global)",
	envKeys: "STEPPLAN_GLOBAL_API_KEY",
	login: (cb: OAuthLoginCallbacks) => loginStepPlanGlobal(cb),
} as const satisfies ProviderDefinition;
