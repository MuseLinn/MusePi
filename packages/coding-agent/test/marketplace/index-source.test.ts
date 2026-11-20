import { describe, expect, it } from "bun:test";
import {
	MAX_INDEX_REDIRECTS,
	type PluginIndexSourceConfig,
	PluginIndexSourceError,
	PluginIndexSourceReader,
} from "@musepi/pi-coding-agent/extensibility/plugins/marketplace";

const COMMIT = "3f9c2e1d8a4b6c0e7f1a2b3c4d5e6f708192a3b4";
const INDEX_URL = "https://market.example/index.json";

function validIndex(): unknown {
	return {
		format: 1,
		name: "musepi-market",
		title: "MusePi Market",
		owner: { name: "MusePi" },
		metadata: {},
		plugins: [
			{
				name: "demo-plugin",
				vendor: "musepi",
				versions: [
					{
						version: "1.0.0",
						publishedAt: 1_700_000_000,
						source: { type: "git", url: "https://github.com/a/b", commit: COMMIT },
						engines: { musepi: "*" },
					},
				],
			},
		],
	};
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
		...init,
	});
}

function urlSource(name = "musepi-market", url = INDEX_URL): PluginIndexSourceConfig {
	return { name, location: { kind: "url", url } };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(PluginIndexSourceError);
		return (error as PluginIndexSourceError).code;
	}
	throw new Error("expected the read to fail");
}

describe("PluginIndexSourceReader", () => {
	it("rejects an unconfigured market and names the configured ones", async () => {
		const reader = new PluginIndexSourceReader([urlSource("known")], {
			fetch: (async () => jsonResponse(validIndex())) as unknown as typeof fetch,
		});
		expect(await codeOf(reader.read("other"))).toBe("not-configured");
		await expect(reader.read("other")).rejects.toThrow(/known/);
	});

	it("refuses git-hosted indexes in this phase instead of fetching them", async () => {
		let calls = 0;
		const reader = new PluginIndexSourceReader(
			[{ name: "git-market", location: { kind: "git", url: "https://github.com/a/b", path: "index.json" } }],
			{
				fetch: (async () => {
					calls++;
					return jsonResponse(validIndex());
				}) as unknown as typeof fetch,
			},
		);
		expect(await codeOf(reader.read("git-market"))).toBe("reserved-source");
		expect(calls).toBe(0);
	});

	it("rejects URL credentials, fragments, and non-http schemes before any request", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls++;
			return jsonResponse(validIndex());
		}) as unknown as typeof fetch;

		for (const url of [
			"https://user:pass@market.example/index.json",
			"https://market.example/index.json#section",
			"file:///tmp/index.json",
		]) {
			const reader = new PluginIndexSourceReader([urlSource("m", url)], { fetch: fetchImpl });
			expect(await codeOf(reader.read("m"))).toBe("invalid-url");
		}
		expect(calls).toBe(0);
	});

	it("serves a fresh document from the TTL cache with the original fetchedAt", async () => {
		let clock = 1_000;
		let calls = 0;
		const reader = new PluginIndexSourceReader([urlSource()], {
			fetch: (async () => {
				calls++;
				return jsonResponse(validIndex());
			}) as unknown as typeof fetch,
			now: () => clock,
			ttlMs: 1_000,
		});

		const first = await reader.read("musepi-market");
		clock += 999;
		const second = await reader.read("musepi-market");
		expect(first.fromCache).toBe(false);
		expect(second.fromCache).toBe(true);
		expect(second.fetchedAt).toBe(first.fetchedAt);
		expect(calls).toBe(1);
	});

	it("refetches once the TTL has passed", async () => {
		let clock = 1_000;
		let calls = 0;
		const reader = new PluginIndexSourceReader([urlSource()], {
			fetch: (async () => {
				calls++;
				return jsonResponse(validIndex());
			}) as unknown as typeof fetch,
			now: () => clock,
			ttlMs: 1_000,
		});

		await reader.read("musepi-market");
		clock += 1_001;
		const refreshed = await reader.read("musepi-market");
		expect(refreshed.fromCache).toBe(false);
		expect(refreshed.fetchedAt).toBe(clock);
		expect(calls).toBe(2);
	});

	it("shares one request between concurrent reads of the same URL", async () => {
		let calls = 0;
		const reader = new PluginIndexSourceReader([urlSource()], {
			fetch: (async () => {
				calls++;
				await new Promise(resolve => setTimeout(resolve, 10));
				return jsonResponse(validIndex());
			}) as unknown as typeof fetch,
		});

		const [a, b] = await Promise.all([reader.read("musepi-market"), reader.read("musepi-market")]);
		expect(calls).toBe(1);
		expect(a.index.name).toBe(b.index.name);
		expect(a.fetchedAt).toBe(b.fetchedAt);
	});

	it("shares one request between two sources configured with the same URL", async () => {
		let calls = 0;
		const reader = new PluginIndexSourceReader([urlSource("one"), urlSource("two")], {
			fetch: (async () => {
				calls++;
				await new Promise(resolve => setTimeout(resolve, 10));
				return jsonResponse(validIndex());
			}) as unknown as typeof fetch,
		});
		await Promise.all([reader.read("one"), reader.read("two")]);
		expect(calls).toBe(1);
	});

	it("follows a same-origin redirect", async () => {
		const requested: string[] = [];
		const reader = new PluginIndexSourceReader([urlSource()], {
			fetch: (async (input: string | URL | Request) => {
				requested.push(String(input));
				if (requested.length === 1) {
					return new Response(null, { status: 302, headers: { location: "/next/index.json" } });
				}
				return jsonResponse(validIndex());
			}) as unknown as typeof fetch,
		});

		const read = await reader.read("musepi-market");
		expect(read.url).toBe(INDEX_URL);
		expect(requested).toEqual([INDEX_URL, "https://market.example/next/index.json"]);
	});

	it("rejects a redirect to a different origin", async () => {
		const reader = new PluginIndexSourceReader([urlSource()], {
			fetch: (async () =>
				new Response(null, {
					status: 302,
					headers: { location: "https://other.example/index.json" },
				})) as unknown as typeof fetch,
		});
		expect(await codeOf(reader.read("musepi-market"))).toBe("redirect-origin");
	});

	it("rejects a redirect without a Location header", async () => {
		const reader = new PluginIndexSourceReader([urlSource()], {
			fetch: (async () => new Response(null, { status: 302 })) as unknown as typeof fetch,
		});
		expect(await codeOf(reader.read("musepi-market"))).toBe("redirect");
	});

	it("stops a same-origin redirect loop at the hop limit", async () => {
		let calls = 0;
		const reader = new PluginIndexSourceReader([urlSource()], {
			fetch: (async () => {
				calls++;
				return new Response(null, { status: 302, headers: { location: "/loop" } });
			}) as unknown as typeof fetch,
		});
		expect(await codeOf(reader.read("musepi-market"))).toBe("redirect");
		expect(calls).toBe(MAX_INDEX_REDIRECTS + 1);
	});

	it("rejects a body that declares more than the byte cap", async () => {
		const reader = new PluginIndexSourceReader([urlSource()], {
			fetch: (async () =>
				jsonResponse(validIndex(), {
					headers: { "content-type": "application/json", "content-length": "1000000" },
				})) as unknown as typeof fetch,
			maxBytes: 1_024,
		});
		expect(await codeOf(reader.read("musepi-market"))).toBe("body-too-large");
	});

	it("rejects a streamed body that grows past the cap", async () => {
		const reader = new PluginIndexSourceReader([urlSource()], {
			fetch: (async () => jsonResponse(validIndex())) as unknown as typeof fetch,
			maxBytes: 32,
		});
		expect(await codeOf(reader.read("musepi-market"))).toBe("body-too-large");
	});

	it("rejects a non-2xx response", async () => {
		const reader = new PluginIndexSourceReader([urlSource()], {
			fetch: (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch,
		});
		expect(await codeOf(reader.read("musepi-market"))).toBe("http-error");
	});

	it("rejects an invalid index and carries every JSON-path diagnostic", async () => {
		const reader = new PluginIndexSourceReader([urlSource()], {
			fetch: (async () =>
				jsonResponse({
					format: 1,
					name: "m",
					title: "M",
					owner: { name: "o" },
					plugins: [{ name: "p" }],
				})) as unknown as typeof fetch,
		});
		try {
			await reader.read("musepi-market");
			throw new Error("expected the read to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(PluginIndexSourceError);
			const failure = error as PluginIndexSourceError;
			expect(failure.code).toBe("invalid-index");
			const paths = failure.diagnostics?.map(diagnostic => diagnostic.path) ?? [];
			expect(paths).toEqual(expect.arrayContaining(["$.plugins[0].vendor", "$.plugins[0].versions"]));
		}
	});

	it("reports dropped unknown fields on a successful read", async () => {
		const document = validIndex() as Record<string, any>;
		document.plugins[0].install = "npm:demo-plugin@1.0.0";
		const reader = new PluginIndexSourceReader([urlSource()], {
			fetch: (async () => jsonResponse(document)) as unknown as typeof fetch,
		});
		const read = await reader.read("musepi-market");
		expect(read.droppedFields.map(field => field.path)).toContain("$.plugins[0].install");
	});

	it("does not cache a failed read", async () => {
		let calls = 0;
		const reader = new PluginIndexSourceReader([urlSource()], {
			fetch: (async () => {
				calls++;
				return calls === 1 ? new Response("nope", { status: 500 }) : jsonResponse(validIndex());
			}) as unknown as typeof fetch,
		});
		expect(await codeOf(reader.read("musepi-market"))).toBe("http-error");
		const read = await reader.read("musepi-market");
		expect(read.fromCache).toBe(false);
		expect(calls).toBe(2);
	});
});
