/**
 * Tests for {@link discoverDraftModels} — the "fetch available models"
 * interrogation that configuration surfaces use before a provider is saved.
 * Every test exercises the contract (protocol validation, HTTP round-trip,
 * error handling) through a mock fetch.
 */
import { describe, expect, test } from "bun:test";
import { discoverDraftModels } from "@musepi/pi-coding-agent/config/model-discovery";

describe("discoverDraftModels", () => {
	// ── Protocol validation ──────────────────────────────────────────

	test("rejects anthropic-messages protocol", async () => {
		await expect(
			discoverDraftModels({ provider: "test", api: "anthropic-messages", baseUrl: "https://example.com" }),
		).rejects.toThrow("has no model listing");
	});

	test("rejects google-generative-ai protocol", async () => {
		await expect(
			discoverDraftModels({ provider: "test", api: "google-generative-ai", baseUrl: "https://example.com" }),
		).rejects.toThrow("has no model listing");
	});

	// ── Successful interrogations ────────────────────────────────────

	test("returns advertised models for openai-completions", async () => {
		const entries = await discoverDraftModels(
			{ provider: "test", api: "openai-completions", baseUrl: "https://gateway.example/v1" },
			async () =>
				new Response(JSON.stringify({ data: [{ id: "gpt-4" }, { id: "gpt-3.5-turbo" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		expect(entries).toHaveLength(2);
		// The bundled reference enriches a known id with its canonical name
		// (gpt-4 → "GPT-4"); an unknown id keeps the bare id as its name.
		expect(entries[0].id).toBe("gpt-4");
		expect(entries[0].name).toBe("GPT-4");
		expect(entries[1]).toEqual({ id: "gpt-3.5-turbo", name: "gpt-3.5-turbo" });
	});

	test("returns advertised models for openai-responses", async () => {
		const entries = await discoverDraftModels(
			{ provider: "test", api: "openai-responses", baseUrl: "https://api.test/v1" },
			async () =>
				new Response(JSON.stringify({ data: [{ id: "claude-4" }, { id: "claude-3.5" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		expect(entries).toHaveLength(2);
		expect(entries[0].id).toBe("claude-4");
		expect(entries[1].id).toBe("claude-3.5");
	});

	test("sends the bearer key when apiKey is set", async () => {
		let authHeader: string | undefined;
		const entries = await discoverDraftModels(
			{
				provider: "test",
				api: "openai-completions",
				baseUrl: "https://gateway.example/v1",
				apiKey: "sk-probe-123",
			},
			async (_input, init) => {
				authHeader = (init?.headers as Record<string, string> | undefined)?.Authorization;
				return new Response(JSON.stringify({ data: [{ id: "m1" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},
		);
		expect(entries).toHaveLength(1);
		expect(authHeader).toBe("Bearer sk-probe-123");
	});

	// ── Edge cases ──────────────────────────────────────────────────

	test("returns empty array when the endpoint reports no models", async () => {
		const entries = await discoverDraftModels(
			{ provider: "test", api: "openai-completions", baseUrl: "https://gateway.example/v1" },
			async () =>
				new Response(JSON.stringify({ data: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		expect(entries).toEqual([]);
	});

	test("throws on HTTP error", async () => {
		await expect(
			discoverDraftModels(
				{ provider: "test", api: "openai-completions", baseUrl: "https://gateway.example/v1" },
				async () => new Response("Not found", { status: 404 }),
			),
		).rejects.toThrow("HTTP 404");
	});

	test("throws on 401", async () => {
		await expect(
			discoverDraftModels(
				{ provider: "test", api: "openai-completions", baseUrl: "https://gateway.example/v1", apiKey: "bad" },
				async () => new Response("Unauthorized", { status: 401 }),
			),
		).rejects.toThrow("HTTP 401");
	});
});
