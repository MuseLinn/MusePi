import Alibaba from "@lobehub/icons/es/Alibaba";
import Anthropic from "@lobehub/icons/es/Anthropic";
import Claude from "@lobehub/icons/es/Claude";
import DeepSeek from "@lobehub/icons/es/DeepSeek";
import Doubao from "@lobehub/icons/es/Doubao";
import Gemini from "@lobehub/icons/es/Gemini";
import Google from "@lobehub/icons/es/Google";
import Grok from "@lobehub/icons/es/Grok";
import Groq from "@lobehub/icons/es/Groq";
import Hunyuan from "@lobehub/icons/es/Hunyuan";
import Kimi from "@lobehub/icons/es/Kimi";
import Meta from "@lobehub/icons/es/Meta";
import Mistral from "@lobehub/icons/es/Mistral";
import Moonshot from "@lobehub/icons/es/Moonshot";
import Ollama from "@lobehub/icons/es/Ollama";
import OpenAI from "@lobehub/icons/es/OpenAI";
import OpenRouter from "@lobehub/icons/es/OpenRouter";
import Perplexity from "@lobehub/icons/es/Perplexity";
import Qwen from "@lobehub/icons/es/Qwen";
import Spark from "@lobehub/icons/es/Spark";
import Together from "@lobehub/icons/es/Together";
import VertexAI from "@lobehub/icons/es/VertexAI";
import XAI from "@lobehub/icons/es/XAI";
import Zhipu from "@lobehub/icons/es/Zhipu";
import type { ReactNode } from "react";
import { Icon } from "../vendor/oc-icons";

/**
 * Provider → Lobe Icons brand component mapping. Renders the brand logo
 * (Mono variant) for known providers, or a fallback oc-icons `ai-agent`
 * icon when the provider is unknown. Used in the model selector capsule
 * segment and the model menu rows.
 *
 * @param provider - The WireModel.provider string (e.g. "openai", "opencode-go").
 * @param modelId - The WireModel.id string; used as a secondary match when the
 *                  provider is not in the known map.
 * @param size - Icon size in px (default 14).
 */
export function ModelBrandIcon({
	provider,
	modelId,
	size = 14,
}: {
	provider: string;
	modelId: string;
	size?: number;
}): ReactNode {
	const BrandIcon = brandFor(provider, modelId);
	if (BrandIcon) return <BrandIcon size={size} className="flex-shrink-0" />;
	return <Icon name="ai-agent" className="flex-shrink-0" style={{ width: size, height: size }} />;
}

/** Map a provider (or model id) to a Lobe Icons brand component, or null. */
function brandFor(
	provider: string,
	modelId: string,
): ((props: { size?: number; className?: string }) => ReactNode) | null {
	// 1. Exact provider name match
	const exact = PROVIDER_MAP.get(provider.toLowerCase().trim());
	if (exact) return exact as (props: { size?: number; className?: string }) => ReactNode;

	// 2. Fallback: match by model id patterns
	const model = modelId.toLowerCase();
	if (model.includes("deepseek"))
		return DeepSeek as unknown as (props: { size?: number; className?: string }) => ReactNode;
	if (model.includes("gpt") || model.includes("o1") || model.includes("o3"))
		return OpenAI as unknown as (props: { size?: number; className?: string }) => ReactNode;
	if (model.includes("claude"))
		return Claude as unknown as (props: { size?: number; className?: string }) => ReactNode;
	if (model.includes("gemini"))
		return Gemini as unknown as (props: { size?: number; className?: string }) => ReactNode;
	if (model.includes("grok")) return Grok as unknown as (props: { size?: number; className?: string }) => ReactNode;
	if (model.includes("qwen")) return Qwen as unknown as (props: { size?: number; className?: string }) => ReactNode;
	if (model.includes("kimi") || model.includes("moonshot"))
		return Kimi as unknown as (props: { size?: number; className?: string }) => ReactNode;

	return null;
}

const PROVIDER_MAP = new Map<string, unknown>([
	["openai", OpenAI],
	["anthropic", Anthropic],
	["claude", Claude],
	["deepseek", DeepSeek],
	["google", Google],
	["gemini", Gemini],
	["xai", XAI],
	["grok", Grok],
	["meta", Meta],
	["mistral", Mistral],
	["qwen", Qwen],
	["kimi", Kimi],
	["moonshot", Moonshot],
	["zhipu", Zhipu],
	["ollama", Ollama],
	["groq", Groq],
	["together", Together],
	["openrouter", OpenRouter],
	["perplexity", Perplexity],
	["hunyuan", Hunyuan],
	["spark", Spark],
	["doubao", Doubao],
	["vertexai", VertexAI],
	["alibaba", Alibaba],
]);
