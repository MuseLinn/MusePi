// ============================================================
// memory — BM25 检索（零依赖，TS 直实现）。
//
// 文档粒度 = 记忆文件中的单个条目行（标题行除外）。分数地板
// 取 top hit 的 15%（MiMo 同款）：只把"和 top 相比还有意义"
// 的行返回给模型，常见词噪音（the / 的）自然沉底被滤掉。
// ============================================================

export interface Bm25Document {
	/** 0-based 文档序号（调用方映射回行号等）。 */
	index: number;
	tokens: string[];
	/** 原文（返回片段用）。 */
	text: string;
}

export interface Bm25Hit {
	index: number;
	score: number;
	text: string;
}

const K1 = 1.5;
const B = 0.75;
/** MiMo 同款相对地板：top hit 的 15%。 */
export const RELATIVE_SCORE_FLOOR = 0.15;

/**
 * 分词：英文/数字/下划线连续段为一词；CJK 逐字成词（无词典的
 * 最小可用切分，配合 BM25 的词项独立性假设误差可接受）。
 */
export function tokenize(text: string): string[] {
	const tokens: string[] = [];
	const re = /[a-zA-Z0-9_]+|[一-鿿㐀-䶿]/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		tokens.push(m[0].toLowerCase());
	}
	return tokens;
}

export interface Bm25Index {
	avgDocLength: number;
	docCount: number;
	/** term → 包含该 term 的文档数。 */
	documentFreq: Map<string, number>;
	/** doc index → (term → tf)。 */
	termFreqs: Map<number, Map<string, number>>;
	docLengths: Map<number, number>;
}

export function buildIndex(documents: Bm25Document[]): Bm25Index {
	const documentFreq = new Map<string, number>();
	const termFreqs = new Map<number, Map<string, number>>();
	const docLengths = new Map<number, number>();
	let totalLength = 0;

	for (const doc of documents) {
		const tf = new Map<string, number>();
		for (const token of doc.tokens) {
			tf.set(token, (tf.get(token) ?? 0) + 1);
		}
		termFreqs.set(doc.index, tf);
		docLengths.set(doc.index, doc.tokens.length);
		totalLength += doc.tokens.length;
		for (const term of tf.keys()) {
			documentFreq.set(term, (documentFreq.get(term) ?? 0) + 1);
		}
	}

	return {
		avgDocLength: documents.length > 0 ? totalLength / documents.length : 0,
		docCount: documents.length,
		documentFreq,
		termFreqs,
		docLengths,
	};
}

function idf(index: Bm25Index, term: string): number {
	const df = index.documentFreq.get(term) ?? 0;
	// Robertson-Spärck Jones IDF, +1 平滑避免负值/除零。
	return Math.log(1 + (index.docCount - df + 0.5) / (df + 0.5));
}

export function scoreDocument(index: Bm25Index, docIndex: number, queryTokens: readonly string[]): number {
	const tf = index.termFreqs.get(docIndex);
	if (!tf) return 0;
	const docLength = index.docLengths.get(docIndex) ?? 0;
	const norm = index.avgDocLength > 0 ? docLength / index.avgDocLength : 0;
	let score = 0;
	for (const term of queryTokens) {
		const f = tf.get(term);
		if (f === undefined) continue;
		score += idf(index, term) * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * norm)));
	}
	return score;
}

/**
 * 查询：BM25 排序后按相对地板过滤（score >= topScore * 15%）。
 * 全部零分或无命中时返回空数组——调用方据此回复"无相关记忆"。
 */
export function searchIndex(
	index: Bm25Index,
	documents: readonly Bm25Document[],
	query: string,
	maxHits = 10,
): Bm25Hit[] {
	const queryTokens = [...new Set(tokenize(query))];
	if (queryTokens.length === 0) return [];
	const scored: Bm25Hit[] = [];
	for (const doc of documents) {
		const score = scoreDocument(index, doc.index, queryTokens);
		if (score > 0) scored.push({ index: doc.index, score, text: doc.text });
	}
	if (scored.length === 0) return [];
	scored.sort((a, b) => b.score - a.score);
	const floor = scored[0]!.score * RELATIVE_SCORE_FLOOR;
	return scored.filter((hit) => hit.score >= floor).slice(0, maxHits);
}
