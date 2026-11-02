import { describe, expect, test } from "bun:test";
import { buildWsUrl, normalizeRemoteHostUrl } from "../src/lib/remote-hosts";

describe("daemon instance URLs", () => {
	test("accepts a bare host and normalizes web schemes to WebSocket schemes", () => {
		expect(normalizeRemoteHostUrl("127.0.0.1:8300/")).toBe("ws://127.0.0.1:8300");
		expect(normalizeRemoteHostUrl("https://daemon.example.com/")).toBe("wss://daemon.example.com");
	});

	test("preserves endpoint queries and appends tokens without exposing them in the base URL", () => {
		const url = normalizeRemoteHostUrl("ws://daemon.example.com/musepi/?channel=stable");
		expect(url).toBe("ws://daemon.example.com/musepi?channel=stable");
		expect(buildWsUrl({ id: "one", label: "One", url, token: "secret token" })).toBe(
			"ws://daemon.example.com/musepi?channel=stable&token=secret%20token",
		);
	});

	test("rejects unsupported schemes and credentials embedded in URLs", () => {
		expect(() => normalizeRemoteHostUrl("ftp://daemon.example.com")).toThrow();
		expect(() => normalizeRemoteHostUrl("ws://user:secret@daemon.example.com")).toThrow();
	});
});
