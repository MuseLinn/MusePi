import { describe, expect, test } from "bun:test";
import { isWireAgentEvent, toWireAgentEvent } from "../../src/collab/wire-guard";
import type { AgentSessionEvent } from "../../src/session/agent-session-events";

describe("isWireAgentEvent whitelist", () => {
	test("ttsr_triggered and irc_message now cross the daemon boundary", () => {
		expect(
			isWireAgentEvent({ type: "ttsr_triggered", rules: [{ name: "r", content: "x" }] } as AgentSessionEvent),
		).toBe(true);
		expect(
			isWireAgentEvent({
				type: "irc_message",
				message: { role: "custom", customType: "irc:incoming", content: "hi", display: true, timestamp: 1 },
			} as AgentSessionEvent),
		).toBe(true);
	});
});

describe("toWireAgentEvent", () => {
	test("ttsr_triggered shrinks full Rule objects to the wire rule shape", () => {
		const out = toWireAgentEvent({
			type: "ttsr_triggered",
			rules: [
				{
					name: "no-console",
					path: "/tmp/.musepi/rules/no-console.md",
					content: "禁止 console.log",
					condition: ["console.log"],
				},
				{ name: "bare", path: "/tmp/bare.md", content: "x" },
			],
		} as AgentSessionEvent);
		expect(out).toEqual({
			type: "ttsr_triggered",
			rules: [
				{ name: "no-console", content: "禁止 console.log" },
				{ name: "bare", content: "x" },
			],
		});
		// no path / condition / globs leak into the wire payload
		expect(JSON.stringify(out)).not.toContain("/tmp/");
		expect(JSON.stringify(out)).not.toContain("condition");
	});

	test("irc_message passes the session custom message through wire-compatible fields", () => {
		const out = toWireAgentEvent({
			type: "irc_message",
			message: {
				role: "custom",
				customType: "irc:incoming",
				content: "sub: 查一下",
				display: true,
				details: { id: "m1", from: "sub", message: "查一下" },
				attribution: "agent",
				timestamp: 1_700_000_000_000,
			},
		} as AgentSessionEvent);
		expect(out).toEqual({
			type: "irc_message",
			message: {
				role: "custom",
				customType: "irc:incoming",
				content: "sub: 查一下",
				display: true,
				details: { id: "m1", from: "sub", message: "查一下" },
				attribution: "agent",
				timestamp: 1_700_000_000_000,
			},
		});
	});

	test("unrelated events pass through unchanged", () => {
		const ev = { type: "notice", level: "info", message: "hi" } as AgentSessionEvent;
		expect(toWireAgentEvent(ev as never) as unknown).toEqual(ev as unknown);
	});
});
