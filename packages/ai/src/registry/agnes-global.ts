import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

// International Agnes endpoint — https://agnes-ai.com (official gateway docs,
// `https://apihub.agnes-ai.com/v1`). Mainland China uses the separate `agnes`
// provider on https://api.agnes-ai.cn/v1.
const AGNES_GLOBAL_BASE_URL = "https://apihub.agnes-ai.com/v1";

export const loginAgnesGlobal = createApiKeyLogin({
	providerLabel: "Agnes (Global)",
	authUrl: "https://platform.agnes-ai.com/",
	instructions: "Create or copy your Agnes API key from the Sapiens AI platform (https://platform.agnes-ai.com)",
	promptMessage: "Paste your Agnes API key",
	placeholder: "sk-...",
	validation: {
		kind: "chat-completions",
		provider: "Agnes (Global)",
		baseUrl: AGNES_GLOBAL_BASE_URL,
		model: "agnes-2.5-flash",
	},
});

export const agnesGlobalProvider = {
	id: "agnes-global",
	name: "Sapiens AI (Agnes) (Global)",
	envKeys: "AGNES_GLOBAL_API_KEY",
	login: (cb: OAuthLoginCallbacks) => loginAgnesGlobal(cb),
} as const satisfies ProviderDefinition;
