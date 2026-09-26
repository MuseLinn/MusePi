import { afterEach, beforeEach, describe, expect, test } from "bun:test";

/*
 * Hub-mirror fallback (快赢包 A1) tests. The module memoizes both the origin
 * list and the probe result per process, so every test mutates a fresh module
 * registry via bun's per-test module isolation is NOT available — instead we
 * reset module state through dynamic re-import inside each fixture and drive
 * fetch with a stubbed global.
 */

const ORIGINAL_FETCH = globalThis.fetch;

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): void {
	globalThis.fetch = handler as typeof fetch;
}

async function freshModule(): Promise<typeof import("../src/tiny/hub-mirrors")> {
	// Re-import to reset the module-level memo caches for each fixture.
	return await import(`../src/tiny/hub-mirrors?ts=${Date.now()}-${Math.random()}`);
}

beforeEach(() => {
	delete process.env.MUSEPI_HUB_ORIGINS;
});

afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH;
	delete process.env.MUSEPI_HUB_ORIGINS;
});

describe("resolveHubOrigins", () => {
	test("defaults to upstream plus hf-mirror fallback", async () => {
		const mod = await freshModule();
		expect(mod.resolveHubOrigins()).toEqual(["https://huggingface.co", "https://hf-mirror.com"]);
	});

	test("MUSEPI_HUB_ORIGINS overrides the default list entirely", async () => {
		process.env.MUSEPI_HUB_ORIGINS = "https://mirror.example.com, https://second.example.com ";
		const mod = await freshModule();
		expect(mod.resolveHubOrigins()).toEqual(["https://mirror.example.com", "https://second.example.com"]);
	});

	test("a blank override falls back to the default list", async () => {
		process.env.MUSEPI_HUB_ORIGINS = "   ";
		const mod = await freshModule();
		expect(mod.resolveHubOrigins()).toEqual(["https://huggingface.co", "https://hf-mirror.com"]);
	});
});

describe("preferredHubOrigin", () => {
	test("single configured origin skips probing and wins by definition", async () => {
		process.env.MUSEPI_HUB_ORIGINS = "https://only.example.com";
		const mod = await freshModule();
		let probed = 0;
		stubFetch(async () => {
			probed += 1;
			return new Response(null, { status: 200 });
		});
		expect(await mod.preferredHubOrigin()).toBe("https://only.example.com");
		expect(probed).toBe(0);
	});

	test("the first origin to answer the HEAD probe wins", async () => {
		const mod = await freshModule();
		stubFetch(async (url: string) => {
			if (url === "https://huggingface.co") await new Promise(resolve => setTimeout(resolve, 60));
			return new Response(null, { status: 200 });
		});
		expect(await mod.preferredHubOrigin()).toBe("https://hf-mirror.com");
	});

	test("an unreachable upstream falls back to the mirror", async () => {
		const mod = await freshModule();
		stubFetch(async (url: string) => {
			if (url === "https://huggingface.co") throw new Error("connection refused");
			return new Response(null, { status: 200 });
		});
		expect(await mod.preferredHubOrigin()).toBe("https://hf-mirror.com");
	});

	test("total probe failure keeps the configured first origin", async () => {
		const mod = await freshModule();
		stubFetch(async () => {
			throw new Error("offline");
		});
		expect(await mod.preferredHubOrigin()).toBe("https://huggingface.co");
	});

	test("the probe result is memoized per process", async () => {
		const mod = await freshModule();
		let probed = 0;
		stubFetch(async () => {
			probed += 1;
			return new Response(null, { status: 200 });
		});
		await mod.preferredHubOrigin();
		await mod.preferredHubOrigin();
		expect(probed).toBe(2); // two origins raced once; no second race
	});
});

describe("orderedHubOrigins / fetchHubFile", () => {
	test("orderedHubOrigins hoists the probe winner and keeps the rest", async () => {
		const mod = await freshModule();
		stubFetch(async (url: string) => {
			if (url === "https://huggingface.co") throw new Error("blocked");
			return new Response(null, { status: 200 });
		});
		expect(await mod.orderedHubOrigins()).toEqual(["https://hf-mirror.com", "https://huggingface.co"]);
	});

	test("fetchHubFile returns the first OK response across origins", async () => {
		const mod = await freshModule();
		const attempts: string[] = [];
		stubFetch(async (url: string) => {
			attempts.push(url);
			// Origin probes succeed on both; only the upstream FILE request
			// fails (mirror-lag scenario: a repo missing on one origin).
			if (url.includes("model.onnx") && url.startsWith("https://huggingface.co")) {
				return new Response(null, { status: 503 });
			}
			return new Response("weights", { status: 200 });
		});
		const response = await mod.fetchHubFile("repo/resolve/main/model.onnx");
		expect(response.ok).toBe(true);
		expect(await response.text()).toBe("weights");
		// The origin-root HEAD probes also ride the stubbed fetch; only the
		// model-path attempts interest this assertion.
		const fileAttempts = attempts.filter(url => url.includes("model.onnx"));
		expect(fileAttempts[0]).toBe("https://huggingface.co/repo/resolve/main/model.onnx");
		expect(fileAttempts.at(-1)).toBe("https://hf-mirror.com/repo/resolve/main/model.onnx");
	});

	test("fetchHubFile retries transport failures on the next origin", async () => {
		const mod = await freshModule();
		stubFetch(async (url: string) => {
			if (url.startsWith("https://huggingface.co")) throw new Error("timeout");
			return new Response("ok", { status: 200 });
		});
		const response = await mod.fetchHubFile("repo/resolve/main/tokens.txt");
		expect(response.ok).toBe(true);
	});

	test("fetchHubFile throws the last error when every origin fails", async () => {
		const mod = await freshModule();
		stubFetch(async (url: string) => {
			throw new Error(`down: ${url}`);
		});
		let caught: unknown;
		try {
			await mod.fetchHubFile("repo/resolve/main/x.onnx");
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toContain("https://hf-mirror.com/repo/resolve/main/x.onnx");
	});
});
