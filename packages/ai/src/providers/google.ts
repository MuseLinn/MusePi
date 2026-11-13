import * as AIError from "../error";
import { getEnvApiKey } from "../stream";
import type { Context, Model, StreamFunction } from "../types";
import type { AssistantMessageEventStream } from "../utils/event-stream";
import {
	buildGoogleGenerateContentParams,
	type GoogleGenAIRequestPlan,
	type GoogleSharedStreamOptions,
	streamGoogleGenAI,
} from "./google-shared";
import { applyOpenCodeSessionHeader, getOpenCodeSessionAffinity } from "./openai-shared";

export type GoogleOptions = GoogleSharedStreamOptions;

const DEFAULT_GENERATIVE_LANGUAGE_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GENERATIVE_LANGUAGE_API_VERSION = "v1beta";
/** `/v1`, `/v1beta`, `/v1beta1` — the segment the SDK appends itself. */
const VERSION_SEGMENT = /\/v\d+(?:beta\d*)?$/i;

/**
 * Ensure a custom Generative Language base URL carries exactly one API
 * version segment. Registries commonly publish `…/v1beta`, while a proxy
 * may publish only its host; both must end up at `…/v1beta/models/…`.
 */
function normalizeGenerativeLanguageBase(baseUrl: string | undefined): string {
	const trimmed = baseUrl?.trim().replace(/\/+$/, "") ?? "";
	if (trimmed === "") return DEFAULT_GENERATIVE_LANGUAGE_BASE;
	return VERSION_SEGMENT.test(trimmed) ? trimmed : `${trimmed}/${GENERATIVE_LANGUAGE_API_VERSION}`;
}

export const streamGoogle: StreamFunction<"google-generative-ai"> = (
	model: Model<"google-generative-ai">,
	context: Context,
	options?: GoogleOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new AIError.MissingApiKeyError(
			undefined,
			"Google Generative AI requires an API key (GEMINI_API_KEY or options.apiKey).",
		);
	}

	return streamGoogleGenAI({
		model,
		options,
		api: "google-generative-ai",
		prepare: (): GoogleGenAIRequestPlan => {
			const params = buildGoogleGenerateContentParams(model, context, options ?? {});
			// Normalize the custom base so it carries exactly one API version
			// segment; the request path appends `/models/...` itself.
			const base = normalizeGenerativeLanguageBase(model.baseUrl);
			const url = `${base}/models/${model.id}:streamGenerateContent?alt=sse`;
			const headers: Record<string, string> = {
				"x-goog-api-key": apiKey,
				...(model.headers ?? {}),
				...(options?.headers ?? {}),
			};
			applyOpenCodeSessionHeader(headers, model.provider, getOpenCodeSessionAffinity(options));
			return { params, url, headers, fetch: options?.fetch };
		},
	});
};
