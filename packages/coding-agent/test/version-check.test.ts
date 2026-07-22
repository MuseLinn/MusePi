import { afterEach, describe, expect, it, vi } from "vitest";
import {
	checkForNewPiVersion,
	comparePackageVersions,
	getLatestPiRelease,
	getLatestPiVersion,
	isNewerPackageVersion,
	versionFromReleaseTag,
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

function githubReleaseResponse(body: unknown): Response {
	return Response.json(body);
}

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(comparePackageVersions("5.0.0-beta.20", "5.0.0-beta.9")).toBeGreaterThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("parses versions from release tags", () => {
		expect(versionFromReleaseTag("v1.2.3")).toBe("1.2.3");
		expect(versionFromReleaseTag("V1.2.3")).toBe("1.2.3");
		expect(versionFromReleaseTag("1.2.3")).toBe("1.2.3");
		expect(versionFromReleaseTag(" v1.2.3 ")).toBe("1.2.3");
		expect(versionFromReleaseTag("nightly")).toBeUndefined();
		expect(versionFromReleaseTag("v")).toBeUndefined();
		expect(versionFromReleaseTag("")).toBeUndefined();
	});

	it("returns only newer versions", async () => {
		const fetchMock = vi.fn(async () => githubReleaseResponse({ tag_name: "v1.2.3" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewPiVersion("1.2.2")).resolves.toEqual({ version: "1.2.3" });
	});

	it("queries the MusePi GitHub releases api with a musepi user agent", async () => {
		const fetchMock = vi.fn(async () => githubReleaseResponse({ tag_name: "v1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.github.com/repos/MuseLinn/MusePi/releases/latest",
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^musepi\/1\.2\.3 /),
					accept: "application/vnd.github+json",
				}),
			}),
		);
	});

	it("returns the release url from the releases api", async () => {
		const fetchMock = vi.fn(async () =>
			githubReleaseResponse({
				tag_name: "v1.2.4",
				html_url: "https://github.com/MuseLinn/MusePi/releases/tag/v1.2.4",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({
			version: "1.2.4",
			url: "https://github.com/MuseLinn/MusePi/releases/tag/v1.2.4",
		});
	});

	it("ignores releases with non-semver or missing tags", async () => {
		const fetchMock = vi
			.fn()
			.mockImplementationOnce(async () => githubReleaseResponse({ tag_name: "nightly" }))
			.mockImplementationOnce(async () => githubReleaseResponse({ name: "no tag here" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toBeUndefined();
		await expect(getLatestPiRelease("1.2.3")).resolves.toBeUndefined();
	});

	it("returns undefined when the api responds with an error", async () => {
		const fetchMock = vi.fn(async () => new Response("nope", { status: 403 }));
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
