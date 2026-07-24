// ============================================================
// hashline — 纯数据类型。parser / apply / recovery / engine 共享。
// 本文件不引用 fs、agent runtime 或任何 pi 模块，保持纯粹。
// ============================================================

/** 行号锚点（1-indexed）。 */
export interface Anchor {
	line: number;
}

/** insert 编辑的落点。 */
export type Cursor =
	| { kind: "bof" }
	| { kind: "eof" }
	| { kind: "before_anchor"; anchor: Anchor }
	| { kind: "after_anchor"; anchor: Anchor };

/**
 * parser 产出的单条低层编辑，applier 消费。
 * SWAP N.=M 分解为：每条替换体一行 insert（mode="replacement"，锚在 N 前）
 * + N..M 每行一条 delete。
 */
export type Edit =
	| {
			kind: "insert";
			cursor: Cursor;
			text: string;
			/** patch 文本中该编辑来源的行号（用于报错定位）。 */
			lineNum: number;
			/** patch 内的稳定序号。 */
			index: number;
			mode?: "replacement";
	  }
	| { kind: "delete"; anchor: Anchor; lineNum: number; index: number };

/** 一个解析出的文件段：[PATH#TAG] + 该段全部编辑。 */
export interface ParsedSection {
	/** header 里的路径（模型视角，可能是相对路径）。 */
	path: string;
	/** header 里的 4-hex tag（大写规范形）。 */
	tag: string;
	edits: Edit[];
	/** header 在 patch 文本中的行号。 */
	lineNum: number;
}

export interface ParsedPatch {
	sections: ParsedSection[];
	warnings: string[];
}

/** applyEdits 的结果。 */
export interface ApplyResult {
	/** 编辑后的文本。 */
	text: string;
	/** 第一个发生变化的行号（1-indexed），无变化为 undefined。 */
	firstChangedLine: number | undefined;
}

/** 注入给 engine 的文件系统接缝（UTF-8 文本语义）。 */
export interface HashlineFs {
	readFile(absolutePath: string): Promise<string>;
	writeFile(absolutePath: string, content: string): Promise<void>;
}

/** engine.applyPatch 单个文件段的应用结果。 */
export interface SectionApplyResult {
	/** engine resolve 后的绝对路径。 */
	absolutePath: string;
	/** 应用前 LF 归一化内容。 */
	oldText: string;
	/** 应用后 LF 归一化内容。 */
	newText: string;
	/** 本次应用铸造的新 tag。 */
	newTag: string;
	firstChangedLine: number | undefined;
	/** 是否走了 recovery（快照漂移但锚点重映射成功）。 */
	recovered: boolean;
	warnings: string[];
}

export interface HashlineApplyResult {
	sections: SectionApplyResult[];
	warnings: string[];
}
