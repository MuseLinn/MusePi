import type { Api, Model, ModelSpec, RemoteCompactionConfig } from "@musepi/pi-ai/types";
import { buildModel } from "@musepi/pi-catalog/build";
import {
	getBundledModelReferenceIndex,
	inheritReferenceThinking,
	resolveModelReference,
} from "@musepi/pi-catalog/identity";
import { getBundledModelsDevCapabilities } from "@musepi/pi-catalog/models";
import { getCachedModelsDevPayload } from "@musepi/pi-catalog/provider-models/openai-compat";
import { getVariantAliasSources, resolveVariantAlias } from "@musepi/pi-catalog/variant-collapse";
import { logger } from "@musepi/pi-utils";
import { createLiveConfigHeaders, type HeaderSource } from "./model-config-values";
import { type ModelPatch, mergeCompat, mergeRemoteCompactionConfig } from "./model-patch";
import { parseModelString } from "./model-resolver";
import type { ModelOverride, ProviderAuthMode } from "./models-config-schema";
export interface CustomModelDefinitionLike extends ModelPatch {
	id: string;
	api?: Api;
	baseUrl?: string;
	cost?: Model<Api>["cost"];
}

export interface CustomModelBuildOptions {
	useDefaults: boolean;
}

export interface CustomModelOverlay extends ModelPatch {
	id: string;
	provider: string;
	api: Api;
	baseUrl: string;
	cost?: Model<Api>["cost"];
	isOAuth?: boolean;
}

/** models.dev model row shape (stencil.so catalog) — the subset custom-model
 * capability fallback reads. */
interface ModelsDevCatalogModel {
	name?: unknown;
	reasoning?: unknown;
	modalities?: { input?: unknown };
	limit?: { context?: unknown; output?: unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPositiveNumber(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
	return value;
}

/**
 * Build a global id → capability index from the in-process models.dev payload
 * (stencil.so). The payload groups models by provider; a model id can appear
 * under several providers (e.g. `deepseek-v4-flash-vision-exp` under
 * opencode-go/opencode-zen), so the index keeps the richest row — largest
 * context window, then image/video input. This gives a custom models.yml
 * entry (b-ai, a proxy, a private gateway) the same base capabilities the
 * bundled catalog would provide when the id IS bundled, without requiring the
 * custom provider to be known to models.dev.
 *
 * The payload is only read when already fetched this process
 * (`getCachedModelsDevPayload`); it is never fetched on demand here because
 * models.yml parsing must stay synchronous and offline-safe. The daemon
 * pre-warms the models.dev fetch during registry bootstrap, so in practice the
 * cache is populated before the GUI renders the model list.
 */
let modelsDevGlobalCapabilities: Map<string, Model<Api>> | undefined;
/** Bundled offline gap snapshot (live-first fallback). Built once; NEVER set
 *  as the live index, so a later stencil.so fetch overrides it. */
let modelsDevSnapshot: Map<string, Model<Api>> | undefined;
function getModelsDevSnapshot(): Map<string, Model<Api>> {
	if (!modelsDevSnapshot) modelsDevSnapshot = getBundledModelsDevCapabilities();
	return modelsDevSnapshot;
}
export function getModelsDevGlobalCapabilities(): Map<string, Model<Api>> {
	if (modelsDevGlobalCapabilities) return modelsDevGlobalCapabilities;
	const payload = getCachedModelsDevPayload();
	const index = buildModelsDevGlobalCapabilities(payload);
	if (index.size === 0) {
		// Live stencil.so fetch not cached yet (startup race) or offline:
		// seed from the bundled gap snapshot so gateway-first custom ids keep
		// contextWindow/reasoning/input instead of degrading to 128K/false.
		// LIVE-FIRST: the fetch overwrites catalogSession later, and this
		// returned map is not cached here, so the next call builds the live
		// index and caches it.
		return getModelsDevSnapshot();
	}
	modelsDevGlobalCapabilities = index;
	return modelsDevGlobalCapabilities;
}

export function buildModelsDevGlobalCapabilities(payload: unknown): Map<string, Model<Api>> {
	const index = new Map<string, Model<Api>>();
	if (!isRecord(payload)) return index;
	for (const providerData of Object.values(payload)) {
		if (!isRecord(providerData) || !isRecord(providerData.models)) continue;
		for (const [id, raw] of Object.entries(providerData.models)) {
			if (!isRecord(raw)) continue;
			const model = raw as ModelsDevCatalogModel;
			const existing = index.get(id);
			const contextWindow = toPositiveNumber(model.limit?.context);
			const input = parseModelsDevInput(model.modalities?.input);
			const reasoning = model.reasoning === true;
			// Keep the richest row: larger context wins; on a tie, prefer one
			// that declares an extra modality; else first-seen.
			if (existing) {
				const existingWindow = existing.contextWindow ?? 0;
				const candidateWindow = contextWindow ?? 0;
				if (candidateWindow < existingWindow) continue;
				if (candidateWindow === existingWindow) {
					const existingModalities = existing.input.length;
					const candidateModalities = input.length;
					if (candidateModalities < existingModalities) continue;
					if (candidateModalities === existingModalities && !reasoning && existing.reasoning) continue;
				}
			}
			const name = typeof model.name === "string" && model.name.trim() ? model.name.trim() : id;
			const maxTokens = toPositiveNumber(model.limit?.output);
			index.set(
				id,
				buildModel({
					id,
					name,
					api: "openai-completions",
					provider: "custom",
					baseUrl: "custom://models-dev",
					reasoning,
					input,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow,
					...(maxTokens !== null ? { maxTokens } : {}),
				} as ModelSpec<Api>),
			);
		}
	}
	return index;
}

function parseModelsDevInput(value: unknown): ("text" | "image" | "video")[] {
	if (!Array.isArray(value)) return ["text"];
	const input: ("text" | "image" | "video")[] = ["text"];
	if (value.some(item => item === "image")) input.push("image");
	if (value.some(item => item === "video")) input.push("video");
	return input;
}

/**
 * Resolve a model id against models.dev when the bundled global index misses
 * it — the gateway-first custom-provider case (b-ai → deepseek-v4-flash-vision-exp).
 * Returns the richest same-id row, or undefined when models.dev is not cached
 * or does not declare the id.
 */
export function resolveModelsDevModelReference(modelId: string): Model<Api> | undefined {
	const capabilities = getModelsDevGlobalCapabilities();
	const reference = capabilities.get(modelId);
	if (reference) return reference;
	// Same shape-prefix fallback the bundled resolver applies (suffix aliases,
	// namespaced ids): drop `vendor/` prefixes and try the bare id.
	const slash = modelId.lastIndexOf("/");
	if (slash > 0) return capabilities.get(modelId.slice(slash + 1));
	return undefined;
}

function mergeCustomModelHeaders(
	providerHeaders: Record<string, string> | undefined,
	modelHeaders: Record<string, string> | undefined,
	authHeader: boolean | undefined,
	apiKeyConfig: string | undefined,
): Record<string, string> | undefined {
	return createLiveConfigHeaders([providerHeaders, modelHeaders], { authHeader, apiKeyConfig });
}

export function mergeAuthHeaderSources(
	sources: readonly HeaderSource[],
	authHeader: boolean | undefined,
	apiKeyConfig: string | undefined,
): Record<string, string> | undefined {
	return createLiveConfigHeaders(sources, { authHeader, apiKeyConfig });
}

/**
 * Decide whether a custom-yaml model should force OAuth-style request shaping.
 * - Explicit `auth: oauth` → force on.
 *   endpoints are typically Claude-Code-style proxies (e.g. CLIProxyAPI) that expect
 *   the cloaked request shape regardless of how the proxy itself is authenticated.
 * - Otherwise → unset.
 */
function resolveCustomModelIsOAuth(api: Api, providerAuth: ProviderAuthMode | undefined): boolean | undefined {
	if (providerAuth === "oauth") return true;
	if (providerAuth !== undefined) return undefined;
	if (api === "anthropic-messages") return true;
	return undefined;
}

export function buildCustomModelOverlay(
	providerName: string,
	providerBaseUrl: string,
	providerApi: Api | undefined,
	providerHeaders: Record<string, string> | undefined,
	providerApiKey: string | undefined,
	authHeader: boolean | undefined,
	providerCompat: ModelSpec<Api>["compat"] | undefined,
	providerAuth: ProviderAuthMode | undefined,
	providerRemoteCompaction: RemoteCompactionConfig<Api> | undefined,
	modelDef: CustomModelDefinitionLike,
): CustomModelOverlay | undefined {
	const api = modelDef.api ?? providerApi;
	if (!api) return undefined;
	return {
		id: modelDef.id,
		provider: providerName,
		api,
		baseUrl: modelDef.baseUrl ?? providerBaseUrl,
		name: modelDef.name,
		reasoning: modelDef.reasoning,
		thinking: modelDef.thinking,
		input: modelDef.input,
		imageInputDecoder: modelDef.imageInputDecoder,
		supportsTools: modelDef.supportsTools,
		cost: modelDef.cost,
		contextWindow: modelDef.contextWindow,
		maxTokens: modelDef.maxTokens,
		omitMaxOutputTokens: modelDef.omitMaxOutputTokens,
		headers: mergeCustomModelHeaders(providerHeaders, modelDef.headers, authHeader, providerApiKey),
		compat: mergeCompat(providerCompat, modelDef.compat),
		contextPromotionTarget: modelDef.contextPromotionTarget,
		compactionModel: modelDef.compactionModel,
		remoteCompaction: mergeRemoteCompactionConfig(providerRemoteCompaction, modelDef.remoteCompaction),
		premiumMultiplier: modelDef.premiumMultiplier,
		isOAuth: resolveCustomModelIsOAuth(api, providerAuth),
	};
}

function applyStandaloneCustomModelPolicies(model: CustomModelOverlay): CustomModelOverlay {
	if (model.id !== "gpt-5.4" || model.provider === "github-copilot" || model.contextWindow !== undefined) {
		return model;
	}
	return { ...model, contextWindow: 1_000_000 };
}

/**
 * Custom models (models.yml) carry no discovery metadata: the reference
 * resolve below fills contextWindow/input from the bundled global index when
 * the id is known there. For gateway-first ids that never land in `models.json`
 * (e.g. deepseek-v4-flash-vision-exp), infer the input modalities from the id
 * itself so the GUI model list still renders the text/image/video capability
 * icons — an explicit `input` in models.yml always wins over this guess.
 */
function inferCustomModelInputFromId(modelId: string): ("text" | "image" | "video")[] | undefined {
	const normalized = modelId.trim().toLowerCase();
	if (!normalized) return undefined;
	const input: ("text" | "image" | "video")[] = ["text"];
	const hasImage =
		/(^|[/:._-])vision(?:$|[/:._-])/.test(normalized) ||
		/(^|[/:._-])vl(?:$|[/:._-])/.test(normalized) ||
		/(^|[/:._-])vlm(?:$|[/:._-])/.test(normalized) ||
		/(^|[/:._-])multimodal(?:$|[/:._-])/.test(normalized) ||
		/(^|[/:._-])image(?:$|[/:._-])/.test(normalized);
	const hasVideo =
		/(^|[/:._-])video(?:$|[/:._-])/.test(normalized) ||
		/(^|[/:._-])veo(?:$|[/:._-])/.test(normalized) ||
		/(^|[/:._-])sora(?:$|[/:._-])/.test(normalized);
	if (hasImage) input.push("image");
	if (hasVideo) {
		if (!input.includes("image")) input.push("image"); // video-capable models read frames
		input.push("video");
	}
	// Nothing beyond the universal text capability → keep the default so a
	// bare chat id does not fabricate image/video support.
	return input.length > 1 || hasImage || hasVideo ? input : undefined;
}

export function finalizeCustomModel(model: CustomModelOverlay, options: CustomModelBuildOptions): Model<Api> {
	const resolvedModel = options.useDefaults ? applyStandaloneCustomModelPolicies(model) : model;
	const reference = options.useDefaults
		? resolveModelReference(resolvedModel.id, getBundledModelReferenceIndex())
		: undefined;
	// Gateway-first ids (deepseek-v4-flash-vision-exp, ox-alpha-free) are often
	// absent from the bundled models.json but declared on models.dev → inherit
	// contextWindow/input/maxTokens/reasoning from the cached catalog row when
	// the bundled lookup misses. Pricing and transport compat stay
	// provider-specific: they are never inherited across providers.
	const modelsDevReference =
		!reference && options.useDefaults ? resolveModelsDevModelReference(resolvedModel.id) : undefined;
	const capabilityReference = reference ?? modelsDevReference;
	const cost =
		resolvedModel.cost ??
		reference?.cost ??
		(options.useDefaults ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : undefined);
	const input =
		resolvedModel.input ??
		capabilityReference?.input ??
		(options.useDefaults ? (inferCustomModelInputFromId(resolvedModel.id) ?? ["text"]) : undefined);
	const supportsTools = resolvedModel.supportsTools ?? capacityReferenceSupportsTools(capabilityReference);
	return buildModel({
		id: resolvedModel.id,
		name: resolvedModel.name ?? (options.useDefaults ? resolvedModel.id : undefined),
		api: resolvedModel.api,
		provider: resolvedModel.provider,
		baseUrl: resolvedModel.baseUrl,
		reasoning: resolvedModel.reasoning ?? capabilityReference?.reasoning ?? (options.useDefaults ? false : undefined),
		thinking: inheritReferenceThinking(resolvedModel.thinking, capabilityReference, resolvedModel.provider),
		input: input as ("text" | "image" | "video")[],
		imageInputDecoder: resolvedModel.imageInputDecoder,
		...(supportsTools !== undefined ? { supportsTools } : {}),
		cost,
		contextWindow:
			resolvedModel.contextWindow ?? capabilityReference?.contextWindow ?? (options.useDefaults ? 128000 : null),
		maxTokens: resolvedModel.maxTokens ?? capabilityReference?.maxTokens ?? (options.useDefaults ? 16384 : null),
		headers: resolvedModel.headers,
		omitMaxOutputTokens: resolvedModel.omitMaxOutputTokens ?? reference?.omitMaxOutputTokens,
		compat: mergeCompat(reference?.compatConfig, resolvedModel.compat),
		contextPromotionTarget: resolvedModel.contextPromotionTarget,
		compactionModel: resolvedModel.compactionModel,
		remoteCompaction: resolvedModel.remoteCompaction,
		premiumMultiplier: resolvedModel.premiumMultiplier,
		isOAuth: resolvedModel.isOAuth,
	} as ModelSpec<Api>);
}

/** Bundled references carry `supportsTools`; models.dev rows do not model it. */
function capacityReferenceSupportsTools(reference: Model<Api> | undefined): boolean | undefined {
	return reference?.supportsTools;
}

export function normalizeSuppressedSelector(
	selector: string,
	hasLiveModel?: (provider: string, id: string) => boolean,
): string {
	const trimmed = selector.trim();
	if (!trimmed) return trimmed;
	const parsed = parseModelString(trimmed, {
		allowMaxSuffix: true,
		allowAutoAlias: true,
		isLiteralModelId: (provider, id) => hasLiveModel?.(provider, id) === true,
	});
	if (!parsed) return trimmed;
	// Retired effort-tier variant ids normalize to their collapsed logical id
	// so persisted suppressions keyed by raw member ids still bind.
	const aliasId = resolveVariantAlias(parsed.provider, parsed.id);
	return `${parsed.provider}/${aliasId ?? parsed.id}`;
}

/**
 * Look up a model's override, falling back to entries keyed by retired
 * effort-tier variant ids (models.yml authored before collapsing). A raw key
 * only re-binds when no live model holds that id.
 */
export function resolveModelOverrideWithAliases(
	overrides: Map<string, ModelOverride>,
	model: Model<Api>,
	hasLiveModel: (provider: string, id: string) => boolean,
): ModelOverride | undefined {
	const direct = overrides.get(model.id);
	if (direct) return direct;
	for (const rawId of getVariantAliasSources(model.provider, model.id)) {
		if (hasLiveModel(model.provider, rawId)) continue;
		const remapped = overrides.get(rawId);
		if (remapped) {
			logger.debug("model override re-keyed through variant alias", {
				provider: model.provider,
				from: rawId,
				to: model.id,
			});
			return remapped;
		}
	}
	return undefined;
}
