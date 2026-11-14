import AgnesAI from "@lobehub/icons/es/AgnesAI";
import Alibaba from "@lobehub/icons/es/Alibaba";
import Anthropic from "@lobehub/icons/es/Anthropic";
import Azure from "@lobehub/icons/es/Azure";
import BaiduCloud from "@lobehub/icons/es/BaiduCloud";
import Baseten from "@lobehub/icons/es/Baseten";
import Bedrock from "@lobehub/icons/es/Bedrock";
import Cerebras from "@lobehub/icons/es/Cerebras";
import Claude from "@lobehub/icons/es/Claude";
import Cloudflare from "@lobehub/icons/es/Cloudflare";
import Cohere from "@lobehub/icons/es/Cohere";
import Cursor from "@lobehub/icons/es/Cursor";
import DeepSeek from "@lobehub/icons/es/DeepSeek";
import Devin from "@lobehub/icons/es/Devin";
import Doubao from "@lobehub/icons/es/Doubao";
import Fireworks from "@lobehub/icons/es/Fireworks";
import Gemini from "@lobehub/icons/es/Gemini";
import GeminiCLI from "@lobehub/icons/es/GeminiCLI";
import GithubCopilot from "@lobehub/icons/es/GithubCopilot";
import GmiCloud from "@lobehub/icons/es/GmiCloud";
import Google from "@lobehub/icons/es/Google";
import Grok from "@lobehub/icons/es/Grok";
import Groq from "@lobehub/icons/es/Groq";
import HuggingFace from "@lobehub/icons/es/HuggingFace";
import Hunyuan from "@lobehub/icons/es/Hunyuan";
import InternLM from "@lobehub/icons/es/InternLM";
import KiloCode from "@lobehub/icons/es/KiloCode";
import Kimi from "@lobehub/icons/es/Kimi";
import Meta from "@lobehub/icons/es/Meta";
import Microsoft from "@lobehub/icons/es/Microsoft";
import Minimax from "@lobehub/icons/es/Minimax";
import Mistral from "@lobehub/icons/es/Mistral";
import Moonshot from "@lobehub/icons/es/Moonshot";
import Novita from "@lobehub/icons/es/Novita";
import Nvidia from "@lobehub/icons/es/Nvidia";
import Ollama from "@lobehub/icons/es/Ollama";
import OpenAI from "@lobehub/icons/es/OpenAI";
import OpenCode from "@lobehub/icons/es/OpenCode";
import OpenRouter from "@lobehub/icons/es/OpenRouter";
import Perplexity from "@lobehub/icons/es/Perplexity";
import Qwen from "@lobehub/icons/es/Qwen";
import Sakana from "@lobehub/icons/es/Sakana";
import SenseNova from "@lobehub/icons/es/SenseNova";
import SiliconCloud from "@lobehub/icons/es/SiliconCloud";
import Spark from "@lobehub/icons/es/Spark";
import Stepfun from "@lobehub/icons/es/Stepfun";
import Together from "@lobehub/icons/es/Together";
import Upstage from "@lobehub/icons/es/Upstage";
import Venice from "@lobehub/icons/es/Venice";
import Vercel from "@lobehub/icons/es/Vercel";
import VertexAI from "@lobehub/icons/es/VertexAI";
import Volcengine from "@lobehub/icons/es/Volcengine";
import Wafer from "@lobehub/icons/es/Wafer";
import Wenxin from "@lobehub/icons/es/Wenxin";
import XAI from "@lobehub/icons/es/XAI";
import XiaomiMiMo from "@lobehub/icons/es/XiaomiMiMo";
import Yi from "@lobehub/icons/es/Yi";
import ZenMux from "@lobehub/icons/es/ZenMux";
import Zhipu from "@lobehub/icons/es/Zhipu";
import type { ReactNode } from "react";
import { Icon } from "../vendor/oc-icons";

/**
 * Provider → Lobe Icons brand component mapping. Renders the brand logo
 * (Mono variant) for known providers, or a fallback oc-icons `ai-agent`
 * icon when the provider is unknown. Used in the model selector capsule
 * segment and the model menu rows.
 *
 * Resolution is two-layer: exact provider name first (covers every provider
 * in the bundled catalog that has a Lobe brand), then a model-id pattern
 * fallback so custom providers (models.yml) and bare SKUs that carry no
 * family token (e.g. kimi-code's `k3`/`k3-256k`) still resolve.
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

type BrandComponent = (props: { size?: number; className?: string }) => ReactNode;

const brand = (component: unknown): BrandComponent => component as BrandComponent;

/** Map a provider (or model id) to a Lobe Icons brand component, or null. */
function brandFor(provider: string, modelId: string): BrandComponent | null {
	// 1. Exact provider name match
	const exact = PROVIDER_MAP.get(provider.toLowerCase().trim());
	if (exact) return exact;

	// 2. Fallback: match by model id patterns (custom providers, bare SKUs)
	const model = modelId.toLowerCase();
	if (model.includes("claude")) return brand(Claude);
	if (model.includes("gpt") || model.includes("o1") || model.includes("o3") || model.includes("o4"))
		return brand(OpenAI);
	if (model.includes("gemini")) return brand(Gemini);
	if (model.includes("grok")) return brand(Grok);
	if (model.includes("deepseek")) return brand(DeepSeek);
	if (model.includes("qwen") || model.includes("qwq") || model.includes("qvq")) return brand(Qwen);
	// kimi-code serves bare SKUs (`k3`, `k3-256k`) with no family token in the id.
	if (model.includes("kimi") || model.includes("moonshot") || /^k[23](?:\.\d)?(?:-|$)/.test(model)) return brand(Kimi);
	if (model.includes("glm")) return brand(Zhipu);
	if (/^step[-_.]/.test(model)) return brand(Stepfun);
	if (model.includes("minimax") || model.includes("abab")) return brand(Minimax);
	if (model.includes("mimo")) return brand(XiaomiMiMo);
	if (model.includes("hunyuan") || model.includes("hy3")) return brand(Hunyuan);
	if (model.includes("llama")) return brand(Meta);
	if (
		model.includes("mistral") ||
		model.includes("mixtral") ||
		model.includes("codestral") ||
		model.includes("magistral") ||
		model.includes("devstral") ||
		model.includes("pixtral")
	)
		return brand(Mistral);
	if (model.includes("doubao")) return brand(Doubao);
	if (model.includes("ernie") || model.includes("wenxin")) return brand(Wenxin);
	if (/(^|[/_])yi[-_.]/.test(model)) return brand(Yi);
	if (model.includes("internlm")) return brand(InternLM);
	if (model.includes("sensenova")) return brand(SenseNova);
	if (model.includes("cohere") || /(^|[/_])command[-_.+]/.test(model)) return brand(Cohere);
	if (model.includes("nemotron")) return brand(Nvidia);
	if (/(^|[/_])phi[-_.]/.test(model)) return brand(Microsoft);
	if (/(^|[/_])solar[-_.]/.test(model)) return brand(Upstage);

	return null;
}

const PROVIDER_MAP = new Map<string, BrandComponent>([
	["agnes", brand(AgnesAI)],
	["agnes-global", brand(AgnesAI)],
	["alibaba", brand(Alibaba)],
	["alibaba-coding-plan", brand(Alibaba)],
	["alibaba-token-plan", brand(Alibaba)],
	["amazon-bedrock", brand(Bedrock)],
	["anthropic", brand(Anthropic)],
	["azure", brand(Azure)],
	["baseten", brand(Baseten)],
	["bedrock-mantle", brand(Bedrock)],
	["cerebras", brand(Cerebras)],
	["claude", brand(Claude)],
	["cloudflare-ai-gateway", brand(Cloudflare)],
	["cursor", brand(Cursor)],
	["deepseek", brand(DeepSeek)],
	["devin", brand(Devin)],
	["doubao", brand(Doubao)],
	["fireworks", brand(Fireworks)],
	["gemini", brand(Gemini)],
	["github-copilot", brand(GithubCopilot)],
	["gmi-cloud", brand(GmiCloud)],
	["google", brand(Google)],
	["google-antigravity", brand(Google)],
	["google-gemini-cli", brand(GeminiCLI)],
	["google-vertex", brand(VertexAI)],
	["grok", brand(Grok)],
	["groq", brand(Groq)],
	["huggingface", brand(HuggingFace)],
	["hunyuan", brand(Hunyuan)],
	["kilo", brand(KiloCode)],
	["kimi", brand(Kimi)],
	["kimi-code", brand(Kimi)],
	["meta", brand(Meta)],
	["minimax", brand(Minimax)],
	["minimax-cn", brand(Minimax)],
	["minimax-code", brand(Minimax)],
	["minimax-code-cn", brand(Minimax)],
	["mistral", brand(Mistral)],
	["moonshot", brand(Moonshot)],
	["novita", brand(Novita)],
	["nvidia", brand(Nvidia)],
	["ollama", brand(Ollama)],
	["ollama-cloud", brand(Ollama)],
	["openai", brand(OpenAI)],
	["openai-codex", brand(OpenAI)],
	["opencode", brand(OpenCode)],
	["opencode-go", brand(OpenCode)],
	["opencode-zen", brand(OpenCode)],
	["openrouter", brand(OpenRouter)],
	["perplexity", brand(Perplexity)],
	["qianfan", brand(BaiduCloud)],
	["qwen", brand(Qwen)],
	["qwen-portal", brand(Qwen)],
	["sakana", brand(Sakana)],
	["siliconcloud", brand(SiliconCloud)],
	["siliconflow", brand(SiliconCloud)],
	["spark", brand(Spark)],
	["stepplan", brand(Stepfun)],
	["stepplan-global", brand(Stepfun)],
	["together", brand(Together)],
	["venice", brand(Venice)],
	["vercel-ai-gateway", brand(Vercel)],
	["vertexai", brand(VertexAI)],
	["volcengine", brand(Volcengine)],
	["wafer-serverless", brand(Wafer)],
	["xai", brand(XAI)],
	["xai-oauth", brand(XAI)],
	["xiaomi", brand(XiaomiMiMo)],
	["xiaomi-token-plan-ams", brand(XiaomiMiMo)],
	["xiaomi-token-plan-cn", brand(XiaomiMiMo)],
	["xiaomi-token-plan-sgp", brand(XiaomiMiMo)],
	["zai", brand(Zhipu)],
	["zenmux", brand(ZenMux)],
	["zhipu", brand(Zhipu)],
	["zhipu-coding-plan", brand(Zhipu)],
]);
