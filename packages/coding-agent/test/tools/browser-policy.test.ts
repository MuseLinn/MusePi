/**
 * Navigation policy (browser.policy.restrictToPublic): URL normalization,
 * private-address rejection and the DNS re-check guard.
 */
import { describe, expect, it } from "bun:test";
import {
	assertSafeBrowserDestination,
	assertSafeBrowserUrl,
	isPrivateAddress,
	normalizeBrowserUrl,
} from "@musepi/pi-coding-agent/tools/browser/policy";

describe("isPrivateAddress", () => {
	it("flags localhost and .local hosts", () => {
		expect(isPrivateAddress("localhost")).toBe(true);
		expect(isPrivateAddress("api.localhost")).toBe(true);
		expect(isPrivateAddress("printer.local")).toBe(true);
		expect(isPrivateAddress("example.com")).toBe(false);
	});

	it("flags private IPv4 ranges", () => {
		expect(isPrivateAddress("10.0.0.1")).toBe(true);
		expect(isPrivateAddress("127.0.0.1")).toBe(true);
		expect(isPrivateAddress("169.254.1.1")).toBe(true);
		expect(isPrivateAddress("172.16.0.1")).toBe(true);
		expect(isPrivateAddress("172.31.255.255")).toBe(true);
		expect(isPrivateAddress("192.168.1.1")).toBe(true);
		expect(isPrivateAddress("0.0.0.0")).toBe(true);
		expect(isPrivateAddress("224.0.0.1")).toBe(true);
		expect(isPrivateAddress("8.8.8.8")).toBe(false);
		expect(isPrivateAddress("172.32.0.1")).toBe(false);
	});

	it("flags private IPv6 forms including v4-mapped", () => {
		expect(isPrivateAddress("::1")).toBe(true);
		expect(isPrivateAddress("::")).toBe(true);
		expect(isPrivateAddress("::ffff:10.0.0.1")).toBe(true);
		expect(isPrivateAddress("fd00::1")).toBe(true);
		expect(isPrivateAddress("fe80::1")).toBe(true);
		expect(isPrivateAddress("2001:4860:4860::8888")).toBe(false);
	});
});

describe("normalizeBrowserUrl", () => {
	it("defaults bare hostnames to https", () => {
		expect(normalizeBrowserUrl("example.com/docs")).toBe("https://example.com/docs");
	});

	it("keeps explicit ports without a scheme", () => {
		expect(normalizeBrowserUrl("localhost:3000")).toBe("https://localhost:3000");
		expect(normalizeBrowserUrl("example.com:8080/path")).toBe("https://example.com:8080/path");
	});

	it("passes the local-preview scheme through untouched", () => {
		// omp-file:// is the sanctioned local artifact preview (browser.gui);
		// it flows to the bridge whenever restrictToPublic is off.
		expect(normalizeBrowserUrl("omp-file:///tmp/artifact.html")).toBe("omp-file:///tmp/artifact.html");
		expect(normalizeBrowserUrl("omp-file:///Users/me/report.html")).toBe("omp-file:///Users/me/report.html");
	});

	it("rejects protocol-relative input", () => {
		expect(() => normalizeBrowserUrl("//evil.com")).toThrow();
	});
});

describe("assertSafeBrowserUrl", () => {
	it("rejects non-http(s) schemes", () => {
		expect(() => assertSafeBrowserUrl("javascript:alert(1)")).toThrow(/protocol/);
		expect(() => assertSafeBrowserUrl("file:///etc/passwd")).toThrow(/protocol/);
	});

	it("rejects the local-preview scheme when restricted to public", () => {
		// With browser.policy.restrictToPublic on, local artifacts are out of
		// scope: the guard only allows public http/https destinations.
		expect(() => assertSafeBrowserUrl("omp-file:///tmp/artifact.html")).toThrow(/protocol/);
	});

	it("rejects credentials and private hosts", () => {
		expect(() => assertSafeBrowserUrl("https://user:pass@example.com")).toThrow(/credentials|private/i);
		expect(() => assertSafeBrowserUrl("http://localhost:3000")).toThrow(/private/);
		expect(() => assertSafeBrowserUrl("http://192.168.1.10")).toThrow(/private/);
	});

	it("accepts public URLs and normalizes them", () => {
		expect(assertSafeBrowserUrl("https://example.com/docs")).toBe("https://example.com/docs");
		expect(assertSafeBrowserUrl("example.com")).toBe("https://example.com/");
	});
});

describe("assertSafeBrowserDestination", () => {
	it("rejects localhost via DNS re-check", async () => {
		await expect(assertSafeBrowserDestination("https://localhost")).rejects.toThrow(/localhost|private/);
	});

	it("rejects private-address DNS results even for public-looking hosts", async () => {
		// 127.0.0.1.nip.io resolves to 127.0.0.1 — a public-looking hostname
		// whose DNS lands on loopback (the DNS-rebinding guard's target case).
		await expect(assertSafeBrowserDestination("https://127.0.0.1.nip.io")).rejects.toThrow(/localhost|private/);
	});
});
