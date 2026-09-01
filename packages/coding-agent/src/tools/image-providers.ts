import type { MediaProviderConfig } from "../extensibility/extensions/types";

/**
 * Image Generation Providers
 *
 * Leaf module (no runtime deps) shared by the image_gen tool, the settings
 * schema, and settings migrations — mirrors `web/search/types.ts` so the
 * provider list, auto order, and settings choices never drift apart.
 */

/** Image generation backends, in settings/tool vocabulary. Builtin ids form
 *  the closed base union; extension-registered provider ids join the same
 *  string space at runtime (an `(string & {})` hole keeps builtin literals
 *  autocompleting while admitting extension ids). */
export type ImageProvider =
	| "agnes"
	| "agnes-global"
	| "antigravity"
	| "gemini"
	| "openai"
	| "openai-codex"
	| "openrouter"
	| "xai"
	| (string & {});

/** Auto-resolution fallback order when no configured entry or session provider matches. */
export const AUTO_IMAGE_PROVIDER_ORDER: readonly ImageProvider[] = [
	"agnes",
	"agnes-global",
	"openai",
	"openai-codex",
	"antigravity",
	"xai",
	"openrouter",
	"gemini",
];

/** Settings choices for `providers.imageOrder` (labels shared with the retired single-preference enum). */
export const IMAGE_PROVIDER_CHOICES = [
	{
		value: "agnes",
		label: "Agnes",
		description: "Requires AGNES_API_KEY",
	},
	{
		value: "agnes-global",
		label: "Agnes (Global)",
		description: "Requires AGNES_GLOBAL_API_KEY",
	},
	{
		value: "openai",
		label: "OpenAI",
		description: "OPENAI_API_KEY (gpt-image-2) or active GPT model; falls back to a connected Codex subscription",
	},
	{
		value: "openai-codex",
		label: "OpenAI Codex (ChatGPT)",
		description: "Uses a connected Codex / ChatGPT subscription — no OPENAI_API_KEY needed",
	},
	{
		value: "antigravity",
		label: "Antigravity",
		description: "Requires google-antigravity OAuth",
	},
	{
		value: "xai",
		label: "xAI Grok Imagine",
		description: "Requires xAI Grok OAuth or XAI_API_KEY",
	},
	{ value: "gemini", label: "Gemini", description: "Requires GEMINI_API_KEY" },
	{ value: "openrouter", label: "OpenRouter", description: "Requires OPENROUTER_API_KEY" },
] as const satisfies ReadonlyArray<{ value: ImageProvider; label: string; description: string }>;

export function isImageProviderId(value: unknown): value is ImageProvider {
	return typeof value === "string" && AUTO_IMAGE_PROVIDER_ORDER.includes(value as ImageProvider);
}

// ============================================================================
// Extension media provider registry
// ============================================================================

/**
 * Runtime registry of media generation providers contributed by extensions
 * (pi.registerMediaProvider). Built-in providers live in the closed union
 * above and never enter this map; ids that shadow a built-in are rejected at
 * registration so the tool's built-in dispatch stays authoritative.
 */
const extensionMediaProviders = new Map<string, { config: MediaProviderConfig; sourceId: string }>();

/** Register an extension media provider. Throws when the id shadows a built-in or an existing registration. */
export function registerExtensionMediaProvider(config: MediaProviderConfig, sourceId: string): void {
	if (isImageProviderId(config.id)) {
		throw new Error(`registerMediaProvider: id "${config.id}" collides with a built-in image provider`);
	}
	if (extensionMediaProviders.has(config.id)) {
		throw new Error(`registerMediaProvider: id "${config.id}" is already registered`);
	}
	extensionMediaProviders.set(config.id, { config, sourceId });
}

/** Remove one extension media provider registration. No-op when unknown. */
export function unregisterExtensionMediaProvider(id: string): void {
	extensionMediaProviders.delete(id);
}

/** Remove every extension media provider registered from one extension source. */
export function clearExtensionMediaProviders(sourceId: string): void {
	for (const [id, registration] of extensionMediaProviders) {
		if (registration.sourceId === sourceId) extensionMediaProviders.delete(id);
	}
}

/** All extension-registered media providers (registration order). */
export function getExtensionMediaProviders(): readonly MediaProviderConfig[] {
	return [...extensionMediaProviders.values()].map(registration => registration.config);
}

/** Look up one extension media provider by id. */
export function getExtensionMediaProvider(id: string): MediaProviderConfig | undefined {
	return extensionMediaProviders.get(id)?.config;
}
