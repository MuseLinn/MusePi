// ============================================================
// hashline — 快照漂移恢复。
//
// 机制（与 OMP recovery 同构，实现从简）：当 [PATH#TAG] 锚定的
// 快照与磁盘实况不一致时，不直接拒绝——先尝试把每条锚定行从
// 快照文本映射到当前文本：
//   1. 收集 patch 触及的全部锚定行（delete 行、SWAP 范围行、
//      INS.PRE/POST 的落点行）。
//   2. 求一个统一的行偏移 offset，使每条锚定行在当前文本的
//      line+offset 处内容逐字相同。
//   3. offset 存在且唯一 → 重映射所有锚点后在当前文本上重放编辑；
//      不存在、不唯一（锚定行是重复行如 `}`）、或锚定行内容本身
//      被改过 → 失败，由 engine 报"请 re-read"的可操作错误。
//
// 设计取向是 fail-closed：恢复路径只覆盖"外部在文件别处增删行"
// 的常见漂移（统一平移），目标行被动过的一律拒绝。
// ============================================================

import { applyEdits } from "./apply.ts";
import type { ApplyResult, Edit } from "./types.ts";

export interface RecoveryResult {
	/** 恢复后的完整文本（基于 currentText 应用重映射编辑）。 */
	text: string;
	/** 相对当前文本的首个变化行（1-indexed）。 */
	firstChangedLine: number | undefined;
	/** 实际应用的统一行偏移。 */
	offset: number;
}

/** 收集 patch 触及的全部 1-indexed 锚定行（去重、排序）。 */
export function collectAnchorLines(edits: readonly Edit[]): number[] {
	const anchors = new Set<number>();
	for (const edit of edits) {
		if (edit.kind === "delete") {
			anchors.add(edit.anchor.line);
			continue;
		}
		if (edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor") {
			anchors.add(edit.cursor.anchor.line);
		}
	}
	return [...anchors].sort((a, b) => a - b);
}

/**
 * 求统一偏移：对首个锚定行枚举候选 offset（当前文本中内容相同
 * 的位置），再用其余锚定行逐一过滤。候选为空 → null；
 * 过滤后恰剩一个 → 该 offset；多个 → 歧义，null。
 */
export function findUniformOffset(
	snapshotLines: readonly string[],
	currentLines: readonly string[],
	anchorLines: readonly number[],
): number | null {
	if (anchorLines.length === 0) return null;
	const lineCount = snapshotLines.length;
	for (const line of anchorLines) {
		if (line < 1 || line > lineCount) return null;
	}

	let candidates: number[] | null = null;
	for (const line of anchorLines) {
		const content = snapshotLines[line - 1]!;
		if (candidates === null) {
			candidates = [];
			for (let i = 0; i < currentLines.length; i++) {
				if (currentLines[i] === content) candidates.push(i + 1 - line);
			}
			if (candidates.length === 0) return null;
			continue;
		}
		candidates = candidates.filter((offset) => {
			const mapped = line + offset;
			return mapped >= 1 && mapped <= currentLines.length && currentLines[mapped - 1] === content;
		});
		if (candidates.length === 0) return null;
	}
	return candidates !== null && candidates.length === 1 ? candidates[0]! : null;
}

/** 将全部锚点按 offset 平移，返回新 edits；cursor 为 bof/eof 的原样保留。 */
export function remapEdits(edits: readonly Edit[], offset: number): Edit[] {
	return edits.map((edit) => {
		if (edit.kind === "delete") {
			return { ...edit, anchor: { line: edit.anchor.line + offset } };
		}
		const cursor = edit.cursor;
		if (cursor.kind === "before_anchor" || cursor.kind === "after_anchor") {
			return { ...edit, cursor: { kind: cursor.kind, anchor: { line: cursor.anchor.line + offset } } };
		}
		return edit;
	});
}

/**
 * 尝试漂移恢复。返回 null 表示没有安全的前进路径——调用方应
 * 抛出"文件已变化，请 re-read"的可操作错误。
 */
export function tryRecover(
	snapshotText: string,
	currentText: string,
	edits: readonly Edit[],
): RecoveryResult | null {
	const snapshotLines = snapshotText.split("\n");
	const currentLines = currentText.split("\n");
	const anchorLines = collectAnchorLines(edits);
	const offset = findUniformOffset(snapshotLines, currentLines, anchorLines);
	if (offset === null) return null;

	let applied: ApplyResult;
	try {
		applied = applyEdits(currentText, remapEdits(edits, offset));
	} catch {
		return null;
	}
	// 恢复后文本与实况一致 = patch 是 no-op，按失败处理（让模型重新对齐）。
	if (applied.text === currentText) return null;
	return { text: applied.text, firstChangedLine: applied.firstChangedLine, offset };
}
