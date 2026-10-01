/**
 * lightenOverviewEntry 契约（P0-4，docs/review/0.5.1-defect-handoff.md）。
 *
 * 失败模式：会话全量补全（ensureFullHistory）把每条 SessionEntry 原文存进
 * 第二份本地数组——长会话（数千轮）下这是数百 MB 的重复内容，是整个进程
 * 最大的内存载荷之一。概览消费方（轨迹时间线 / 轮级地图 / 分支树）只读
 * 显示级文本（所有显示截断 ≤ 400 字符）与结构字段，因此摄入时按
 * OVERVIEW_TEXT_CAP 预裁是恒等变换。
 *
 * 钉死的契约：
 *  ① 显示恒等——treeTextOf / treeKindOf / treeVerdictOf / buildMessageTree
 *    在轻量条目上的输出与原文条目共价（截断只依赖前缀，块级 ≥ 最终上限）；
 *  ② 重负载移除——图片块剥掉 base64 data，长文本块/thinking/result/顾问
 *    note 截到上限；
 *  ③ 结构字段原样保留（id/parentId/type/timestamp/usage/duration），
 *    树构建的父子挂接不变。
 */
import { describe, expect, test } from "bun:test";
import {
	buildMessageTree,
	lightenOverviewEntry,
	OVERVIEW_TEXT_CAP,
	treeKindOf,
	treeTextOf,
	treeVerdictOf,
} from "../src/lib/message-tree";

const LONG = "x".repeat(2000);

function assistantEntry(content: unknown): Record<string, unknown> {
	return {
		id: "user:1",
		parentId: null,
		type: "message",
		timestamp: "2026-09-27T10:00:00.000Z",
		message: { role: "assistant", content },
	};
}

describe("lightenOverviewEntry", () => {
	test("truncates long text/thinking blocks and keeps display output identical", () => {
		const entry = assistantEntry([
			{ type: "text", text: LONG },
			{ type: "thinking", thinking: `y`.repeat(900) },
			{ type: "toolCall", name: "read", id: "tc1", arguments: { path: "a.ts" } },
		]);
		const light = lightenOverviewEntry(entry) as Record<string, unknown>;
		const blocks = (
			light.message as {
				content: Array<{
					type?: string;
					text?: string;
					thinking?: string;
					name?: string;
					id?: string;
					arguments?: unknown;
				}>;
			}
		).content;
		expect(blocks[0]?.text).toHaveLength(OVERVIEW_TEXT_CAP + 1); // cap + "…"
		expect(blocks[0]?.text?.endsWith("…")).toBe(true);
		expect(blocks[1]?.thinking).toHaveLength(OVERVIEW_TEXT_CAP + 1);
		// toolCall 块原样保留（参数由 stringifyArgs 自行截断）。
		expect(blocks[2]).toEqual({ type: "toolCall", name: "read", id: "tc1", arguments: { path: "a.ts" } });
		// Display identity: treeTextOf joins text blocks then caps — the light
		// entry yields the same preview string.
		expect(treeTextOf(light)).toBe(treeTextOf(entry));
	});

	test("strips image data but keeps the block marker", () => {
		const entry = assistantEntry([
			{ type: "text", text: "see this" },
			{ type: "image", data: `data:image/png;base64,${"z".repeat(100_000)}`, mimeType: "image/png" },
		]);
		const light = lightenOverviewEntry(entry) as Record<string, unknown>;
		const blocks = light.message as { content: Array<Record<string, unknown>> };
		expect("data" in blocks.content[1]!).toBe(false);
		expect(blocks.content[1]?.type).toBe("image");
		expect(JSON.stringify(light)).not.toContain("zzz");
		expect(treeTextOf(light)).toBe(treeTextOf(entry));
	});

	test("truncates string content, message.result and advisor notes", () => {
		const msg = lightenOverviewEntry({
			id: "toolResult:1",
			parentId: "user:1",
			type: "message",
			timestamp: "t",
			message: { role: "toolResult", content: "ok", result: LONG },
		}) as { message: { result: string } };
		expect(msg.message.result).toHaveLength(OVERVIEW_TEXT_CAP + 1);

		const advisor = lightenOverviewEntry({
			id: "custom_message:1",
			parentId: null,
			type: "custom_message",
			customType: "advisor",
			display: true,
			timestamp: "t",
			content: LONG,
			details: { notes: [{ note: LONG }] },
		}) as { content: string; details: { notes: [{ note: string }] } };
		expect(advisor.content).toHaveLength(OVERVIEW_TEXT_CAP + 1);
		expect(advisor.details.notes[0].note).toHaveLength(OVERVIEW_TEXT_CAP + 1);
	});

	test("preserves structural fields — tree building links identically", () => {
		const entries = [
			{ id: "user:1", parentId: null, type: "message", timestamp: "t1", message: { role: "user", content: LONG } },
			{
				id: "assistant:2",
				parentId: "user:1",
				type: "message",
				timestamp: "t2",
				message: { role: "assistant", content: [{ type: "text", text: `reply ${LONG}` }] },
				usage: { totalTokens: 42 },
			},
		];
		const light = entries.map(e => lightenOverviewEntry(e));
		const origTree = buildMessageTree(entries);
		const lightTree = buildMessageTree(light);
		expect(lightTree.map(n => n.id)).toEqual(origTree.map(n => n.id));
		expect(lightTree[0]?.children.map(c => c.id)).toEqual(origTree[0]?.children.map(c => c.id));
		const lightAssistant = light[1] as { usage: { totalTokens: number } };
		expect(lightAssistant.usage.totalTokens).toBe(42);
		expect(treeKindOf(light[1])).toBe(treeKindOf(entries[1]));
		expect(treeVerdictOf(light[1])).toBe(treeVerdictOf(entries[1]));
	});

	test("leaves short entries and non-objects untouched", () => {
		const short = assistantEntry([{ type: "text", text: "short" }]);
		const light = lightenOverviewEntry(short) as Record<string, unknown>;
		expect(light).not.toBe(short); // shallow copy, never the same reference
		expect(light).toEqual(short);
		expect(lightenOverviewEntry(null)).toBeNull();
		expect(lightenOverviewEntry("str")).toBe("str");
		const nonMessage = { id: "model_change:1", type: "model_change", timestamp: "t", modelId: "k2" };
		expect(lightenOverviewEntry(nonMessage)).toEqual(nonMessage);
	});
});
