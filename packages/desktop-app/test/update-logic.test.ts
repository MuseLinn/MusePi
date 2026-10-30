import { describe, expect, test } from "bun:test";
// update-logic.cjs lives outside tsconfig include (electron/) and has no
// types — same convention as the daemon.cjs test imports.
import {
	classifyUpdateError,
	isMissingUpdateFeedError,
	isNetworkError,
	isNewerVersion,
	nextPollDelayMs,
	releaseChannelForVersion,
	releaseDownloadUrl,
	UPDATE_POLL_BASE_MS,
	UPDATE_POLL_JITTER,
	UPDATE_POLL_MAX_MS,
	updateFeedForVersion,
	updateManifestUrlForVersion,
	// @ts-expect-error — untyped CJS module (electron/, outside tsconfig include)
} from "../electron/update-logic.cjs";

/**
 * Updater pure-logic contracts:
 *
 *  - classifyUpdateError: every raw updater failure maps to a stable
 *    semantic kind ({check|download|install} × {network|other}) — the UI
 *    copy keys off the kind, so an unstable enum would ship raw English
 *    diagnostics as the user-facing message.
 *  - nextPollDelayMs: failure ×2 backoff capped at 6h with ±20% jitter —
 *    a wrong cap or missing jitter would hammer a flapping feed forever or
 *    schedule checks at deterministic, thundering-herd times.
 */
describe("classifyUpdateError", () => {
	test("maps each operation to its base kind on a non-network error", () => {
		for (const op of ["check", "download", "install"] as const) {
			const out = classifyUpdateError(op, new Error("something exploded"));
			expect(out.kind).toBe(op);
			expect(out.message).toBe("something exploded");
		}
	});

	test("tags socket-level codes as network failures for each operation", () => {
		for (const op of ["check", "download", "install"] as const) {
			// electron-updater flattens Chromium/Node socket codes into the
			// message text (no err.code) — the classifier must read it.
			const out = classifyUpdateError(op, new Error("Request failed: ETIMEDOUT"));
			expect(out.kind).toBe(`${op}-network`);
		}
		expect(classifyUpdateError("download", new Error("getaddrinfo ENOTFOUND github.com")).kind).toBe(
			"download-network",
		);
		expect(classifyUpdateError("check", new Error("fetch failed")).kind).toBe("check-network");
	});

	test("carries the raw message as technicalDetails only for Error inputs", () => {
		const err = new Error("signature verification failed");
		const out = classifyUpdateError("install", err);
		expect(out.technicalDetails).toContain("signature verification failed");
		// A bare string failure has no stack to fold in.
		expect(classifyUpdateError("check", "404 not found").technicalDetails).toBeUndefined();
	});

	test("falls back to the check operation for an unknown op and survives junk errors", () => {
		expect(classifyUpdateError("bogus" as "check", new Error("x")).kind).toBe("check");
		expect(classifyUpdateError("check", undefined).message.length).toBeGreaterThan(0);
	});
});

describe("isNetworkError", () => {
	test("matches common socket codes and connection wording", () => {
		for (const msg of [
			"ERR_CONNECTION_RESET",
			"ECONNREFUSED 127.0.0.1:443",
			"network changed mid-download",
			"socket hang up",
			"Request timed out after 30000ms",
		]) {
			expect(isNetworkError(msg)).toBe(true);
		}
	});

	test("does not tag local validation failures as network", () => {
		expect(isNetworkError("signature verification failed")).toBe(false);
		expect(isNetworkError("")).toBe(false);
	});
});

describe("isMissingUpdateFeedError", () => {
	test("treats a 404 on the channel file as 'no feed published'", () => {
		// The exact GitHub-provider wording a missing latest.yml produces
		// (observed on 0.5.3 against the asset-less 0.6.0 release).
		expect(
			isMissingUpdateFeedError(
				new Error(
					"Cannot find latest.yml in the latest release artifacts (https://github.com/MuseLinn/MusePi/releases/download/v0.6.0/latest.yml): HttpError: 404 ",
				),
			),
		).toBe(true);
		// Generic-provider wording for a channel file that was never published.
		expect(isMissingUpdateFeedError(new Error('Cannot find channel "beta.yml" update info'))).toBe(true);
	});

	test("keeps genuine network failures and download-phase failures out of the missing-feed verdict", () => {
		// DNS failure is the user's network, not a missing release.
		expect(isMissingUpdateFeedError(new Error("getaddrinfo ENOTFOUND github.com"))).toBe(false);
		expect(isMissingUpdateFeedError(new Error("Request failed: ETIMEDOUT"))).toBe(false);
		// A 404 on the installer ASSET mid-download must stay a download error:
		// the bare status wording is intentionally not a missing-feed signal.
		expect(isMissingUpdateFeedError(new Error("Cannot download MusePi-0.6.0-setup.exe: HttpError: 404"))).toBe(false);
		expect(isMissingUpdateFeedError("Request failed with status code 404")).toBe(false);
		expect(isMissingUpdateFeedError(undefined)).toBe(false);
	});
});

describe("release channels", () => {
	test("orders numbered betas before their stable release", () => {
		expect(isNewerVersion("0.6.4-beta.2", "0.6.4-beta.1")).toBe(true);
		expect(isNewerVersion("0.6.4-beta.10", "0.6.4-beta.2")).toBe(true);
		expect(isNewerVersion("0.6.4-beta.1", "0.6.4-beta.2")).toBe(false);
		expect(isNewerVersion("0.6.4", "0.6.4-beta.2")).toBe(true);
		expect(isNewerVersion("0.6.4-beta.2", "0.6.4")).toBe(false);
	});

	test("routes beta feeds and manifests to channel-beta", () => {
		expect(releaseChannelForVersion("0.6.4-beta.1")).toBe("beta");
		expect(releaseChannelForVersion("0.6.3")).toBe("stable");
		expect(updateFeedForVersion("0.6.4-beta.1")).toEqual({
			provider: "generic",
			url: "https://github.com/MuseLinn/MusePi/releases/download/channel-beta",
			channel: "beta",
		});
		expect(updateFeedForVersion("0.6.3")).toBeNull();
		expect(updateManifestUrlForVersion("0.6.4-beta.1")).toBe(
			"https://github.com/MuseLinn/MusePi/releases/download/channel-beta/update-manifest.json",
		);
		expect(updateManifestUrlForVersion("0.6.3")).toBe(
			"https://github.com/MuseLinn/MusePi/releases/latest/download/update-manifest.json",
		);
	});
});

describe("release download URLs", () => {
	const releasesPage = "https://github.com/MuseLinn/MusePi/releases/latest";
	const manifest = {
		url: "https://github.com/MuseLinn/MusePi/releases/download/v0.6.4/MusePi-0.6.4-arm64.dmg",
		downloads: {
			"darwin-arm64": "https://github.com/MuseLinn/MusePi/releases/download/v0.6.4/MusePi-0.6.4-arm64.dmg",
			"win32-x64": "https://github.com/MuseLinn/MusePi/releases/download/v0.6.4/MusePi-0.6.4-setup.exe",
			"win32-arm64": "https://github.com/MuseLinn/MusePi/releases/download/v0.6.4/MusePi-0.6.4-arm64-setup.exe",
		},
	};

	test("selects the installer for the current Windows architecture", () => {
		expect(releaseDownloadUrl(manifest, "win32", "x64", releasesPage)).toBe(manifest.downloads["win32-x64"]);
		expect(releaseDownloadUrl(manifest, "win32", "arm64", releasesPage)).toBe(manifest.downloads["win32-arm64"]);
	});

	test("keeps the legacy macOS URL off other platforms", () => {
		const legacy = { url: manifest.url };
		expect(releaseDownloadUrl(legacy, "darwin", "arm64", releasesPage)).toBe(manifest.url);
		expect(releaseDownloadUrl(legacy, "win32", "x64", releasesPage)).toBe(releasesPage);
	});
});

describe("nextPollDelayMs", () => {
	const BASE = UPDATE_POLL_BASE_MS;
	const MAX = UPDATE_POLL_MAX_MS;

	test("success (0 failures) schedules the base interval, jittered ±20%", () => {
		expect(nextPollDelayMs(0, { random: () => 0 })).toBe(Math.round(BASE * (1 - UPDATE_POLL_JITTER)));
		expect(nextPollDelayMs(0, { random: () => 1 })).toBe(Math.round(BASE * (1 + UPDATE_POLL_JITTER)));
		expect(nextPollDelayMs(0, { random: () => 0.5 })).toBe(BASE);
	});

	test("consecutive failures double the delay up to the 6h cap", () => {
		const mid = (f: number): number => nextPollDelayMs(f, { random: () => 0.5 });
		expect(mid(1)).toBe(BASE * 2);
		expect(mid(2)).toBe(BASE * 4);
		// 8h would exceed the 6h cap: the delay clamps to 6h and the positive
		// jitter side clamps to the cap too (dsh schedule parity), so mid sits
		// at 0.9 × 6h.
		expect(mid(3)).toBe(Math.round(MAX * 0.9));
		expect(mid(4)).toBe(Math.round(MAX * 0.9));
		expect(mid(9)).toBe(Math.round(MAX * 0.9));
	});

	test("jitter stays inside ±20% and never exceeds the cap upward", () => {
		for (let failures = 1; failures <= 6; failures++) {
			const low = nextPollDelayMs(failures, { random: () => 0 });
			const high = nextPollDelayMs(failures, { random: () => 1 });
			const delay = Math.min(MAX, BASE * 2 ** failures);
			expect(low).toBe(Math.round(delay * (1 - UPDATE_POLL_JITTER)));
			expect(high).toBeLessThanOrEqual(MAX);
		}
	});

	test("rejects negative garbage failure counts back to the base interval", () => {
		expect(nextPollDelayMs(-3, { random: () => 0.5 })).toBe(BASE);
	});
});
