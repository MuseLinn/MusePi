import { afterEach, describe, expect, it, vi } from "vitest";
import {
	checkForNewPiVersion,
	comparePackageVersions,
	getLatestPiRelease,
	getLatestPiVersion,
	isNewerPackageVersion,
} from "../src/utils/version-check.ts";

const originalSkipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;
const originalOffline = process.env.PI_OFFLINE;

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalSkipVersionCheck === undefined) {
		delete process.env.PI_SKIP_VERSION_CHECK;
	} else {
		process.env.PI_SKIP_VERSION_CHECK = originalSkipVersionCheck;
	}
	if (originalOffline === undefined) {
		delete process.env.PI_OFFLINE;
	} else {
		process.env.PI_OFFLINE = originalOffline;
	}
});

function npmRegistryResponse(body: unknown): Response {
	return Response.json(body);
}

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("1.2.3", "1.2.3")).toBe(0);
		expect(comparePackageVersions("1.2.3", "1.2.4")).toBe(-1);
		expect(comparePackageVersions("1.2.4", "1.2.3")).toBe(1);
		expect(comparePackageVersions("not-semver", "1.2.3")).toBeUndefined();
		expect(comparePackageVersions("1.2.3", "not-semver")).toBeUndefined();
	});

	it("detects newer versions", () => {
		expect(isNewerPackageVersion("1.2.4", "1.2.3")).toBe(true);
		expect(isNewerPackageVersion("1.2.3", "1.2.3")).toBe(false);
		expect(isNewerPackageVersion("1.2.2", "1.2.3")).toBe(false);
	});

	it("returns only newer versions", async () => {
		const fetchMock = vi.fn(async () => npmRegistryResponse({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toEqual({
			version: "1.2.4",
			url: "https://github.com/MuseLinn/MusePi/releases",
		});
	});

	it("returns undefined when no newer version exists", async () => {
		const fetchMock = vi.fn(async () => npmRegistryResponse({ version: "1.2.3" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
	});

	it("queries the npm registry with a musepi user agent", async () => {
		const fetchMock = vi.fn(async () => npmRegistryResponse({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://registry.npmjs.org/@musepi/coding-agent/latest",
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^musepi\/1\.2\.3 /),
					accept: "application/vnd.npm.install-v1+json",
				}),
			}),
		);
	});

	it("returns the release url from a npm registry response", async () => {
		const fetchMock = vi.fn(async () =>
			npmRegistryResponse({
				version: "1.2.4",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({
			version: "1.2.4",
			url: "https://github.com/MuseLinn/MusePi/releases",
		});
	});

	it("returns undefined when npm responds with an error", async () => {
		const fetchMock = vi.fn(async () => new Response("nope", { status: 503 }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toBeUndefined();
	});

	it("skips api calls when version checks are disabled", async () => {
		process.env.PI_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("skips api calls in offline mode", async () => {
		process.env.PI_OFFLINE = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
