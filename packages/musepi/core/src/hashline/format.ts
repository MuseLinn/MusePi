// ============================================================
// hashline — 格式原语：tag 计算、header 格式化、LINE:TEXT 展示。
// ============================================================

/** tag 的 hex 位数。 */
export const HL_TAG_LENGTH = 4;

/** section header 的规范形态：[path#TAG]，TAG 为 4 位大写 hex。 */
const HL_HEADER_RE = /^\[([^\]#[\]]+)#([0-9A-Fa-f]{4})\]\s*$/;

/**
 * 计算 tag 前的文本归一化：去掉每行末尾的 [ \t\r]，
 * 使 CRLF 行尾与展示层 trim 不影响 tag 稳定性。
 */
function normalizeHashText(text: string): string {
	return text.replace(/[ \t\r]+(?=\n|$)/g, "");
}

/**
 * 内容派生的 4-hex 快照 tag（FNV-1a 32-bit 取低 16 位）。
 * 整文件归一化文本的指纹：内容一致 ⇒ tag 一致；文件被外部改动 ⇒ tag 失配。
 */
export function computeFileHash(text: string): string {
	const normalized = normalizeHashText(text);
	let hash = 0x811c9dc5;
	for (let i = 0; i < normalized.length; i++) {
		hash ^= normalized.charCodeAt(i);
		// FNV prime 乘法（32 位，用 Math.imul 保持整数语义）
		hash = Math.imul(hash, 0x01000193);
	}
	const low16 = hash & 0xffff;
	return low16.toString(16).padStart(HL_TAG_LENGTH, "0").toUpperCase();
}

/** 解析 section header 行；不匹配返回 null。 */
export function parseHashlineHeader(line: string): { path: string; tag: string } | null {
	const m = HL_HEADER_RE.exec(line.trim());
	if (!m) return null;
	return { path: m[1].trim(), tag: m[2].toUpperCase() };
}

/** 判断一行是否形如 section header（容错用）。 */
export function looksLikeHeader(line: string): boolean {
	return HL_HEADER_RE.test(line.trim());
}

/** 格式化 section header。 */
export function formatHashlineHeader(path: string, tag: string): string {
	return `[${path}#${tag}]`;
}

/** 格式化单行展示：LINE:TEXT。 */
export function formatNumberedLine(lineNumber: number, line: string): string {
	return `${lineNumber}:${line}`;
}

/** 将文本按 LINE:TEXT 行格式展示（startLine 为 1-indexed 起始行号）。 */
export function formatNumberedLines(text: string, startLine = 1): string {
	const lines = text.split("\n");
	return lines.map((line, i) => formatNumberedLine(startLine + i, line)).join("\n");
}

export type LineEnding = "\r\n" | "\n";

export function detectLineEnding(content: string): LineEnding {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

export function restoreLineEndings(text: string, ending: LineEnding): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/** UTF-8 BOM 常量（避免在源码里嵌不可见字符）。 */
export const UTF8_BOM = "\uFEFF";

export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith(UTF8_BOM) ? { bom: UTF8_BOM, text: content.slice(1) } : { bom: "", text: content };
}
