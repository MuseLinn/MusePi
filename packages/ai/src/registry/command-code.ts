import * as AIError from "../error";
import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const innerLogin = createApiKeyLogin({
	providerLabel: "Command Code",
	authUrl: "https://commandcode.ai",
	instructions: "Copy your Command Code goat subscription API key from the dashboard",
	promptMessage: "Paste your Command Code API key",
	placeholder: "user_...",
	validation: {
		kind: "models-endpoint",
		provider: "command-code",
		modelsUrl: "https://api.commandcode.ai/provider/v1/models",
	},
});

export function normalizeCommandCodeApiKey(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) {
		return trimmed;
	}
	const stripped = trimmed.replace(/^bearer\b\s*/i, "");
	if (!stripped) {
		throw new AIError.ApiKeyRequiredError("Command Code API key is empty after stripping Bearer prefix");
	}
	return stripped;
}

export const loginCommandCode = async (options: OAuthLoginCallbacks): Promise<string> => {
	const userOnPrompt = options.onPrompt;
	const wrapped = userOnPrompt
		? {
				...options,
				onPrompt: async (prompt: { message: string; placeholder?: string }) =>
					normalizeCommandCodeApiKey(await userOnPrompt(prompt)),
			}
		: options;
	return innerLogin(wrapped);
};

export const commandCodeProvider = {
	id: "command-code",
	name: "Command Code",
	login: (cb: OAuthLoginCallbacks) => loginCommandCode(cb),
} as const satisfies ProviderDefinition;
