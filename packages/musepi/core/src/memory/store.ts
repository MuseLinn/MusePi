// ============================================================
// memory — 记忆文件读写。文件是权威、人可读可改；索引只是查询
// 时的临时视图，不做持久缓存（v1 文件 <10KB，全量扫描足够快）。
// ============================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** 四个固定小节。retain 默认落 Durable knowledge；edit 不限小节。 */
export const MEMORY_SECTIONS = [
	"Project context",
	"Rules",
	"Architecture decisions",
	"Durable knowledge",
] as const;

export type MemorySection = (typeof MEMORY_SECTIONS)[number];

export function memorySkeleton(kind: "project" | "global"): string {
	const title = kind === "project" ? "Project Memory" : "Global Memory";
	return [`# ${title}`, "", ...MEMORY_SECTIONS.flatMap((s) => [`## ${s}`, ""]), ""].join("\n");
}

/** 懒创建：文件不存在时写入骨架后返回其内容。 */
export function readMemoryFile(filePath: string, kind: "project" | "global"): string {
	if (!existsSync(filePath)) {
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, memorySkeleton(kind), "utf-8");
	}
	return readFileSync(filePath, "utf-8");
}

export function writeMemoryFile(filePath: string, content: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, content, "utf-8");
}

/** 文件是否只有骨架（无实际条目）——此时启动注入整体跳过。 */
export function isEmptyMemory(content: string): boolean {
	return content
		.split("\n")
		.every((line) => line.trim() === "" || line.startsWith("#"));
}

export interface RetainResult {
	/** true = 追加成功；false = 相邻重复被去重跳过。 */
	appended: boolean;
	line: number;
}

function formatRetainEntry(fact: string): string {
	const date = new Date().toISOString().slice(0, 10);
	return `- [${date}] ${fact.trim()}`;
}

/**
 * retain：把一条事实追加到指定小节末尾（`- [date] fact` 一行）。
 * 去重只针对相邻重复——新条目与小节内最后一条条目文本相同则跳过，
 * 避免 agent 在同一轮里反复刷同一条事实。
 */
export function retainEntry(
	filePath: string,
	kind: "project" | "global",
	fact: string,
	section: MemorySection = "Durable knowledge",
): RetainResult {
	const trimmed = fact.trim();
	if (trimmed.length === 0) throw new Error("retain: fact must be non-empty.");
	const content = readMemoryFile(filePath, kind);
	const lines = content.split("\n");

	const heading = `## ${section}`;
	const headingIndex = lines.findIndex((line) => line.trim() === heading);
	if (headingIndex < 0) {
		throw new Error(`retain: memory file is missing the "${heading}" section. Restore the skeleton or pick another section.`);
	}

	// 小节范围：heading 之后到下一个 ## 或 EOF。
	let sectionEnd = lines.length;
	for (let i = headingIndex + 1; i < lines.length; i++) {
		if (lines[i]!.startsWith("## ")) {
			sectionEnd = i;
			break;
		}
	}

	const entry = formatRetainEntry(trimmed);
	// 相邻去重：与小节内最后一条非空条目行比较。
	let lastEntryIndex = -1;
	for (let i = sectionEnd - 1; i > headingIndex; i--) {
		if (lines[i]!.trim().length > 0) {
			lastEntryIndex = i;
			break;
		}
	}
	if (lastEntryIndex > 0 && lines[lastEntryIndex]!.trim() === entry.trim()) {
		return { appended: false, line: lastEntryIndex + 1 };
	}

	// 插入到 sectionEnd 前，保持小节间恰好一个空行分隔。
	const insertAt = lastEntryIndex > 0 ? lastEntryIndex + 1 : headingIndex + 1;
	const next = [...lines];
	if (lastEntryIndex > 0) {
		// 已有条目：跟一行，并把原来的分隔空行往后推。
		next.splice(insertAt, 0, entry);
	} else {
		// 小节内首条：标题行后紧跟。
		next.splice(insertAt, 0, entry);
	}
	writeMemoryFile(filePath, next.join("\n"));
	return { appended: true, line: insertAt + 1 };
}

export interface EditResult {
	replaced: boolean;
	line: number;
}

/**
 * edit：按锚点文本改写条目。anchor 必须是非空字符串，且在文件中
 * 出现恰好一次（去空白后按行匹配）——0 次报"未找到"，多次报
 * "锚点不唯一"，都是可操作错误。
 */
export function editEntry(filePath: string, kind: "project" | "global", anchor: string, replacement: string): EditResult {
	const needle = anchor.trim();
	if (needle.length === 0) throw new Error("edit: anchor must be non-empty.");
	const content = readMemoryFile(filePath, kind);
	const lines = content.split("\n");

	const matches: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]!.includes(needle)) matches.push(i);
	}
	if (matches.length === 0) {
		throw new Error(`edit: anchor not found in ${filePath}. Use memory search to locate the exact line first.`);
	}
	if (matches.length > 1) {
		throw new Error(
			`edit: anchor matches ${matches.length} lines (${matches.map((i) => i + 1).join(", ")}). Provide a longer, unique anchor.`,
		);
	}

	const index = matches[0]!;
	// 整行替换，保留原行前导空白。
	const indent = /^\s*/.exec(lines[index]!)![0];
	lines[index] = `${indent}${replacement.trim()}`;
	writeMemoryFile(filePath, lines.join("\n"));
	return { replaced: true, line: index + 1 };
}
