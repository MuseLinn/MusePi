import { describe, expect, it } from "bun:test";
import { buildTrajectory } from "../src/components/trajectory-data";

// 会话轨迹视图(DSH Trajectory 参考吸收):entries → 事件时间线 + 统计。

function userEntry(ts: string, text: string): unknown {
	return { type: "message", timestamp: ts, message: { role: "user", content: [{ type: "text", text }] } };
}

function assistantEntry(ts: string, opts: { text?: string; toolName?: string; args?: unknown; toolId?: string }): unknown {
	const content: unknown[] = [];
	if (opts.text) content.push({ type: "text", text: opts.text });
	if (opts.toolName) {
		content.push({ type: "toolCall", id: opts.toolId ?? `call-${opts.toolName}`, name: opts.toolName, arguments: opts.args ?? {} });
	}
	return { type: "message", timestamp: ts, message: { role: "assistant", content } };
}

function toolResultEntry(ts: string, toolCallId: string, text: string): unknown {
	return { type: "message", timestamp: ts, message: { role: "toolResult", toolCallId, content: [{ type: "text", text }] } };
}

describe("buildTrajectory", () => {
	it("提取工具调用为 TOOL 事件并回填结果", () => {
		const entries = [
			userEntry("2026-08-17T00:00:00.000Z", "调用 runtime_tool"),
			assistantEntry("2026-08-17T00:00:01.000Z", {
				toolName: "runtime_tool",
				args: { message: "hi" },
				toolId: "call-1",
			}),
			toolResultEntry("2026-08-17T00:00:02.000Z", "call-1", "runtime tool works"),
		];
		const { events, stats } = buildTrajectory(entries);
		expect(stats.calls).toBe(1);
		expect(stats.turns).toBe(1);
		expect(stats.durationSec).toBe(2);
		const tool = events.find(e => e.kind === "tool");
		expect(tool?.title).toBe("runtime_tool");
		expect(tool?.body).toContain("hi");
		expect(tool?.result).toBe("runtime tool works");
		expect(tool?.turn).toBe(1);
	});

	it("user 消息分 turn,assistant 文本/thinking 各成事件", () => {
		const entries = [
			userEntry("2026-08-17T00:00:00.000Z", "第一问"),
			assistantEntry("2026-08-17T00:00:01.000Z", { text: "回答一" }),
			userEntry("2026-08-17T00:00:02.000Z", "第二问"),
			assistantEntry("2026-08-17T00:00:03.000Z", { text: "回答二" }),
		];
		const { events, stats } = buildTrajectory(entries);
		expect(stats.turns).toBe(2);
		expect(stats.calls).toBe(0);
		expect(events.filter(e => e.kind === "user").length).toBe(2);
		expect(events.filter(e => e.kind === "assistant").length).toBe(2);
	});

	it("无工具/无消息时统计为零且事件为空", () => {
		const { events, stats } = buildTrajectory([]);
		expect(events.length).toBe(0);
		expect(stats.calls).toBe(0);
		expect(stats.turns).toBe(0);
		expect(stats.durationSec).toBe(0);
	});
});
