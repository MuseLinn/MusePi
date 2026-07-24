// ============================================================
// hashline — 会话内快照仓库。
//
// read/grep 展示文件内容时调用 record() 记录整文件归一化文本，
// 返回内容派生的 4-hex tag。edit 时凭 tag 找回模型锚定的那份快照，
// 与磁盘实况比对：一致 → 直接应用；漂移 → recovery 重映射锚点。
//
// 去重按全文相等（不是 tag 相等）：两个不同文本撞 16-bit tag 时
// 仍保留为两个版本，tag 只是索引，不是身份。
// ============================================================

import { computeFileHash } from "./format.ts";

export interface Snapshot {
	/** 规范路径（engine resolve 后的绝对路径）。 */
	readonly path: string;
	/** 观察到的整文件归一化文本（LF、无 BOM）。 */
	readonly text: string;
	/** 内容派生 tag。 */
	readonly hash: string;
	recordedAt: number;
	/**
	 * read/grep 在该 tag 下实际展示给模型的 1-indexed 行集合。
	 * undefined = 无出处记录（seen-line guard 跳过）。多次读取并集合并。
	 */
	seenLines?: Set<number>;
}

export interface SnapshotStoreOptions {
	/** 最多跟踪的路径数（LRU 淘汰）。 */
	maxPaths?: number;
	/** 每路径保留的版本数（最旧先丢）。 */
	maxVersionsPerPath?: number;
}

const DEFAULT_MAX_PATHS = 30;
const DEFAULT_MAX_VERSIONS_PER_PATH = 4;

function mergeSeenLines(snapshot: Snapshot, lines: Iterable<number> | undefined): void {
	if (lines === undefined) return;
	if (snapshot.seenLines === undefined) snapshot.seenLines = new Set<number>();
	for (const line of lines) snapshot.seenLines.add(line);
}

export class SnapshotStore {
	readonly #versions = new Map<string, Snapshot[]>();
	readonly #maxPaths: number;
	readonly #maxVersionsPerPath: number;

	constructor(options: SnapshotStoreOptions = {}) {
		this.#maxPaths = options.maxPaths ?? DEFAULT_MAX_PATHS;
		this.#maxVersionsPerPath = options.maxVersionsPerPath ?? DEFAULT_MAX_VERSIONS_PER_PATH;
	}

	/** path 的最新版本。 */
	head(path: string): Snapshot | null {
		return this.#versions.get(path)?.[0] ?? null;
	}

	/** path 下 tag 为 hash 的版本（撞 tag 时取最新记录的）。 */
	byHash(path: string, hash: string): Snapshot | null {
		return this.#versions.get(path)?.find((v) => v.hash === hash) ?? null;
	}

	/** path 下全文相等的版本。 */
	byContent(path: string, fullText: string): Snapshot | null {
		return this.#versions.get(path)?.find((v) => v.text === fullText) ?? null;
	}

	/**
	 * 记录整文件归一化文本，返回 tag。同内容重复记录刷新热度并复用 tag；
	 * seenLines 并集合并进对应版本。
	 */
	record(path: string, fullText: string, seenLines?: Iterable<number>): string {
		const hash = computeFileHash(fullText);
		// get 后再 set，刷新 LRU 热度
		const history = this.#versions.get(path) ?? [];
		const existing = history.find((v) => v.hash === hash && v.text === fullText);
		if (existing) {
			existing.recordedAt = Date.now();
			mergeSeenLines(existing, seenLines);
			if (history[0] !== existing) {
				this.#versions.set(path, [existing, ...history.filter((v) => v !== existing)]);
			} else {
				this.#versions.set(path, history);
			}
			return hash;
		}
		const snapshot: Snapshot = { path, text: fullText, hash, recordedAt: Date.now() };
		mergeSeenLines(snapshot, seenLines);
		this.#versions.set(path, [snapshot, ...history].slice(0, this.#maxVersionsPerPath));
		// LRU：超出路径数上限时淘汰最久未用的路径
		while (this.#versions.size > this.#maxPaths) {
			const oldest = this.#versions.keys().next();
			if (oldest.done) break;
			this.#versions.delete(oldest.value);
		}
		return hash;
	}

	/** 事后补充某版本的展示行（输出格式化晚于 tag 铸造时使用）。 */
	recordSeenLines(path: string, hash: string, lines: Iterable<number>): void {
		const version = this.#versions.get(path)?.find((v) => v.hash === hash);
		if (version) mergeSeenLines(version, lines);
	}

	invalidate(path: string): void {
		this.#versions.delete(path);
	}

	clear(): void {
		this.#versions.clear();
	}
}
