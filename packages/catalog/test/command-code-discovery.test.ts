import { describe, expect, it } from "bun:test";
import { commandCodeModelManagerOptions } from "@musepi/pi-catalog/provider-models/openai-compat";

// The gateway's /v1/models rows are bare `{id}`: every capability comes from
// the models.dev catalog (bundled index → gap snapshot → live payload). The
// shared catalog prime is fire-and-forget, so discovery that wins that race
// used to fall through to the text-only defaults and the ModelManager cached
// them for the whole TTL — deepseek-v4.1-flash shipped to users with
// `input: [text]`, hiding the image capability its models.dev entries declare.
//
// The fetch below serves the gateway and the catalog, so the payload is only
// ever reachable through discovery's own resolution.
describe("command-code discovery", () => {
	function makeFetch(): typeof fetch {
		return Object.assign(
			async (input: string | URL | Request): Promise<Response> => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				if (url.includes("catalog.stencil.so")) {
					// Shaped like the real payload: another provider owns the id,
					// which is how gateway-first ids inherit their capabilities.
					return new Response(
						JSON.stringify({
							"nano-gpt": {
								models: {
									"deepseek/deepseek-v4.1-flash": {
										name: "DeepSeek V4.1 Flash",
										reasoning: true,
										modalities: { input: ["text", "image"], output: ["text"] },
										limit: { context: 1_000_000, output: 384_000 },
									},
								},
							},
						}),
					);
				}
				return new Response(
					JSON.stringify({
						data: [{ id: "deepseek/deepseek-v4.1-flash" }, { id: "deepseek/deepseek-v4-flash" }],
					}),
				);
			},
			{ preconnect() {} },
		);
	}

	it("inherits models.dev image input even when the shared catalog prime has not landed", async () => {
		const options = commandCodeModelManagerOptions({ apiKey: "test-key", fetch: makeFetch() });
		expect(options.fetchDynamicModels).toBeDefined();

		const models = await options.fetchDynamicModels?.();
		const v41 = models?.find(m => m.id === "deepseek/deepseek-v4.1-flash");

		expect(v41).toBeDefined();
		expect(v41?.input).toEqual(["text", "image"]);
		expect(v41?.reasoning).toBe(true);
		expect(v41?.contextWindow).toBe(1_000_000);
	});

	it("leaves ids models.dev declares text-only untouched", async () => {
		const options = commandCodeModelManagerOptions({ apiKey: "test-key", fetch: makeFetch() });
		const models = await options.fetchDynamicModels?.();
		const plain = models?.find(m => m.id === "deepseek/deepseek-v4-flash");

		expect(plain?.input).toEqual(["text"]);
	});
});
