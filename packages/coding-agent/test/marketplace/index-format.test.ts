import { describe, expect, it } from "bun:test";
import {
	GLYPH_MAX_LENGTH,
	ICON_MAX_DECODED_BYTES,
	installSpec,
	isCompatibleWithRuntime,
	isExactIndexVersion,
	type PluginIndex,
	type PluginIndexEntry,
	type PluginIndexVersion,
	parsePluginIndex,
	parsePluginIndexJson,
	selectDefaultVersion,
} from "@musepi/pi-coding-agent/extensibility/plugins/marketplace";

const COMMIT = "3f9c2e1d8a4b6c0e7f1a2b3c4d5e6f708192a3b4";
const TINY_ICON = "data:image/svg+xml;base64,PHN2Zy8+";

function validIndex(): unknown {
	return {
		format: 1,
		name: "musepi-market",
		title: { en: "MusePi Market", zh: "MusePi 市场" },
		description: "Community MusePi plugins",
		owner: { name: "MusePi" },
		metadata: {
			categories: { productivity: { title: { en: "Productivity", zh: "效率" } } },
			labels: { official: { title: "Official" } },
			sortKeys: { downloads: { title: "Downloads", order: "desc" } },
		},
		plugins: [
			{
				name: "@musepi/auto-review",
				vendor: "musepi",
				title: { en: "Auto Review" },
				description: { en: "Per-tool authorization review" },
				icon: TINY_ICON,
				glyph: "🔍",
				author: "MusePi",
				homepage: "https://example.com/auto-review",
				repository: { url: "https://github.com/musepi/plugins", directory: "auto-review" },
				license: "MIT",
				metadata: {
					category: "productivity",
					labels: ["official"],
					keywords: ["review", "authorization"],
					sortKeys: { downloads: 12034 },
				},
				versions: [
					{
						version: "0.2.0",
						publishedAt: 1790476800,
						source: { type: "npm", registry: "https://registry.example.com/npm" },
						engines: { musepi: ">=0.2.0 <0.3.0" },
					},
					{
						version: "0.1.0",
						publishedAt: 1789872000,
						source: { type: "npm" },
						engines: { musepi: "^0.1.0" },
					},
				],
			},
			{
				name: "legacy-compat-plugin",
				vendor: "claude",
				description: "A Claude-compatible bundle",
				metadata: { labels: [], keywords: [], sortKeys: {} },
				versions: [
					{
						version: "1.0.0",
						publishedAt: 1788000000,
						source: {
							type: "git",
							url: "https://github.com/author/plugins",
							commit: COMMIT,
							path: "packages/legacy",
						},
						engines: { musepi: "*" },
					},
				],
			},
		],
	};
}

function accept(value: unknown): PluginIndex {
	const result = parsePluginIndex(value);
	if (!result.ok) throw new Error(`expected a valid index, got: ${JSON.stringify(result.errors)}`);
	return result.index;
}

function errorsOf(value: unknown): readonly { path: string; message: string }[] {
	const result = parsePluginIndex(value);
	if (result.ok) throw new Error("expected the index to be rejected");
	return result.errors;
}

function pathsOf(value: unknown): string[] {
	return errorsOf(value).map(error => error.path);
}

/** Deep-clone the golden index so each test starts from a valid document. */
function mutated(mutate: (index: any) => void): unknown {
	const index = JSON.parse(JSON.stringify(validIndex()));
	mutate(index);
	return index;
}

// ── Golden document ───────────────────────────────────────────────────

describe("parsePluginIndex", () => {
	it("accepts the golden format-1 document and normalizes it", () => {
		const index = accept(validIndex());
		expect(index.format).toBe(1);
		expect(index.name).toBe("musepi-market");
		expect(index.title).toEqual({ en: "MusePi Market", zh: "MusePi 市场" });
		expect(index.owner).toEqual({ name: "MusePi" });

		const [native, compat] = index.plugins;
		expect(native?.name).toBe("@musepi/auto-review");
		expect(native?.vendor).toBe("musepi");
		expect(native?.metadata.category).toBe("productivity");
		expect(native?.metadata.labels).toEqual(["official"]);
		expect(native?.metadata.sortKeys).toEqual({ downloads: 12034 });
		expect(native?.versions[0]?.source).toEqual({
			type: "npm",
			registry: "https://registry.example.com/npm",
		});

		expect(compat?.vendor).toBe("claude");
		expect(compat?.metadata).toEqual({ labels: [], keywords: [], sortKeys: {} });
		expect(compat?.versions[0]?.source).toEqual({
			type: "git",
			url: "https://github.com/author/plugins",
			commit: COMMIT,
			path: "packages/legacy",
		});
	});

	it("accepts an empty plugin list", () => {
		const index = accept(mutated(doc => (doc.plugins = [])));
		expect(index.plugins).toEqual([]);
	});

	it("accepts JSON text and strips a UTF-8 BOM", () => {
		const result = parsePluginIndexJson(`\uFEFF${JSON.stringify(validIndex())}`);
		expect(result.ok).toBe(true);
	});

	it("reports a JSON syntax error at the document root", () => {
		const result = parsePluginIndexJson("{");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors[0]?.path).toBe("$");
	});

	it("drops unknown members at every level and lists them instead of failing", () => {
		const result = parsePluginIndex(
			mutated(doc => {
				doc.$schema = "https://example.com/schema.json";
				doc.plugins[0].install = "npm:@musepi/auto-review@0.2.0";
				doc.plugins[0].versions[0].distTags = { latest: "0.2.0" };
				doc.metadata.categories.productivity.weight = 3;
			}),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.droppedFields.map(field => field.path)).toEqual([
			"$.$schema",
			"$.metadata.categories.productivity.weight",
			"$.plugins[0].install",
			"$.plugins[0].versions[0].distTags",
		]);
	});

	// ── Root rules ──────────────────────────────────────────────────

	it("requires format 1", () => {
		expect(pathsOf(mutated(doc => (doc.format = 2)))).toContain("$.format");
		expect(pathsOf(mutated(doc => delete doc.format))).toContain("$.format");
	});

	it("requires a valid market name, title, owner, and plugins", () => {
		expect(pathsOf(mutated(doc => delete doc.name))).toContain("$.name");
		expect(pathsOf(mutated(doc => (doc.name = "Bad Name")))).toContain("$.name");
		expect(pathsOf(mutated(doc => delete doc.title))).toContain("$.title");
		expect(pathsOf(mutated(doc => delete doc.owner))).toContain("$.owner");
		expect(pathsOf(mutated(doc => delete doc.plugins))).toContain("$.plugins");
	});

	it("rejects localized-text maps with an invalid language id or blank text", () => {
		expect(pathsOf(mutated(doc => (doc.title = { EN_us: "x" })))).toContain("$.title.EN_us");
		expect(pathsOf(mutated(doc => (doc.title = { en: "   " })))).toContain("$.title.en");
		expect(pathsOf(mutated(doc => (doc.title = {})))).toContain("$.title");
	});

	// ── Plugin rules ────────────────────────────────────────────────

	it("accepts every declared vendor", () => {
		for (const vendor of ["musepi", "pi", "claude", "codex"] as const) {
			const index = accept(mutated(doc => (doc.plugins[0].vendor = vendor)));
			expect(index.plugins[0]?.vendor).toBe(vendor);
		}
	});

	it("rejects a vendor outside the four declared values", () => {
		expect(pathsOf(mutated(doc => (doc.plugins[0].vendor = "other")))).toContain("$.plugins[0].vendor");
		expect(pathsOf(mutated(doc => delete doc.plugins[0].vendor))).toContain("$.plugins[0].vendor");
	});

	it("rejects duplicate plugin names", () => {
		expect(pathsOf(mutated(doc => (doc.plugins[1].name = doc.plugins[0].name)))).toContain("$.plugins[1].name");
	});

	it("rejects a glyph longer than the stand-in limit", () => {
		expect(pathsOf(mutated(doc => (doc.plugins[0].glyph = "x".repeat(GLYPH_MAX_LENGTH + 1))))).toContain(
			"$.plugins[0].glyph",
		);
	});

	it("accepts an https icon and rejects http or a non-image data icon", () => {
		expect(accept(mutated(doc => (doc.plugins[0].icon = "https://cdn.example.com/icon.png")))).toBeTruthy();
		expect(pathsOf(mutated(doc => (doc.plugins[0].icon = "http://cdn.example.com/icon.png")))).toContain(
			"$.plugins[0].icon",
		);
		expect(pathsOf(mutated(doc => (doc.plugins[0].icon = "data:text/plain;base64,QQ==")))).toContain(
			"$.plugins[0].icon",
		);
	});

	it("rejects an inline icon whose decoded payload exceeds 32 KiB", () => {
		const payload = Buffer.alloc(ICON_MAX_DECODED_BYTES + 1).toString("base64");
		expect(pathsOf(mutated(doc => (doc.plugins[0].icon = `data:image/png;base64,${payload}`)))).toContain(
			"$.plugins[0].icon",
		);
	});

	it("rejects a non-canonical base64 icon payload", () => {
		expect(pathsOf(mutated(doc => (doc.plugins[0].icon = "data:image/png;base64,QQ")))).toContain(
			"$.plugins[0].icon",
		);
	});

	it("rejects a repository directory that escapes the repository", () => {
		expect(pathsOf(mutated(doc => (doc.plugins[0].repository.directory = "../escape")))).toContain(
			"$.plugins[0].repository.directory",
		);
		expect(pathsOf(mutated(doc => (doc.plugins[0].repository.url = "https://u:p@github.com/a/b")))).toContain(
			"$.plugins[0].repository.url",
		);
	});

	// ── Declarations and references ─────────────────────────────────

	it("rejects an undeclared category", () => {
		expect(pathsOf(mutated(doc => (doc.plugins[0].metadata.category = "unknown")))).toContain(
			"$.plugins[0].metadata.category",
		);
	});

	it("rejects undeclared or duplicate labels", () => {
		expect(pathsOf(mutated(doc => (doc.plugins[0].metadata.labels = ["unknown"])))).toContain(
			"$.plugins[0].metadata.labels[0]",
		);
		expect(pathsOf(mutated(doc => (doc.plugins[0].metadata.labels = ["official", "official"])))).toContain(
			"$.plugins[0].metadata.labels[1]",
		);
	});

	it("treats declaration ids such as __proto__ as data, not prototype keys", () => {
		const text = JSON.stringify({
			format: 1,
			name: "market",
			title: "Market",
			owner: { name: "Owner" },
			metadata: { categories: JSON.parse('{"__proto__":{"title":"Proto"}}') },
			plugins: [
				{
					name: "demo-plugin",
					vendor: "musepi",
					metadata: { category: "__proto__" },
					versions: [
						{
							version: "1.0.0",
							publishedAt: 1,
							source: { type: "npm" },
							engines: { musepi: "*" },
						},
					],
				},
			],
		});
		const result = parsePluginIndexJson(text);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.index.plugins[0]?.metadata.category).toBe("__proto__");
	});

	it("rejects an undeclared sort-key value", () => {
		expect(pathsOf(mutated(doc => (doc.plugins[0].metadata.sortKeys.rating = 4.6)))).toContain(
			"$.plugins[0].metadata.sortKeys.rating",
		);
	});

	// ── Version rules ───────────────────────────────────────────────

	it("requires versions and rejects an empty list", () => {
		expect(pathsOf(mutated(doc => delete doc.plugins[1].versions))).toContain("$.plugins[1].versions");
		expect(pathsOf(mutated(doc => (doc.plugins[1].versions = [])))).toContain("$.plugins[1].versions");
	});

	it("rejects a missing version", () => {
		expect(pathsOf(mutated(doc => delete doc.plugins[0].versions[0].version))).toContain(
			"$.plugins[0].versions[0].version",
		);
	});

	it("rejects a range, tag, or non-canonical version string", () => {
		for (const bad of ["^0.2.0", "latest", "v0.2.0", "0.2", "0.02.0", ">=0.2.0"]) {
			expect(pathsOf(mutated(doc => (doc.plugins[0].versions[0].version = bad)))).toContain(
				"$.plugins[0].versions[0].version",
			);
		}
		expect(isExactIndexVersion("0.2.0-rc.1+build.5")).toBe(true);
	});

	it("rejects duplicate versions within one plugin", () => {
		expect(pathsOf(mutated(doc => (doc.plugins[0].versions[1].version = "0.2.0")))).toContain(
			"$.plugins[0].versions[1].version",
		);
	});

	it("rejects a non-integer or out-of-range publishedAt", () => {
		for (const bad of [-1, 1.5, 100_000_000_000, "1790476800"]) {
			expect(pathsOf(mutated(doc => (doc.plugins[0].versions[0].publishedAt = bad)))).toContain(
				"$.plugins[0].versions[0].publishedAt",
			);
		}
	});

	it("rejects an unlisted source type", () => {
		expect(
			pathsOf(mutated(doc => (doc.plugins[0].versions[0].source = { type: "tarball", url: "https://x/y" }))),
		).toContain("$.plugins[0].versions[0].source.type");
	});

	// ── Source hygiene ──────────────────────────────────────────────

	it("rejects a short or uppercase git commit", () => {
		expect(pathsOf(mutated(doc => (doc.plugins[1].versions[0].source.commit = "abc123")))).toContain(
			"$.plugins[1].versions[0].source.commit",
		);
		expect(pathsOf(mutated(doc => (doc.plugins[1].versions[0].source.commit = COMMIT.toUpperCase())))).toContain(
			"$.plugins[1].versions[0].source.commit",
		);
	});

	it("rejects a git URL with credentials, a query, or a non-canonical form", () => {
		const git = (url: string) => mutated(doc => (doc.plugins[1].versions[0].source.url = url));
		expect(pathsOf(git("https://user:pass@github.com/a/b"))).toContain("$.plugins[1].versions[0].source.url");
		expect(pathsOf(git("https://github.com/a/b?ref=main"))).toContain("$.plugins[1].versions[0].source.url");
		expect(pathsOf(git("https://github.com/a/b/"))).toContain("$.plugins[1].versions[0].source.url");
		expect(pathsOf(git("http://github.com/a/b"))).toContain("$.plugins[1].versions[0].source.url");
	});

	it("rejects an unsafe git package path", () => {
		expect(pathsOf(mutated(doc => (doc.plugins[1].versions[0].source.path = "../escape")))).toContain(
			"$.plugins[1].versions[0].source.path",
		);
	});

	it("rejects npm registry URLs with credentials, a query, or a fragment", () => {
		const registry = (url: string) => mutated(doc => (doc.plugins[0].versions[0].source.registry = url));
		expect(pathsOf(registry("https://u:p@registry.example.com/npm"))).toContain(
			"$.plugins[0].versions[0].source.registry",
		);
		expect(pathsOf(registry("https://registry.example.com/npm?x=1"))).toContain(
			"$.plugins[0].versions[0].source.registry",
		);
		expect(pathsOf(registry("https://registry.example.com/npm#v"))).toContain(
			"$.plugins[0].versions[0].source.registry",
		);
	});

	it("requires a valid engines.musepi range", () => {
		expect(pathsOf(mutated(doc => delete doc.plugins[0].versions[0].engines))).toContain(
			"$.plugins[0].versions[0].engines",
		);
		expect(pathsOf(mutated(doc => (doc.plugins[0].versions[0].engines = {})))).toContain(
			"$.plugins[0].versions[0].engines.musepi",
		);
		expect(pathsOf(mutated(doc => (doc.plugins[0].versions[0].engines.musepi = "not a range")))).toContain(
			"$.plugins[0].versions[0].engines.musepi",
		);
		expect(pathsOf(mutated(doc => (doc.plugins[0].versions[0].engines.musepi = "  ")))).toContain(
			"$.plugins[0].versions[0].engines.musepi",
		);
	});

	it("reports every defect in one pass instead of throwing on the first", () => {
		const errors = errorsOf(
			mutated(doc => {
				doc.format = 9;
				doc.plugins[0].vendor = "other";
				doc.plugins[0].versions[0].version = "^1.0.0";
				doc.plugins[1].versions[0].source.commit = "short";
				doc.plugins[1].metadata.category = "missing";
			}),
		);
		const paths = errors.map(error => error.path);
		expect(paths).toEqual(
			expect.arrayContaining([
				"$.format",
				"$.plugins[0].vendor",
				"$.plugins[0].versions[0].version",
				"$.plugins[1].versions[0].source.commit",
				"$.plugins[1].metadata.category",
			]),
		);
	});
});

// ── Compatibility and default version ─────────────────────────────────

function version(overrides: Partial<PluginIndexVersion> = {}): PluginIndexVersion {
	return {
		version: "1.0.0",
		publishedAt: 1_700_000_000,
		source: { type: "npm" },
		engines: { musepi: "^1.0.0" },
		...overrides,
	};
}

function plugin(versions: PluginIndexVersion[]): PluginIndexEntry {
	return {
		name: "demo-plugin",
		vendor: "musepi",
		metadata: { labels: [], keywords: [], sortKeys: {} },
		versions,
	};
}

describe("selectDefaultVersion", () => {
	it("chooses the highest compatible stable version over a higher prerelease", () => {
		const chosen = selectDefaultVersion(
			plugin([
				version({ version: "1.0.0" }),
				version({ version: "2.0.0-rc.1", engines: { musepi: "^2.0.0-rc.1" } }),
				version({ version: "1.2.0" }),
			]),
			"1.2.0",
		);
		expect(chosen?.version).toBe("1.2.0");
	});

	it("falls back to the highest compatible prerelease when no stable version is compatible", () => {
		const chosen = selectDefaultVersion(
			plugin([
				version({ version: "1.0.0", engines: { musepi: "^1.0.0" } }),
				version({ version: "2.0.0-rc.1", engines: { musepi: "^2.0.0-rc.1" } }),
				version({ version: "2.0.0-rc.2", engines: { musepi: "^2.0.0-rc.1" } }),
			]),
			"2.0.0",
		);
		expect(chosen?.version).toBe("2.0.0-rc.2");
	});

	it("treats a hyphen in build metadata as a stable version", () => {
		const chosen = selectDefaultVersion(
			plugin([version({ version: "1.1.0" }), version({ version: "1.2.3+build-1" })]),
			"1.2.3",
		);
		expect(chosen?.version).toBe("1.2.3+build-1");
	});

	it("prefers a stable version with build metadata over a higher prerelease", () => {
		const chosen = selectDefaultVersion(
			plugin([
				version({ version: "1.2.4-rc.1", engines: { musepi: "^1.2.4-rc.1" } }),
				version({ version: "1.2.3+build-1" }),
			]),
			"1.2.4",
		);
		expect(chosen?.version).toBe("1.2.3+build-1");
	});

	it("never falls back to an incompatible version or an npm latest tag", () => {
		expect(
			selectDefaultVersion(plugin([version({ version: "1.0.0", engines: { musepi: "^9.0.0" } })]), "1.2.0"),
		).toBeUndefined();
	});

	it("matches the host prerelease by its base version", () => {
		expect(isCompatibleWithRuntime("^0.7.0", "0.7.7-rc.1")).toBe(true);
		expect(isCompatibleWithRuntime("^0.8.0", "0.7.7-rc.1")).toBe(false);
		expect(isCompatibleWithRuntime("not a range", "0.7.7")).toBe(false);
	});
});

// ── installSpec ───────────────────────────────────────────────────────

describe("installSpec", () => {
	it("builds name@exactVersion for npm and carries the named registry beside it", () => {
		expect(installSpec("@musepi/auto-review", "0.2.0", { type: "npm" })).toEqual({
			spec: "@musepi/auto-review@0.2.0",
		});
		expect(
			installSpec("@musepi/auto-review", "0.2.0", {
				type: "npm",
				registry: "https://registry.example.com/npm",
			}),
		).toEqual({
			spec: "@musepi/auto-review@0.2.0",
			registry: "https://registry.example.com/npm",
		});
	});

	it("builds a commit-pinned git spec and appends the package path", () => {
		expect(
			installSpec("demo-plugin", "1.0.0", {
				type: "git",
				url: "https://github.com/author/plugins",
				commit: COMMIT,
			}),
		).toEqual({ spec: `git+https://github.com/author/plugins.git#${COMMIT}` });

		expect(
			installSpec("demo-plugin", "1.0.0", {
				type: "git",
				url: "https://github.com/author/plugins.git",
				commit: COMMIT,
				path: "packages/demo",
			}),
		).toEqual({ spec: `git+https://github.com/author/plugins.git#${COMMIT}&path:/packages/demo` });
	});

	it("refuses a range, tag, or short commit", () => {
		expect(() => installSpec("demo-plugin", "^1.0.0", { type: "npm" })).toThrow();
		expect(() => installSpec("demo-plugin", "latest", { type: "npm" })).toThrow();
		expect(() =>
			installSpec("demo-plugin", "1.0.0", {
				type: "git",
				url: "https://github.com/a/b",
				commit: "abc123",
			}),
		).toThrow();
	});

	it("re-validates the source with the parser's rules when called directly", () => {
		const git = (url: string) => ({
			type: "git" as const,
			url,
			commit: COMMIT,
		});
		expect(() => installSpec("demo-plugin", "1.0.0", git("https://github.com/a"))).toThrow(/path segments/);
		expect(() => installSpec("demo-plugin", "1.0.0", git("https://github.com/a/b.tgz"))).toThrow(/archive|tgz/);
		expect(() =>
			installSpec("demo-plugin", "1.0.0", { type: "npm", registry: "https://u:p@registry.example.com/npm" }),
		).toThrow(/registry/);
	});
});
