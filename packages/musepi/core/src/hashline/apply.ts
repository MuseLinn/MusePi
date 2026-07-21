// ============================================================
// hashline — 将解析后的低层 Edit 应用到原始文本。
//
// 语义：所有行号锚点都指 ORIGINAL 文件，不随 hunk 应用而移动。
// 应用方式是一次性重建：遍历原始行 1..L，沿途按 cursor 落点
// 排放 insert（同一落点内保持 patch 内出现顺序），跳过被
// delete 的行。SWAP N.=M 已在 parser 分解为 "before N 的
// replacement inserts + N..M 的 deletes"，因此替换体恰好落在
// 原第 N 行的位置。
// ============================================================

import type { ApplyResult, Edit } from "./types.ts";

function anchorLineOf(edit: Edit): number | undefined {
	if (edit.kind === "delete") return edit.anchor.line;
	if (edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor") {
		return edit.cursor.anchor.line;
	}
	return undefined;
}

/**
 * Apply parsed edits to LF-normalized text. Throws an actionable Error
 * when an anchor line is out of range. Pure — no fs, no store access.
 */
export function applyEdits(originalText: string, edits: readonly Edit[]): ApplyResult {
	const lines = originalText.split("\n");
	const lineCount = lines.length;

	// 先校验全部锚点在界内（preflight：任何越界都拒绝整个 patch）。
	for (const edit of edits) {
		const anchor = anchorLineOf(edit);
		if (anchor === undefined) continue;
		if (anchor < 1 || anchor > lineCount) {
			throw new Error(
				`Anchor line ${anchor} is out of range — the file has ${lineCount} line(s). ` +
					"Line numbers come from the read/grep output that minted the tag; re-read if the file changed.",
			);
		}
	}

	const deleted = new Set<number>();
	type InsertEdit = Extract<Edit, { kind: "insert" }>;
	const insertsBefore = new Map<number, InsertEdit[]>();
	const insertsAfter = new Map<number, InsertEdit[]>();
	const bof: InsertEdit[] = [];
	const eof: InsertEdit[] = [];

	const push = (map: Map<number, InsertEdit[]>, key: number, edit: InsertEdit): void => {
		const bucket = map.get(key);
		if (bucket) bucket.push(edit);
		else map.set(key, [edit]);
	};

	// edits 已带 parser 分配的稳定 index，保持同落点内的 patch 顺序。
	for (const edit of edits) {
		if (edit.kind === "delete") {
			deleted.add(edit.anchor.line);
			continue;
		}
		switch (edit.cursor.kind) {
			case "bof":
				bof.push(edit);
				continue;
			case "eof":
				eof.push(edit);
				continue;
			case "before_anchor":
				push(insertsBefore, edit.cursor.anchor.line, edit);
				continue;
			case "after_anchor":
				push(insertsAfter, edit.cursor.anchor.line, edit);
				continue;
		}
	}

	const out: string[] = [];
	for (const edit of bof) out.push(edit.text);
	for (let line = 1; line <= lineCount; line++) {
		const before = insertsBefore.get(line);
		if (before) for (const edit of before) out.push(edit.text);
		if (!deleted.has(line)) out.push(lines[line - 1]!);
		const after = insertsAfter.get(line);
		if (after) for (const edit of after) out.push(edit.text);
	}
	for (const edit of eof) out.push(edit.text);

	// 首个变化行（相对 NEW 文本的 1-indexed 行号）。
	let firstChangedLine: number | undefined;
	const shared = Math.min(lines.length, out.length);
	for (let i = 0; i < shared; i++) {
		if (lines[i] !== out[i]) {
			firstChangedLine = i + 1;
			break;
		}
	}
	if (firstChangedLine === undefined && lines.length !== out.length) {
		firstChangedLine = shared + 1;
	}

	return { text: out.join("\n"), firstChangedLine };
}
