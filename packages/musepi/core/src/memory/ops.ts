// ============================================================
// memory — 查询编排：跨记忆文件 BM25，返回带来源路径+行号的片段。
// ============================================================

import { buildIndex, searchIndex, tokenize as tokenizeLine, type Bm25Document, type Bm25Hit } from "./bm25.ts";
import { readMemoryFile } from "./store.ts";

export interface MemorySearchHit {
	/** 来源记忆文件的绝对路径（artifact 引用）。 */
	file: string;
	/** 1-based 行号。 */
	line: number;
	score: number;
	text: string;
}

export interface MemorySearchSource {
	file: string;
	kind: "project" | "global";
}

/** 把记忆文件切分为检索文档：非空、非标题行，各行一行号。 */
function documentsOf(source: MemorySearchSource): { docs: Bm25Document[]; lines: number[] } {
	const content = readMemoryFile(source.file, source.kind);
	const docs: Bm25Document[] = [];
	const lines: number[] = [];
	const rawLines = content.split("\n");
	let index = 0;
	for (let i = 0; i < rawLines.length; i++) {
		const text = rawLines[i]!.trim();
		if (text.length === 0 || text.startsWith("#")) continue;
		docs.push({ index, tokens: tokenizeLine(text), text });
		lines.push(i + 1);
		index++;
	}
	return { docs, lines };
}

/**
 * 跨来源检索。结果按分数降序合并，带来源路径与行号——模型引用
 * 记忆内容时必须附上这个 artifact 位置。
 */
export function searchMemory(sources: readonly MemorySearchSource[], query: string, maxHits = 10): MemorySearchHit[] {
	const allDocs: Bm25Document[] = [];
	const provenance: Array<{ file: string; line: number }> = [];
	for (const source of sources) {
		const { docs, lines } = documentsOf(source);
		for (let i = 0; i < docs.length; i++) {
			allDocs.push({ index: allDocs.length, tokens: docs[i]!.tokens, text: docs[i]!.text });
			provenance.push({ file: source.file, line: lines[i]! });
		}
	}
	if (allDocs.length === 0) return [];
	const hits: Bm25Hit[] = searchIndex(buildIndex(allDocs), allDocs, query, maxHits);
	return hits.map((hit) => ({
		file: provenance[hit.index]!.file,
		line: provenance[hit.index]!.line,
		score: hit.score,
		text: hit.text,
	}));
}
