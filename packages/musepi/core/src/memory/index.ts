// memory — public barrel. 引擎零 pi import，host 经此引入。
export { RELATIVE_SCORE_FLOOR, buildIndex, scoreDocument, searchIndex, tokenize } from "./bm25.ts";
export type { Bm25Document, Bm25Hit, Bm25Index } from "./bm25.ts";
export { DEFAULT_MEMORY_CAPS, buildMemoryInjection, estimateTokens, truncateToBudget } from "./inject.ts";
export type { BuildInjectionOptions, MemoryCaps } from "./inject.ts";
export { searchMemory } from "./ops.ts";
export type { MemorySearchHit, MemorySearchSource } from "./ops.ts";
export { computeProjectId, memoryPaths } from "./paths.ts";
export type { MemoryPaths } from "./paths.ts";
export {
	MEMORY_SECTIONS,
	editEntry,
	isEmptyMemory,
	memorySkeleton,
	readMemoryFile,
	retainEntry,
	writeMemoryFile,
} from "./store.ts";
export type { EditResult, MemorySection, RetainResult } from "./store.ts";
