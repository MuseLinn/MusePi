// snapcompact — public barrel. 引擎零 pi import，host 经此引入。
export {
	DEFAULT_ARCHIVE_MAX_CHARS,
	elisionNotice,
	estimateTokensFromChars,
	FRAME_CHAR_CAPACITY,
	planArchive,
} from "./archive.ts";
export type { ArchiveLayout } from "./archive.ts";
export { snapCompact, SNAP_ARCHIVE_VERSION } from "./engine.ts";
export { computeFileLists, formatFileList, formatFilesSection, isUrlSchemePath } from "./files.ts";
export {
	serializeConversation,
	TOOL_ARG_MAX_CHARS,
	TOOL_CALL_MAX_CHARS,
	TOOL_RESULT_MAX_CHARS,
	TRUNCATE_HEAD_RATIO,
	truncateForArchive,
} from "./serialize.ts";
export type { SerializeOptions } from "./types.ts";
export type {
	SnapArchiveState,
	SnapCompactionInput,
	SnapCompactionResult,
	SnapContentBlock,
	SnapFileOperations,
	SnapFrame,
	SnapMessage,
} from "./types.ts";
