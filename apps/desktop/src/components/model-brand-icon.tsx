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
import { useBrandIconStyle } from "../lib/brand-icon-style";
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
	const style = useBrandIconStyle();
	const pair = brandFor(provider, modelId);
	const BrandIcon = style === "color" ? (pair?.color ?? pair?.mono) : pair?.mono;
	if (BrandIcon) return <BrandIcon size={size} className="flex-shrink-0" />;
	return <Icon name="ai-agent" className="flex-shrink-0" style={{ width: size, height: size }} />;
}

type BrandComponent = (props: { size?: number; className?: string }) => ReactNode;
interface BrandPair {
	mono: BrandComponent;
	color?: BrandComponent;
}

/** A default deep import is the Mono component; `.Color` is on the same function. */
function pair(component: unknown): BrandPair {
	const mono = component as BrandComponent;
	const colour = (component as { Color?: unknown }).Color;
	return colour ? { mono, color: colour as BrandComponent } : { mono };
}

/** Map a provider (or model id) to a Lobe Icons brand component, or null. */
function brandFor(provider: string, modelId: string): BrandPair | null {
	// 1. Exact provider name match
	const exact = PROVIDER_MAP.get(provider.toLowerCase().trim());
	if (exact) return exact;

	// 2. Fallback: match by model id patterns (custom providers, bare SKUs)
	const model = modelId.toLowerCase();
	if (model.includes("claude")) return pair(Claude);
	if (model.includes("gpt") || model.includes("o1") || model.includes("o3") || model.includes("o4"))
		return pair(OpenAI);
	if (model.includes("gemini")) return pair(Gemini);
	if (model.includes("grok")) return pair(Grok);
	if (model.includes("deepseek")) return pair(DeepSeek);
	if (model.includes("qwen") || model.includes("qwq") || model.includes("qvq")) return pair(Qwen);
	// kimi-code serves bare SKUs (`k3`, `k3-256k`) with no family token in the id.
	if (model.includes("kimi") || model.includes("moonshot") || /^k[23](?:\.\d)?(?:-|$)/.test(model)) return pair(Kimi);
	if (model.includes("glm")) return pair(Zhipu);
	if (/^step[-_.]/.test(model)) return pair(Stepfun);
	if (model.includes("minimax") || model.includes("abab")) return pair(Minimax);
	if (model.includes("mimo")) return pair(XiaomiMiMo);
	if (model.includes("hunyuan") || model.includes("hy3")) return pair(Hunyuan);
	if (model.includes("llama")) return pair(Meta);
	if (
		model.includes("mistral") ||
		model.includes("mixtral") ||
		model.includes("codestral") ||
		model.includes("magistral") ||
		model.includes("devstral") ||
		model.includes("pixtral")
	)
		return pair(Mistral);
	if (model.includes("doubao")) return pair(Doubao);
	if (model.includes("ernie") || model.includes("wenxin")) return pair(Wenxin);
	if (/(^|[/_])yi[-_.]/.test(model)) return pair(Yi);
	if (model.includes("internlm")) return pair(InternLM);
	if (model.includes("sensenova")) return pair(SenseNova);
	if (model.includes("cohere") || /(^|[/_])command[-_.+]/.test(model)) return pair(Cohere);
	if (model.includes("nemotron")) return pair(Nvidia);
	if (/(^|[/_])phi[-_.]/.test(model)) return pair(Microsoft);
	if (/(^|[/_])solar[-_.]/.test(model)) return pair(Upstage);

	return null;
}

const PROVIDER_MAP = new Map<string, BrandPair>([
	["agnes", pair(AgnesAI)],
	["agnes-global", pair(AgnesAI)],
	["alibaba", pair(Alibaba)],
	["alibaba-coding-plan", pair(Alibaba)],
	["alibaba-token-plan", pair(Alibaba)],
	["amazon-bedrock", pair(Bedrock)],
	["anthropic", pair(Anthropic)],
	["azure", pair(Azure)],
	["baseten", pair(Baseten)],
	["bedrock-mantle", pair(Bedrock)],
	["cerebras", pair(Cerebras)],
	["claude", pair(Claude)],
	["cloudflare-ai-gateway", pair(Cloudflare)],
	["cursor", pair(Cursor)],
	["deepseek", pair(DeepSeek)],
	["devin", pair(Devin)],
	["doubao", pair(Doubao)],
	["fireworks", pair(Fireworks)],
	["gemini", pair(Gemini)],
	["github-copilot", pair(GithubCopilot)],
	["gmi-cloud", pair(GmiCloud)],
	["google", pair(Google)],
	["google-antigravity", pair(Google)],
	["google-gemini-cli", pair(GeminiCLI)],
	["google-vertex", pair(VertexAI)],
	["grok", pair(Grok)],
	["groq", pair(Groq)],
	["huggingface", pair(HuggingFace)],
	["hunyuan", pair(Hunyuan)],
	["kilo", pair(KiloCode)],
	["kimi", pair(Kimi)],
	["kimi-code", pair(Kimi)],
	["meta", pair(Meta)],
	["minimax", pair(Minimax)],
	["minimax-cn", pair(Minimax)],
	["minimax-code", pair(Minimax)],
	["minimax-code-cn", pair(Minimax)],
	["mistral", pair(Mistral)],
	["moonshot", pair(Moonshot)],
	["novita", pair(Novita)],
	["nvidia", pair(Nvidia)],
	["ollama", pair(Ollama)],
	["ollama-cloud", pair(Ollama)],
	["openai", pair(OpenAI)],
	["openai-codex", pair(OpenAI)],
	["opencode", pair(OpenCode)],
	["opencode-go", pair(OpenCode)],
	["opencode-zen", pair(OpenCode)],
	["openrouter", pair(OpenRouter)],
	["perplexity", pair(Perplexity)],
	["qianfan", pair(BaiduCloud)],
	["qwen", pair(Qwen)],
	["qwen-portal", pair(Qwen)],
	["sakana", pair(Sakana)],
	["siliconcloud", pair(SiliconCloud)],
	["siliconflow", pair(SiliconCloud)],
	["spark", pair(Spark)],
	["stepplan", pair(Stepfun)],
	["stepplan-global", pair(Stepfun)],
	["together", pair(Together)],
	["venice", pair(Venice)],
	["vercel-ai-gateway", pair(Vercel)],
	["vertexai", pair(VertexAI)],
	["volcengine", pair(Volcengine)],
	["wafer-serverless", pair(Wafer)],
	["xai", pair(XAI)],
	["xai-oauth", pair(XAI)],
	["xiaomi", pair(XiaomiMiMo)],
	["xiaomi-token-plan-ams", pair(XiaomiMiMo)],
	["xiaomi-token-plan-cn", pair(XiaomiMiMo)],
	["xiaomi-token-plan-sgp", pair(XiaomiMiMo)],
	["zai", pair(Zhipu)],
	["zenmux", pair(ZenMux)],
	["zhipu", pair(Zhipu)],
	["zhipu-coding-plan", pair(Zhipu)],
]);
