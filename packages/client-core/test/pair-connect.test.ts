/**
 * Pairing inputs as the user actually presents them: a pasted URL instead of a
 * bare IP, and a camera pointed at any code in the room. Both used to hand a
 * malformed string straight to the socket / connect flow, so the failure looked
 * like MusePi rather than like the input.
 */
import { describe, expect, it } from "bun:test";
import { linkFromScannedCode, normalizePairHost } from "../src/components/shell/ConnectScreen";

describe("normalizePairHost", () => {
	it("accepts a bare LAN address and fills the pair port", () => {
		expect(normalizePairHost("192.168.1.7")).toBe("192.168.1.7:8301");
		expect(normalizePairHost("  studio.local  ")).toBe("studio.local:8301");
	});

	it("keeps an explicit port", () => {
		expect(normalizePairHost("192.168.1.7:9000")).toBe("192.168.1.7:9000");
	});

	it("strips a pasted scheme, path, query and trailing slash", () => {
		expect(normalizePairHost("http://192.168.1.7/")).toBe("192.168.1.7:8301");
		expect(normalizePairHost("https://192.168.1.7:8301/pair?code=1")).toBe("192.168.1.7:8301");
	});

	it("keeps an IPv6 literal bracketed", () => {
		expect(normalizePairHost("[fe80::1]")).toBe("[fe80::1]:8301");
	});

	it("rejects what cannot be a host", () => {
		expect(normalizePairHost("")).toBeNull();
		expect(normalizePairHost("http://")).toBeNull();
		expect(normalizePairHost("bad host")).toBeNull();
	});
});

describe("linkFromScannedCode", () => {
	it("accepts transport links", () => {
		expect(linkFromScannedCode("https://192.168.1.7:7654/#ws://192.168.1.7:7654")).not.toBeNull();
		expect(linkFromScannedCode("wss://relay.example/session")).toBe("wss://relay.example/session");
	});

	it("unwraps the app deep-link shape", () => {
		expect(linkFromScannedCode("musepi://connect?link=wss%3A%2F%2Frelay.example%2Fs")).toBe("wss://relay.example/s");
	});

	it("refuses codes that are not a pair code", () => {
		expect(linkFromScannedCode("WIFI:S:home;T:WPA;P:secret;;")).toBeNull();
		expect(linkFromScannedCode("musepi://connect")).toBeNull();
		expect(linkFromScannedCode("")).toBeNull();
	});
});
