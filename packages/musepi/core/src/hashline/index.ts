// hashline — public barrel. 引擎本体零 pi import，host 经此引入。
export { applyEdits } from "./apply.ts";
export { HashlineAnchorError, HashlineEngine, staleTagError, unknownTagError, unseenLinesError } from "./engine.ts";
export type { ApplyPatchOptions, HashlineEngineOptions } from "./engine.ts";
export {
	computeFileHash,
	detectLineEnding,
	formatHashlineHeader,
	formatNumberedLine,
	formatNumberedLines,
	HL_TAG_LENGTH,
	looksLikeHeader,
	normalizeToLF,
	parseHashlineHeader,
	restoreLineEndings,
	stripBom,
	UTF8_BOM,
} from "./format.ts";
export { parsePatch } from "./parser.ts";
export { HASHLINE_EDIT_DESCRIPTION, HASHLINE_EDIT_PROMPT_GUIDELINES } from "./prompt.ts";
export { collectAnchorLines, findUniformOffset, remapEdits, tryRecover } from "./recovery.ts";
export { SnapshotStore } from "./store.ts";
export type { Snapshot, SnapshotStoreOptions } from "./store.ts";
export type {
	Anchor,
	ApplyResult,
	Cursor,
	Edit,
	HashlineApplyResult,
	HashlineFs,
	ParsedPatch,
	ParsedSection,
	SectionApplyResult,
} from "./types.ts";
