import { describe, expect, it } from "bun:test";
import {
	discoverPluginsByTopic,
	PLUGIN_TOPIC,
} from "@musepi/pi-coding-agent/extensibility/plugins/marketplace/topic-discovery";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** A fetch that answers the search and one package.json per repository. */
function fakeFetch(packages: Record<string, unknown>, opts: { searchStatus?: number } = {}) {
	const seen: string[] = [];
	const impl = (async (input: string | URL | Request) => {
		const url = String(input);
		seen.push(url);
		if (url.includes("/search/repositories")) {
			if (opts.searchStatus) return jsonResponse({}, opts.searchStatus);
			return jsonResponse({
				items: Object.keys(packages).map(repo => ({
					full_name: repo,
					html_url: `https://github.com/${repo}`,
					description: "from search",
					stargazers_count: 7,
					default_branch: "main",
					owner: { login: repo.split("/")[0] },
				})),
			});
		}
		const repo = url.match(/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\//)?.[1];
		const pkg = repo ? packages[repo] : undefined;
		return pkg === undefined ? new Response("not found", { status: 404 }) : jsonResponse(pkg);
	}) as unknown as typeof fetch;
	return { impl, seen };
}

describe("plugin topic discovery", () => {
	it("lists a tagged repository with what its package.json says", async () => {
		const { impl } = fakeFetch({
			"acme/musepi-tool": {
				name: "musepi-tool",
				version: "1.2.3",
				description: "does a thing",
				license: "MIT",
				magpie: { agent: "./tool.agent.js", icon: "https://example.com/i.png" },
			},
		});
		const out = await discoverPluginsByTopic({ fetchImpl: impl });
		expect(out.plugins).toHaveLength(1);
		const [p] = out.plugins;
		expect(p.repo).toBe("acme/musepi-tool");
		expect(p.name).toBe("musepi-tool");
		expect(p.version).toBe("1.2.3");
		expect(p.kind).toBe("agent");
		expect(p.icon).toBe("https://example.com/i.png");
		expect(p.stars).toBe(7);
	});

	it("marks every discovered plugin as unreviewed", async () => {
		const { impl } = fakeFetch({ "acme/x": { name: "x" } });
		const out = await discoverPluginsByTopic({ fetchImpl: impl });
		// The tag is the author's own claim; nobody read the code.
		expect(out.plugins.every(p => p.reviewed === false)).toBe(true);
	});

	it("keeps the list when one repository has no package.json", async () => {
		const { impl } = fakeFetch({
			"acme/good": { name: "good" },
			"acme/empty": undefined,
		});
		const out = await discoverPluginsByTopic({ fetchImpl: impl });
		expect(out.plugins.map(p => p.name)).toEqual(["good"]);
		expect(out.failures.some(f => f.includes("acme/empty"))).toBe(true);
	});

	it("returns nothing but a failure when the search itself is rate limited", async () => {
		const { impl } = fakeFetch({}, { searchStatus: 403 });
		const out = await discoverPluginsByTopic({ fetchImpl: impl });
		expect(out.plugins).toEqual([]);
		expect(out.failures[0]).toMatch(/rate limit/i);
	});

	it("searches the tag, not a package name", async () => {
		const { impl, seen } = fakeFetch({ "acme/y": { name: "y" } });
		await discoverPluginsByTopic({ fetchImpl: impl });
		const searchUrl = seen.find(u => u.includes("/search/repositories")) ?? "";
		expect(decodeURIComponent(searchUrl)).toContain(`topic:${PLUGIN_TOPIC}`);
	});
});
