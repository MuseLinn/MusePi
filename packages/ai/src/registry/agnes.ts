import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

// China (mainland) Agnes endpoint — https://www.agnes-ai.cn. The international
// platform lives under the separate `agnes-global` provider.
const AGNES_BASE_URL = "https://api.agnes-ai.cn/v1";

export const loginAgnes = createApiKeyLogin({
	providerLabel: "Agnes (CN)",
	authUrl: "https://platform.agnes-ai.cn/",
	instructions: "Create or copy your Agnes API key from the Sapiens AI platform (https://platform.agnes-ai.cn)",
	promptMessage: "Paste your Agnes API key",
	placeholder: "sk-...",
	validation: {
		kind: "chat-completions",
		provider: "Agnes (CN)",
		baseUrl: AGNES_BASE_URL,
		model: "agnes-2.5-flash",
	},
});

export const agnesProvider = {
	id: "agnes",
	name: "Sapiens AI (Agnes)（中国版）",
	login: (cb: OAuthLoginCallbacks) => loginAgnes(cb),
} as const satisfies ProviderDefinition;
