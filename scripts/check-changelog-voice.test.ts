/**
 * `check-changelog-voice` contract tests.
 *
 * The gate only earns its place in `bun run check` if it has both halves:
 * it must catch a headline that reads as an engineering note, and it must
 * stay out of the way everywhere else. Each case below names the failure it
 * prevents — a gate that cries wolf gets deleted, and a gate that fires on
 * released history would break every build for no user benefit.
 */
import { describe, expect, test } from "bun:test";
import { checkChangelogVoice } from "./check-changelog-voice";

/** Build a changelog with an `[Unreleased]` block above a released section. */
function doc(unreleasedBullets: string[], releasedBullets: string[] = []): string {
	return [
		"# Changelog",
		"",
		"## [Unreleased]",
		"",
		"### Added",
		...unreleasedBullets,
		"",
		"## [0.5.3] - 2026-10-03",
		"",
		"### Fixed",
		...releasedBullets,
		"",
	].join("\n");
}

describe("checkChangelogVoice", () => {
	test("flags a [Unreleased] title written as an engineering decision record", () => {
		const result = checkChangelogVoice(doc(["- **两处刻意不照抄 openchamber**：① …"]));
		// Failure mode if regressed: the what's-new panel ships this as a
		// headline, so the user learns about our design reasoning instead of
		// what changed for them.
		expect(result.problems).toHaveLength(1);
		expect(result.problems[0]?.label).toBe("decision narrative");
	});

	test("flags provenance parked in the parenthetical right after the title", () => {
		const result = checkChangelogVoice(
			doc(["- **回合导轨新增加载更多按钮**（吸收 openchamber PromptNavigatorRail）：此前……"]),
		);
		// The bold span alone is clean; the provenance sits between the span and
		// the colon, which is exactly where it reads as part of the headline.
		expect(result.problems).toHaveLength(1);
		expect(result.problems[0]?.title).toContain("吸收");
	});

	test("flags internal identifiers used as a headline", () => {
		const result = checkChangelogVoice(
			doc(["- **输入框「+」菜单扩展**（M2-2.6，zcode 吸收 #4 关闭）：已启用插件……"]),
		);
		expect(result.problems).toHaveLength(1);
	});

	test("leaves released sections alone — they are immutable and predate the rule", () => {
		const result = checkChangelogVoice(doc(["- **干净的标题**：正文。"], ["- **刻意不照抄 openchamber**：正文。"]));
		// Failure mode if regressed: every build fails on shipped history, and
		// the temptation to "fix" it grows into rewriting published releases.
		expect(result.problems).toHaveLength(0);
		expect(result.checked).toBe(1);
	});

	test("does not fire on mechanism or provenance that stays in the body", () => {
		const result = checkChangelogVoice(
			doc([
				"- **翻页按轮次对齐：最老的一轮不再是个碎片**：此前一次翻页是 500 条平铺前置，根因是批次边界任意（openchamber 的做法）。",
			]),
		);
		// The body may keep the rationale — the panel truncates it, and the
		// engineering record is worth having. Only the headline is gated.
		expect(result.problems).toHaveLength(0);
		expect(result.checked).toBe(1);
	});

	test("does not fire on ordinary titles that merely contain a tell substring", () => {
		const result = checkChangelogVoice(
			doc([
				"- **空闲会话提示缓存预热**：默认开启，可在设置里关闭。",
				"- **⌘F 在当前会话内查找消息**：带命中计数与上下跳转。",
				"- **紧凑模式**：行高更小，一屏能看到更多轮次。",
			]),
		);
		expect(result.problems).toHaveLength(0);
		expect(result.checked).toBe(3);
	});

	test("a bullet without a bold span is neither counted nor flagged", () => {
		const result = checkChangelogVoice(doc(["- 完全没有粗体标题的条目，吸收了上游实现。"]));
		// Without a bold span the parser never turns it into a card title, so
		// there is nothing user-visible to judge.
		expect(result.problems).toHaveLength(0);
		expect(result.checked).toBe(0);
	});

	test("an empty [Unreleased] is clean rather than an error", () => {
		const result = checkChangelogVoice(doc([]));
		expect(result.problems).toHaveLength(0);
		expect(result.checked).toBe(0);
	});

	test("reports at most one problem per bullet even when several tells fire", () => {
		const result = checkChangelogVoice(doc(["- **刻意吸收 openchamber parity**（dsh parity）：……"]));
		// One line, one fix — a report listing four labels for the same headline
		// reads as four problems to fix.
		expect(result.problems).toHaveLength(1);
	});
});
