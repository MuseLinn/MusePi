import { describe, expect, test } from "bun:test";
import { connectionPresentation } from "../src/lib/connection/presentation";

/**
 * The one mapping every connection surface reads.
 *
 * These assertions are the contract, not the implementation: a deliberate
 * disconnect must never read as a failure, an attempt in flight must never
 * read as failed, and a managed process that died must not send the user
 * looking for a network problem.
 */

describe("connection presentation", () => {
	test("a live connection wins over a stale error", () => {
		const shown = connectionPresentation({ connected: true, lastError: "connection refused" });
		expect(shown).toEqual({
			phase: "connected",
			labelKey: "settings.connectionStatusConnected",
			tone: "ok",
		});
	});

	test("a managed process that died asks for a step, not a retry", () => {
		// A tunnel or WSL daemon that failed is the user's next action; calling it
		// "failed" beside a healthy network sends them to the wrong fix.
		expect(connectionPresentation({ connected: false, managed: "failed" })).toEqual({
			phase: "attention",
			labelKey: "settings.connectionNeedsAttention",
			tone: "warn",
		});
	});

	test("an attempt in flight is connecting, never failed", () => {
		expect(connectionPresentation({ connected: false, connecting: true }).phase).toBe("connecting");
		expect(connectionPresentation({ connected: false, managed: "starting" }).phase).toBe("connecting");
		// A stale error from the previous attempt must not outrank the new one.
		expect(connectionPresentation({ connected: false, connecting: true, lastError: "timed out" }).phase).toBe(
			"connecting",
		);
	});

	test("a recorded error is failed", () => {
		expect(connectionPresentation({ connected: false, lastError: "refused" })).toEqual({
			phase: "failed",
			labelKey: "settings.connectionStatusFailed",
			tone: "error",
		});
	});

	test("nothing recorded is neutral, so a deliberate disconnect is not an error", () => {
		expect(connectionPresentation({ connected: false })).toEqual({
			phase: "idle",
			labelKey: "settings.connectionStatusUnknown",
			tone: "neutral",
		});
	});
});

describe("target axes", () => {
	test("the stored kind maps onto where and what", async () => {
		const { targetAxes } = await import("../src/lib/connection/targets");
		expect(targetAxes("wsl")).toEqual({ location: "local", environment: "wsl" });
		expect(targetAxes("docker")).toEqual({ location: "local", environment: "container" });
		expect(targetAxes("ssh")).toEqual({ location: "remote", environment: "system" });
		// A typed endpoint names no machine; guessing "local" would be wrong.
		expect(targetAxes("manual").location).toBe("unknown");
	});

	test("a container with a host is a remote container", async () => {
		// `docker` cannot answer "where" from its own discriminant: the same kind
		// covers a container here and one on a build box. The host decides.
		const { targetAxes } = await import("../src/lib/connection/targets");
		expect(targetAxes("docker", "me@build")).toEqual({ location: "remote", environment: "container" });
		expect(targetAxes("docker", "")).toEqual({ location: "local", environment: "container" });
	});

	test("only pairs this build can reach produce a kind", async () => {
		const { kindForAxes } = await import("../src/lib/connection/targets");
		expect(kindForAxes("local", "system")).toBe("manual");
		expect(kindForAxes("local", "wsl")).toBe("wsl");
		expect(kindForAxes("local", "container")).toBe("docker");
		expect(kindForAxes("remote", "system")).toBe("ssh");
		// A container on the far side is exec'd over the ssh hop the tunnel uses,
		// so the pair resolves to the same kind with host facts attached.
		expect(kindForAxes("remote", "container")).toBe("docker");
		// WSL is a local Windows feature, not something reachable through ssh.
		expect(kindForAxes("remote", "wsl")).toBeNull();
	});
});

describe("history is not a live socket", () => {
	test("an earlier success reads as last used, still idle", async () => {
		const { connectionPresentation } = await import("../src/lib/connection/presentation");
		const shown = connectionPresentation({ connected: false, lastUsed: true });
		// Same phase and tone as "never tried": nothing is wrong. Only the wording
		// differs, so a row cannot claim 已连接 while the header says 已断开.
		expect(shown.phase).toBe("idle");
		expect(shown.tone).toBe("neutral");
		expect(shown.labelKey).toBe("settings.connectionStatusLastUsed");
	});

	test("an error outranks the history behind it", async () => {
		const { connectionPresentation } = await import("../src/lib/connection/presentation");
		expect(connectionPresentation({ connected: false, lastUsed: true, lastError: "refused" }).phase).toBe("failed");
	});
});
