// ============================================================
// hashline — patch 文本解析。
//
// patch 结构：若干文件段，每段以 [PATH#TAG] 开头，下面是 hunk：
//   SWAP N.=M:   替换原始第 N..M 行（含 M），下一行起为 + 前缀的新内容
//   SWAP N:      单行简写（等价 SWAP N.=N:）
//   DEL N.=M / DEL N   删除原始第 N..M 行，无函数体
//   INS.PRE N:   在第 N 行前插入
//   INS.POST N:  在第 N 行后插入
//   INS.HEAD: / INS.TAIL:  在文件头/尾插入
// 函数体每行以 + 开头（"+"/"+" 单独成行 = 空行）。行号永远指原始文件，
// 不随 hunk 应用而移动。
// ============================================================

import { looksLikeHeader, parseHashlineHeader } from "./format.ts";
import type { Anchor, Cursor, Edit, ParsedPatch, ParsedSection } from "./types.ts";

const SWAP_RE = /^SWAP\s+([1-9]\d*)\s*(?:\.=\s*([1-9]\d*)\s*)?:$/;
const DEL_RE = /^DEL\s+([1-9]\d*)(?:\s*\.=\s*([1-9]\d*))?$/;
const INS_RE = /^INS\.(PRE|POST)\s+([1-9]\d*)\s*:$/;
const INS_EDGE_RE = /^INS\.(HEAD|TAIL)\s*:$/;

const BARE_BODY_WARNING =
	"Body rows without a leading `+` were accepted as literal content. Prefix every body row with `+` to be explicit.";

interface PendingOp {
	/** 目标描述，flush 时生成 edits。 */
	target:
		| { kind: "replace"; start: Anchor; end: Anchor }
		| { kind: "delete"; start: Anchor; end: Anchor }
		| { kind: "insert"; cursor: Cursor };
	lineNum: number;
	body: string[];
	sawBareRow: boolean;
}

function expandRange(start: number, end: number): Anchor[] {
	const anchors: Anchor[] = [];
	for (let line = start; line <= end; line++) anchors.push({ line });
	return anchors;
}

function flushPending(pending: PendingOp, edits: Edit[], nextIndex: () => number): void {
	const { target, lineNum, body } = pending;
	if (target.kind === "delete") {
		for (const anchor of expandRange(target.start.line, target.end.line)) {
			edits.push({ kind: "delete", anchor, lineNum, index: nextIndex() });
		}
		return;
	}
	if (body.length === 0) {
		if (target.kind === "replace") {
			throw new Error(
				`line ${lineNum}: SWAP with an empty body deletes the range — use \`DEL ${target.start.line}.=${target.end.line}\` instead.`,
			);
		}
		throw new Error(`line ${lineNum}: insert op has an empty body. Add \`+text\` rows below the header.`);
	}
	if (target.kind === "replace") {
		const cursor: Cursor = { kind: "before_anchor", anchor: { ...target.start } };
		for (const text of body) {
			edits.push({ kind: "insert", cursor, text, lineNum, index: nextIndex(), mode: "replacement" });
		}
		for (const anchor of expandRange(target.start.line, target.end.line)) {
			edits.push({ kind: "delete", anchor, lineNum, index: nextIndex() });
		}
		return;
	}
	for (const text of body) {
		edits.push({ kind: "insert", cursor: target.cursor, text, lineNum, index: nextIndex() });
	}
}

/** 校验同一文件段内 delete 锚点不重叠（两个 hunk 覆盖同一原始行）。 */
function validateNoOverlappingDeletes(section: ParsedSection): void {
	const seen = new Map<number, number>();
	for (const edit of section.edits) {
		if (edit.kind !== "delete") continue;
		const first = seen.get(edit.anchor.line);
		if (first !== undefined) {
			throw new Error(
				`line ${edit.lineNum}: original line ${edit.anchor.line} is already targeted by another hunk (line ${first}). ` +
					"Issue ONE hunk per range; merge overlapping changes into a single SWAP.",
			);
		}
		seen.set(edit.anchor.line, edit.lineNum);
	}
}

/**
 * 解析 patch 文本。语法错误抛带 patch 行号的可操作 Error。
 */
export function parsePatch(patchText: string): ParsedPatch {
	const lines = patchText.split("\n");
	const warnings: string[] = [];
	const sections: ParsedSection[] = [];
	let current: ParsedSection | null = null;
	let pending: PendingOp | null = null;
	let editIndex = 0;
	const nextIndex = () => editIndex++;

	const flush = () => {
		if (pending && current) {
			flushPending(pending, current.edits, nextIndex);
			if (pending.sawBareRow && !warnings.includes(BARE_BODY_WARNING)) warnings.push(BARE_BODY_WARNING);
		}
		pending = null;
	};

	for (let i = 0; i < lines.length; i++) {
		const lineNum = i + 1;
		const raw = lines[i];
		const trimmed = raw.trim();

		const header = parseHashlineHeader(raw);
		if (header) {
			flush();
			current = { path: header.path, tag: header.tag, edits: [], lineNum };
			sections.push(current);
			continue;
		}

		const swap = SWAP_RE.exec(trimmed);
		if (swap) {
			flush();
			if (!current) throw new Error(`line ${lineNum}: hunk header has no preceding [PATH#TAG] section header.`);
			const start = Number(swap[1]);
			const end = swap[2] !== undefined ? Number(swap[2]) : start;
			if (end < start) throw new Error(`line ${lineNum}: range ${start}.=${end} ends before it starts.`);
			pending = { target: { kind: "replace", start: { line: start }, end: { line: end } }, lineNum, body: [], sawBareRow: false };
			continue;
		}

		const del = DEL_RE.exec(trimmed);
		if (del) {
			flush();
			if (!current) throw new Error(`line ${lineNum}: hunk header has no preceding [PATH#TAG] section header.`);
			const start = Number(del[1]);
			const end = del[2] !== undefined ? Number(del[2]) : start;
			if (end < start) throw new Error(`line ${lineNum}: range ${start}.=${end} ends before it starts.`);
			pending = { target: { kind: "delete", start: { line: start }, end: { line: end } }, lineNum, body: [], sawBareRow: false };
			continue;
		}

		const ins = INS_RE.exec(trimmed);
		if (ins) {
			flush();
			if (!current) throw new Error(`line ${lineNum}: hunk header has no preceding [PATH#TAG] section header.`);
			const anchor: Anchor = { line: Number(ins[2]) };
			const cursor: Cursor =
				ins[1] === "PRE" ? { kind: "before_anchor", anchor } : { kind: "after_anchor", anchor };
			pending = { target: { kind: "insert", cursor }, lineNum, body: [], sawBareRow: false };
			continue;
		}

		const insEdge = INS_EDGE_RE.exec(trimmed);
		if (insEdge) {
			flush();
			if (!current) throw new Error(`line ${lineNum}: hunk header has no preceding [PATH#TAG] section header.`);
			const cursor: Cursor = insEdge[1] === "HEAD" ? { kind: "bof" } : { kind: "eof" };
			pending = { target: { kind: "insert", cursor }, lineNum, body: [], sawBareRow: false };
			continue;
		}

		// 函数体行
		if (pending) {
			if (pending.target.kind === "delete") {
				if (trimmed.length === 0) continue;
				throw new Error(`line ${lineNum}: DEL takes no body. Remove rows below the DEL header.`);
			}
			if (raw.startsWith("+")) {
				pending.body.push(raw.slice(1));
				continue;
			}
			if (trimmed.length === 0) {
				// hunk 内的空行视作布局分隔；要插入空行请用单独的 "+" 行
				continue;
			}
			if (trimmed.startsWith("-")) {
				throw new Error(
					`line ${lineNum}: \`-old\` rows do not exist in hashline. The range deletes the old content; the body is only the final content, every row prefixed with \`+\`.`,
				);
			}
			if (looksLikeHeader(raw)) {
				// 不可达（上面已处理），防御分支
				flush();
				continue;
			}
			// 裸行：宽容接受为字面内容并告警（模型常忘加 + 前缀）
			pending.body.push(raw);
			pending.sawBareRow = true;
			continue;
		}

		if (trimmed.length === 0) continue;
		throw new Error(
			`line ${lineNum}: content outside any hunk. Start a file section with [PATH#TAG], then use \`SWAP N.=M:\`, \`DEL N.=M\`, or \`INS.PRE|POST|HEAD|TAIL:\` above the body. Got ${JSON.stringify(raw)}.`,
		);
	}
	flush();

	if (sections.length === 0) {
		throw new Error("No [PATH#TAG] file section found. The patch must start with a section header like [src/foo.ts#1A2B].");
	}
	for (const section of sections) {
		if (section.edits.length === 0) {
			throw new Error(`line ${section.lineNum}: section [${section.path}#${section.tag}] contains no hunks.`);
		}
		validateNoOverlappingDeletes(section);
	}
	return { sections, warnings };
}
