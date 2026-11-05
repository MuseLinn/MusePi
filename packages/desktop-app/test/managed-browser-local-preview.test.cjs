/**
 * Local-preview scheme handling (`musepi-file://`, legacy `omp-file://`):
 * address-bar canonicalization and the file URL the protocol handler serves.
 */
const { describe, expect, it } = require("bun:test");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// These tests never reach Electron; skip the one-time scheme hook.
process.env.MUSEPI_MANAGED_BROWSER_SCHEMES_REGISTERED = "1";
const {
	LEGACY_LOCAL_PREVIEW_SCHEME,
	LOCAL_PREVIEW_SCHEME,
	ManagedBrowserController,
	isLocalPreviewUrl,
	localPreviewFilePath,
	localPreviewFileUrl,
	normalizeAddressBarUrl,
} = require("../electron/managed-browser.cjs");

describe("local-preview schemes", () => {
	it("registers the MusePi spelling and the legacy one", () => {
		expect(LOCAL_PREVIEW_SCHEME).toBe("musepi-file");
		expect(LEGACY_LOCAL_PREVIEW_SCHEME).toBe("omp-file");
	});

	it("accepts both spellings and nothing else", () => {
		expect(isLocalPreviewUrl("musepi-file://localhost/tmp/a.html")).toBe(true);
		expect(isLocalPreviewUrl("musepi-file://localhost/D:/a.html")).toBe(true);
		expect(isLocalPreviewUrl("omp-file://localhost/tmp/a.html")).toBe(true);
		expect(isLocalPreviewUrl("OMP-FILE://localhost/tmp/a.html")).toBe(true);
		expect(isLocalPreviewUrl("https://example.com/a.html")).toBe(false);
		expect(isLocalPreviewUrl("file:///tmp/a.html")).toBe(false);
		expect(isLocalPreviewUrl("about:blank")).toBe(false);
	});
});

describe("normalizeAddressBarUrl — local preview", () => {
	it("keeps the Windows drive separator so pathname round-trips", () => {
		expect(normalizeAddressBarUrl("musepi-file://localhost/D:/Projects/MusePi/web/index.html")).toBe(
			"musepi-file://localhost/D:/Projects/MusePi/web/index.html",
		);
	});

	it("upgrades a persisted legacy URL to the canonical scheme", () => {
		expect(normalizeAddressBarUrl("omp-file://localhost/D:/Projects/MusePi/web/index.html")).toBe(
			"musepi-file://localhost/D:/Projects/MusePi/web/index.html",
		);
		expect(normalizeAddressBarUrl("omp-file://localhost/tmp/artifact.html")).toBe(
			"musepi-file://localhost/tmp/artifact.html",
		);
	});

	it("restores the host when the address arrives without one", () => {
		// Chromium folds the first path segment into the host for `scheme:///x`;
		// the canonical form always names `localhost`.
		expect(normalizeAddressBarUrl("musepi-file:///tmp/artifact.html")).toBe(
			"musepi-file://localhost/tmp/artifact.html",
		);
	});

	it("re-encodes spaces and non-ASCII segments exactly once", () => {
		expect(normalizeAddressBarUrl("musepi-file://localhost/tmp/a%20b/%E9%A1%B5%E9%9D%A2.html")).toBe(
			"musepi-file://localhost/tmp/a%20b/%E9%A1%B5%E9%9D%A2.html",
		);
	});

	it("rejects a local-preview address that names no file", () => {
		expect(normalizeAddressBarUrl("musepi-file://localhost/")).toBeNull();
		expect(normalizeAddressBarUrl("omp-file://localhost/%E0%A4%A")).toBeNull();
	});

	it("leaves http(s) and bare hostnames alone", () => {
		expect(normalizeAddressBarUrl("example.com/docs")).toBe("https://example.com/docs");
		expect(normalizeAddressBarUrl("omp-file.example.com")).toBe("https://omp-file.example.com/");
	});
});

const WINDOWS = process.platform === "win32";

describe("localPreviewFileUrl — protocol handler target", () => {
	// Drive-letter paths only resolve through the host's own path semantics;
	// `D:/...` is not absolute on POSIX, so this branch is Windows-only.
	it.skipIf(!WINDOWS)("maps a Windows drive path to file:///D:/...", () => {
		expect(localPreviewFilePath("musepi-file://localhost/D:/Projects/MusePi/web/index.html")).toBe(
			path.normalize("D:/Projects/MusePi/web/index.html"),
		);
		expect(localPreviewFileUrl("musepi-file://localhost/D:/Projects/MusePi/web/index.html")).toBe(
			"file:///D:/Projects/MusePi/web/index.html",
		);
	});

	it("maps an absolute path to a single-rooted file URL", () => {
		expect(localPreviewFileUrl("musepi-file://localhost/tmp/artifact.html")).toBe(
			pathToFileURL(path.normalize("/tmp/artifact.html")).toString(),
		);
	});

	it.skipIf(!WINDOWS)("serves the legacy spelling through the same reader", () => {
		expect(localPreviewFileUrl("omp-file://localhost/D:/Projects/MusePi/web/index.html")).toBe(
			"file:///D:/Projects/MusePi/web/index.html",
		);
	});

	it("decodes URL-encoded path segments", () => {
		expect(localPreviewFileUrl("musepi-file://localhost/tmp/a%20b/%E9%A1%B5%E9%9D%A2.html")).toBe(
			pathToFileURL(path.normalize("/tmp/a b/页面.html")).toString(),
		);
	});

	it("refuses a path with no file name", () => {
		expect(localPreviewFileUrl("musepi-file://localhost/")).toBeNull();
	});

	it("surfaces a malformed percent escape instead of guessing", () => {
		expect(() => localPreviewFileUrl("musepi-file://localhost/%E0%A4%A")).toThrow();
	});
});

describe("agent navigation gate — sanctioned destinations", () => {
	it("passes both preview spellings through without asking", async () => {
		const controller = new ManagedBrowserController();
		expect(await controller.gateAgentNavigation("musepi-file://localhost/D:/a.html")).toBe(true);
		expect(await controller.gateAgentNavigation("omp-file://localhost/D:/a.html")).toBe(true);
		expect(await controller.gateAgentNavigation("https://example.com/a.html")).toBe(true);
	});

	it("still asks about raw file:// navigation (denied with no window)", async () => {
		const controller = new ManagedBrowserController();
		expect(await controller.gateAgentNavigation("file:///D:/secret.txt")).toBe(false);
	});
});
