import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProviderModels } from "@musepi/pi-catalog/model-manager";
import { PROVIDER_DESCRIPTORS } from "@musepi/pi-catalog/provider-models/descriptors";
import {
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	opencodeGoModelManagerOptions,
	opencodeZenModelManagerOptions,
} from "@musepi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@musepi/pi-catalog/types";

const MODELS_DEV_URL = "https://catalog.stencil.so/models.json.zstd";

const LIVE_FREE_MODEL_IDS = [
	"deepseek-v4-flash-free",
	"hy3-free",
	"mimo-v2.5-free",
	"nemotron-3-ultra-free",
	"north-mini-code-free",
] as const;

const LIVE_PAID_MODEL_IDS = ["claude-opus-4-8", "gpt-5.5"] as const;

function modelListResponse(ids: readonly string[]): Response {
	return Response.json({
		object: "list",
		data: ids.map(id => ({ id, object: "model", owned_by: "opencode" })),
	});
}

// A stencil.so payload carrying gateway-first vision ids that the bundled
// models.json does not cover. These rows declare their true modalities/limits
// on models.dev — exactly what the discovery mapper must hydrate on a bare
// `/v1/models` row.
function stencilOpenCodePayload(): Record<string, unknown> {
	return {
		"opencode-go": {
			models: {
				"deepseek-v4-flash-vision-exp": {
					id: "deepseek-v4-flash-vision-exp",
					name: "DeepSeek V4 Flash Vision (exp)",
					tool_call: true,
					reasoning: true,
					modalities: { input: ["text", "image"], output: ["text"] },
					limit: { context: 1000000, output: 384000 },
				},
				"ox-alpha-free": {
					id: "ox-alpha-free",
					name: "Ox Alpha Free",
					tool_call: true,
					reasoning: true,
					modalities: { input: ["text", "image", "video"], output: ["text"] },
					limit: { context: 1000000, output: 131072 },
				},
			},
		},
	};
}

function inputUrl(input: string | URL | Request): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

// Stub fetch: answer the stencil.so catalog with the vision payload but route
// the gateway /v1/models to the bare live rows. Stubbing MODELS_DEV_URL is the
// established convention (see issue-2883-moonshot-china.test.ts).
function openCodeStubbedFetch(): FetchImpl {
	return (async (input: string | URL | Request) => {
		const url = inputUrl(input);
		if (url === MODELS_DEV_URL) {
			return Response.json(stencilOpenCodePayload());
		}
		if (url === "https://opencode.ai/zen/go/v1/models") {
			return modelListResponse(["deepseek-v4-flash-vision-exp", "ox-alpha-free"]);
		}
		return new Response("", { status: 404 });
	}) as FetchImpl;
}

describe("OpenCode provider discovery", () => {
	test("treats the OpenCode model endpoints as authoritative catalogs", () => {
		for (const providerId of ["opencode-go", "opencode-zen"]) {
			const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === providerId);
			expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
		}
		expect(opencodeGoModelManagerOptions().dynamicModelsAuthoritative).toBe(true);
		expect(opencodeZenModelManagerOptions().dynamicModelsAuthoritative).toBe(true);
	});

	test("routes opencode-go deepseek-v4-flash to the responses API", () => {
		const descriptor = MODELS_DEV_PROVIDER_DESCRIPTORS.find(item => item.providerId === "opencode-go");
		// stencil.so lists deepseek-v4-flash without provider.npm, so it would
		// fall through to openai-completions — but the Go gateway does not serve
		// this model at /zen/go/v1/chat/completions while /zen/go/v1/responses
		// works (user-verified against the live gateway, 2026-08-08).
		expect(descriptor?.resolveApi?.("deepseek-v4-flash", { tool_call: true })).toEqual({
			api: "openai-responses",
			baseUrl: "https://opencode.ai/zen/go/v1",
		});
		// Flash only: deepseek-v4-pro serves fine on chat completions.
		expect(descriptor?.resolveApi?.("deepseek-v4-pro", { tool_call: true })).toEqual({
			api: "openai-completions",
			baseUrl: "https://opencode.ai/zen/go/v1",
		});
	});

	test("hydrates vision/context for gateway-first ids from models.dev", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-opencode-vision-"));
		try {
			const options = opencodeGoModelManagerOptions({
				apiKey: "vision-account-key",
				fetch: openCodeStubbedFetch(),
			});
			const result = await resolveProviderModels(
				{ ...options, cacheDbPath: path.join(tempDir, "models.db") },
				"online",
			);

			const vision = result.models.find(model => model.id === "deepseek-v4-flash-vision-exp");
			expect(vision).toBeDefined();
			expect(vision?.input).toEqual(["text", "image"]);
			expect(vision?.contextWindow).toBe(1000000);
			expect(vision?.maxTokens).toBe(384000);
			expect(vision?.reasoning).toBe(true);
			// ox-alpha-free declares video input; musepi's canonical vocabulary
			// preserves every modality the gateway advertises.
			const alpha = result.models.find(model => model.id === "ox-alpha-free");
			expect(alpha).toBeDefined();
			expect(alpha?.input).toEqual(["text", "image", "video"]);
			expect(alpha?.contextWindow).toBe(1000000);
			expect(alpha?.maxTokens).toBe(131072);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("replaces stale bundled Zen models with each credential's live endpoint list", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-opencode-zen-"));
		try {
			let freeFetches = 0;
			const freeOptions = opencodeZenModelManagerOptions({
				apiKey: "free-account-key",
				fetch: (async (input: string | URL | Request) => {
					const url = inputUrl(input);
					if (url === MODELS_DEV_URL) return Response.json({});
					freeFetches++;
					return modelListResponse(LIVE_FREE_MODEL_IDS);
				}) as FetchImpl,
			});
			const freeResult = await resolveProviderModels(
				{ ...freeOptions, cacheDbPath: path.join(tempDir, "models.db") },
				"online-if-uncached",
			);

			let paidFetches = 0;
			const paidOptions = opencodeZenModelManagerOptions({
				apiKey: "paid-account-key",
				fetch: (async (input: string | URL | Request) => {
					const url = inputUrl(input);
					if (url === MODELS_DEV_URL) return Response.json({});
					paidFetches++;
					return modelListResponse(LIVE_PAID_MODEL_IDS);
				}) as FetchImpl,
			});
			const paidResult = await resolveProviderModels(
				{ ...paidOptions, cacheDbPath: path.join(tempDir, "models.db") },
				"online-if-uncached",
			);

			expect(freeOptions.cacheProviderId).not.toBe(paidOptions.cacheProviderId);
			expect(freeResult.stale).toBe(false);
			expect(freeResult.models.map(model => model.id).sort()).toEqual([...LIVE_FREE_MODEL_IDS].sort());
			expect(paidResult.stale).toBe(false);
			expect(paidResult.models.map(model => model.id).sort()).toEqual([...LIVE_PAID_MODEL_IDS].sort());
			expect([freeFetches, paidFetches]).toEqual([1, 1]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
