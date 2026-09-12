import { afterEach, describe, expect, it, vi } from "bun:test";
import { getLatestRelease, releaseBinaryName, runUpdateCommand } from "../../src/cli/update-cli";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

describe("runUpdateCommand fetch cancellation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("checks release metadata with a timeout signal", async () => {
		let requestSignal: AbortSignal | undefined;
		vi.spyOn(console, "log").mockImplementation(() => {});
		const fetchStub = Object.assign(
			async (_input: FetchInput, init?: FetchInit) => {
				requestSignal = init?.signal ?? undefined;
				return Response.json({ version: "999.0.0" });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		await runUpdateCommand({ force: false, check: true });

		expect(requestSignal).toBeInstanceOf(AbortSignal);
	});
});

describe("getLatestRelease rename pointers", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function stubRegistry(manifests: Record<string, unknown>): string[] {
		const urls: string[] = [];
		const fetchStub = Object.assign(
			async (input: FetchInput) => {
				const url = String(input);
				urls.push(url);
				let manifest: unknown;
				for (const pkg in manifests) {
					if (url.includes(pkg)) {
						manifest = manifests[pkg];
						break;
					}
				}
				if (!manifest) return new Response(null, { status: 404, statusText: "Not Found" });
				return Response.json(manifest);
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
		return urls;
	}

	it("follows musepi.rename to the new package and resolves version, dist, and names from its manifest", async () => {
		const urls = stubRegistry({
			"@new/omp": { version: "999.1.0", musepi: { dist: "npm" } },
			"@musepi/pi-coding-agent": {
				version: "999.0.0",
				musepi: { dist: "binary", rename: { package: "@new/omp", natives: "@new/natives" } },
			},
		});

		const release = await getLatestRelease();

		expect(release.version).toBe("999.1.0");
		expect(release.dist).toBe("npm");
		expect(release.packages).toEqual({ pkg: "@new/omp", natives: "@new/natives" });
		expect(urls).toEqual([
			"https://registry.npmjs.org/@musepi/pi-coding-agent/latest",
			"https://registry.npmjs.org/@new/omp/latest",
		]);
	});

	it("ignores a rename pointer that cycles back to an already-visited package", async () => {
		const urls = stubRegistry({
			"@musepi/pi-coding-agent": {
				version: "999.0.0",
				musepi: { rename: { package: "@musepi/pi-coding-agent" } },
			},
		});

		const release = await getLatestRelease();

		expect(urls).toHaveLength(1);
		expect(release.version).toBe("999.0.0");
		expect(release.packages).toEqual({ pkg: "@musepi/pi-coding-agent", natives: "@musepi/pi-natives" });
	});

	it("falls back to the GitHub release when the npm registry 404s (MusePi publishes binaries, not npm packages)", async () => {
		const urls: string[] = [];
		const fetchStub = Object.assign(
			async (input: FetchInput) => {
				const url = String(input);
				urls.push(url);
				if (url.startsWith("https://registry.npmjs.org/")) {
					return new Response(null, { status: 404, statusText: "Not Found" });
				}
				if (url === "https://api.github.com/repos/MuseLinn/MusePi/releases/latest") {
					return Response.json({ tag_name: "v0.4.11" });
				}
				return new Response(null, { status: 404, statusText: "Not Found" });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		const release = await getLatestRelease();

		expect(release.version).toBe("0.4.11");
		expect(release.dist).toBe("binary");
		expect(release.packages).toEqual({ pkg: "@musepi/pi-coding-agent", natives: "@musepi/pi-natives" });
		expect(urls).toEqual([
			"https://registry.npmjs.org/@musepi/pi-coding-agent/latest",
			"https://api.github.com/repos/MuseLinn/MusePi/releases/latest",
		]);
	});

	it("propagates non-404 registry failures without falling back to GitHub", async () => {
		const fetchStub = Object.assign(
			async () => new Response(null, { status: 500, statusText: "Internal Server Error" }),
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		await expect(getLatestRelease()).rejects.toThrow("Failed to fetch release info for @musepi/pi-coding-agent");
	});
});

/**
 * The name the updater asks the release for. Windows ARM64 is the contract
 * that broke: `process.arch` reports `arm64` there while no
 * `musepi-windows-arm64.exe` is ever published, so every ARM Windows
 * self-update died with `has 0 assets named musepi-windows-arm64.exe`
 * (user: arm Windows 找不到可执行程序).
 */
describe("releaseBinaryName", () => {
	it("takes the published x64 asset on Windows ARM64", () => {
		expect(releaseBinaryName("win32", "arm64", false)).toBe("musepi-windows-x64.exe");
		expect(releaseBinaryName("win32", "x64", false)).toBe("musepi-windows-x64.exe");
	});

	it("names the published asset for every other supported target", () => {
		expect(releaseBinaryName("darwin", "arm64", false)).toBe("musepi-darwin-arm64");
		expect(releaseBinaryName("linux", "x64", false)).toBe("musepi-linux-x64");
		expect(releaseBinaryName("linux", "x64", true)).toBe("musepi-linux-musl-x64");
		expect(releaseBinaryName("linux", "arm64", true)).toBe("musepi-linux-musl-arm64");
	});

	it("rejects platforms and architectures the release does not serve", () => {
		expect(() => releaseBinaryName("freebsd" as NodeJS.Platform, "x64", false)).toThrow("Unsupported platform");
		expect(() => releaseBinaryName("linux", "ia32", false)).toThrow("Unsupported architecture");
	});
});
