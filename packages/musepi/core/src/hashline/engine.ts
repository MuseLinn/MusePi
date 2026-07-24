// ============================================================
// hashline — engine：patch 编排器。
//
// 每个文件段：resolve 路径 → 读盘 → BOM/行尾归一化 → 校验
// [PATH#TAG] 锚点（快照一致直接应用；漂移走 recovery；都不行
// 抛可操作错误）→ seen-line guard（可选）→ 内存中应用编辑。
// 全部段 preflight 通过后才统一落盘（原子性：一段坏全不写），
// 写盘时按原 BOM/行尾风格还原。每次成功应用铸造新 TAG 并
// 记录新快照（全部行标为 seen——内容本来就是模型写出的）。
// ============================================================

import { applyEdits } from "./apply.ts";
import { formatHashlineHeader } from "./format.ts";
import { detectLineEnding, normalizeToLF, restoreLineEndings, stripBom } from "./format.ts";
import { parsePatch } from "./parser.ts";
import { collectAnchorLines, tryRecover } from "./recovery.ts";
import type { SnapshotStore } from "./store.ts";
import type { HashlineApplyResult, HashlineFs, SectionApplyResult } from "./types.ts";

export interface HashlineEngineOptions {
	/** 文本语义的文件系统接缝（engine 自己做 BOM/行尾处理）。 */
	fs: HashlineFs;
	/** 铸造并解析 TAG 的快照仓库（必填——TAG 只对铸造它的 store 有意义）。 */
	store: SnapshotStore;
	/** 段路径 → store/磁盘的规范键。默认恒等；host 注入 resolveToCwd。 */
	resolvePath?: (path: string) => string;
	/** seen-line guard：拒绝编辑 read/grep 未展示过的行。默认 false。 */
	enforceSeenLines?: boolean;
}

export interface ApplyPatchOptions {
	/** true 时只 preflight（读+校验+内存应用），不写盘、不铸造新 TAG。 */
	dryRun?: boolean;
}

/** 判断是否为漂移/锚点类错误（区别于 patch 语法错误），供 UI 区分。 */
export class HashlineAnchorError extends Error {
	readonly path: string;
	readonly tag: string;
	constructor(message: string, path: string, tag: string) {
		super(message);
		this.name = "HashlineAnchorError";
		this.path = path;
		this.tag = tag;
	}
}

export function unknownTagError(path: string, tag: string): HashlineAnchorError {
	return new HashlineAnchorError(
		`Unknown tag ${formatHashlineHeader(path, tag)} — this file was not read in this session ` +
			"(or its snapshot aged out). Re-read the file with the read tool, then retry the edit " +
			"with the tag from the fresh [path#TAG] header.",
		path,
		tag,
	);
}

export function staleTagError(path: string, tag: string): HashlineAnchorError {
	return new HashlineAnchorError(
		`The file changed since it was read as ${formatHashlineHeader(path, tag)} and the patch ` +
			"could not be applied safely (the edited lines or their surroundings no longer match " +
			"the snapshot). Re-read the file with the read tool and retry with the new tag.",
		path,
		tag,
	);
}

export function unseenLinesError(path: string, tag: string, lines: readonly number[]): HashlineAnchorError {
	return new HashlineAnchorError(
		`Edit anchors line(s) ${lines.join(", ")} that were never displayed by read/grep under ` +
			`${formatHashlineHeader(path, tag)}. Re-read the file covering those lines and retry ` +
			"(or disable musepi.edit.enforceSeenLines).",
		path,
		tag,
	);
}

interface PreparedSection {
	result: SectionApplyResult;
	/** 还原 BOM/行尾后的最终落盘内容。 */
	finalContent: string;
}

export class HashlineEngine {
	private readonly fs: HashlineFs;
	private readonly store: SnapshotStore;
	private readonly resolvePath: (path: string) => string;
	private readonly enforceSeenLines: boolean;

	constructor(options: HashlineEngineOptions) {
		this.fs = options.fs;
		this.store = options.store;
		this.resolvePath = options.resolvePath ?? ((p) => p);
		this.enforceSeenLines = options.enforceSeenLines ?? false;
	}

	/**
	 * 应用整份 patch（可能含多个文件段）。语法错误、锚点错误、
	 * IO 错误都会抛出并放弃全部写入。
	 */
	async applyPatch(patchText: string, options: ApplyPatchOptions = {}): Promise<HashlineApplyResult> {
		const patch = parsePatch(patchText);
		const prepared: PreparedSection[] = [];
		const warnings: string[] = [...patch.warnings];

		// Phase 1: preflight —— 读、校验、内存应用；任何一段失败都不写盘。
		for (const section of patch.sections) {
			prepared.push(await this.prepareSection(section.path, section.tag, section.edits));
			warnings.push(...prepared[prepared.length - 1]!.result.warnings);
		}

		// Phase 2: commit —— 逐段写盘并铸造新 TAG。
		if (!options.dryRun) {
			for (const section of prepared) {
				await this.fs.writeFile(section.result.absolutePath, section.finalContent);
				const lineCount = section.result.newText.length === 0 ? 0 : section.result.newText.split("\n").length;
				section.result.newTag = this.store.record(
					section.result.absolutePath,
					section.result.newText,
					allLines(lineCount),
				);
			}
		}
		return { sections: prepared.map((s) => s.result), warnings };
	}

	private async prepareSection(
		sectionPath: string,
		tag: string,
		edits: Parameters<typeof applyEdits>[1],
	): Promise<PreparedSection> {
		const absolutePath = this.resolvePath(sectionPath);
		const raw = await this.fs.readFile(absolutePath);
		const { bom, text: withoutBom } = stripBom(raw);
		const ending = detectLineEnding(withoutBom);
		const currentText = normalizeToLF(withoutBom);

		const snapshot = this.store.byHash(absolutePath, tag);
		if (!snapshot) throw unknownTagError(sectionPath, tag);

		if (this.enforceSeenLines && snapshot.seenLines !== undefined) {
			const unseen = collectAnchorLines(edits).filter((line) => !snapshot.seenLines!.has(line));
			if (unseen.length > 0) throw unseenLinesError(sectionPath, tag, unseen);
		}

		let newText: string;
		let firstChangedLine: number | undefined;
		let recovered = false;
		const warnings: string[] = [];

		if (snapshot.text === currentText) {
			const applied = applyEdits(currentText, edits);
			newText = applied.text;
			firstChangedLine = applied.firstChangedLine;
		} else {
			const recovery = tryRecover(snapshot.text, currentText, edits);
			if (!recovery) throw staleTagError(sectionPath, tag);
			newText = recovery.text;
			firstChangedLine = recovery.firstChangedLine;
			recovered = true;
			warnings.push(
				`Recovered from stale tag ${formatHashlineHeader(sectionPath, tag)}: the file changed on disk, ` +
					`but every edited line was relocated unambiguously (offset ${recovery.offset >= 0 ? "+" : ""}${recovery.offset}). ` +
					"Re-read the file before the next edit — the minted tag below supersedes the one you used.",
			);
		}

		return {
			result: {
				absolutePath,
				oldText: currentText,
				newText,
				newTag: "", // dryRun 时不铸造；commit 阶段回填
				firstChangedLine,
				recovered,
				warnings,
			},
			finalContent: bom + restoreLineEndings(newText, ending),
		};
	}
}

function* allLines(count: number): Iterable<number> {
	for (let i = 1; i <= count; i++) yield i;
}
