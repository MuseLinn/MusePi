import * as fs from "node:fs/promises";
import * as path from "node:path";
import { splitAddressableFileLines } from "@musepi/hashline";
import { type } from "@musepi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolTier,
} from "@musepi/pi-agent-core";
import type { ImageContent, TextContent } from "@musepi/pi-ai";
import { type ImageMetadata, isProbablyBinary, logger, prompt, readImageMetadata } from "@musepi/pi-utils";
import {
	canonicalSnapshotKey,
	getFileSnapshotStore,
	recordFileSnapshot,
	recordSeenLinesFromBody,
	SNAPSHOT_MAX_BYTES,
} from "../edit/file-snapshot-store";
import { normalizeToLF } from "../edit/normalize";
import { isNotebookPath, readEditableNotebookText } from "../edit/notebook";
import { InternalUrlRouter, resolveLocalUrlToFile, resolveLocalUrlToPath } from "../internal-urls";
import { type ResolvedArtifactFile, resolveArtifactFile } from "../internal-urls/artifact-protocol";
import { parseInternalUrl } from "../internal-urls/parse";
import type { InternalUrl } from "../internal-urls/types";
import readDescription from "../prompts/tools/read.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type TruncationResult,
	truncateHead,
	truncateHeadBytes,
	truncateLine,
} from "../session/streaming-output";
import { buildLineEntriesWithBlockContext, lineEntriesToPlainText } from "../utils/block-context";
import { isCpuProfilePath, renderCpuProfile } from "../utils/cpuprofile";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import {
	ImageInputTooLargeError,
	loadImageInput,
	MAX_IMAGE_INPUT_BYTES,
	webpExclusionForModel,
} from "../utils/image-loading";
import { isInspectImageToolActive } from "../utils/inspect-image-mode";
import { CONVERTIBLE_EXTENSIONS, convertFileWithMarkit } from "../utils/markit";
import { isSampleProfilePath, renderSampleProfile } from "../utils/sample-profile";
import { buildDirectoryTree, type DirectoryTree } from "../workspace-tree";
import {
	type ConflictEntry,
	type ConflictScope,
	formatConflictSummary,
	formatConflictWarning,
	getConflictHistory,
	parseConflictUri,
	renderConflictRegion,
	scanConflictLines,
	scanFileForConflicts,
} from "./conflict-detect";
import { executeReadUrl, fetchReadUrl, parseReadUrlTarget } from "./fetch";
import { type OutputMeta, resolveOutputMaxColumns } from "./output-meta";
import {
	expandPath,
	formatPathRelativeToCwd,
	type LineRange,
	pathTargetsSsh,
	probeLiteralPathExists,
	resolveReadPath,
	splitDelimitedPathEntry,
	splitInternalUrlSel,
	splitPathAndSel,
	splitPathAndSelPreferringLiteral,
} from "./path-utils";
import { readArchive, resolveArchiveReadPath } from "./read-archive";
import {
	BRACKET_CONTEXT_ELLIPSIS,
	buildInMemoryMultiRangeResult,
	buildInMemoryTextResult,
	contiguousLineNumbers,
	countTextLines,
	formatLineEntriesWithMode,
	formatReadHashlineHeader,
	formatSummaryElisionFooter,
	formatTextWithMode,
	type HashlineHeaderContext,
	hashlineHeaderContext,
	lineNumbersFromSpans,
	markMarkdownContentType,
	prependHashlineHeader,
	prependSuffixResolutionNotice,
	RANGE_LEADING_CONTEXT_LINES,
	RANGE_TRAILING_CONTEXT_LINES,
	READ_CHUNK_SIZE,
	readHashlineHeaderContext,
} from "./read-format";
import {
	findSuffixMatchCached,
	isNotFoundError,
	isRemoteMountPath,
	type SuffixMatchCache,
} from "./read-path-resolution";
import { type PdfImageReadTarget, renderPdfPageScreenshot, splitPdfImageReadPath } from "./read-pdf";
import { isMultiRange, isRawSelector, type ParsedSelector, parseSel, selToOffsetLimit } from "./read-selector";
import { readSqlite, resolveSqliteReadPath } from "./read-sqlite";
import { isProseSummaryPath, renderSummary, routeReadThroughBridge, trySummarize } from "./read-summary";
import { formatBytes, shortenPath } from "./render-utils";
import { REPORT_ISSUE_DEVICE_NAME, reportIssueDeviceUsage } from "./report-tool-issue";
import { isResolutionDeviceName, resolutionDeviceUsage } from "./resolve";
import { ToolAbortError, ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";
import { xdevDocs, xdevListing } from "./xdev";

export { readToolRenderer } from "./read-renderer";

/** Largest profile (`*.sample.txt`, `*.cpuprofile`) converted to a bottleneck summary; bigger files read as plain text. */
const MAX_PROFILE_SUMMARY_BYTES = 32 * 1024 * 1024;
const MAX_ARTIFACT_RAW_INLINE_BYTES = DEFAULT_MAX_BYTES;

async function readBracketContextFullLines(absolutePath: string, fileSize: number): Promise<string[] | undefined> {
	if (fileSize > SNAPSHOT_MAX_BYTES) return undefined;
	try {
		return splitAddressableFileLines(normalizeToLF(await Bun.file(absolutePath).text()));
	} catch {
		return undefined;
	}
}

interface StreamFileLinesOptions {
	includeTerminalNewline?: boolean;
	stopScanAfterCollect?: boolean;
}

async function streamLinesFromFile(
	filePath: string,
	startLine: number,
	maxLinesToCollect: number,
	maxBytes: number,
	selectedLineLimit: number | null,
	signal?: AbortSignal,
	options: StreamFileLinesOptions = {},
): Promise<{
	lines: string[];
	totalFileLines: number;
	collectedBytes: number;
	stoppedByByteLimit: boolean;
	firstLinePreview?: { text: string; bytes: number };
	firstLineByteLength?: number;
	selectedBytesTotal: number;
	/** Whether the fully scanned source ended in a newline. */
	hasTrailingNewline: boolean;
	/** False when `stopScanAfterCollect` cut the scan short — `totalFileLines` is then a lower bound. */
	reachedEof: boolean;
}> {
	const { includeTerminalNewline = false, stopScanAfterCollect = false } = options;
	const bufferChunk = Buffer.allocUnsafe(READ_CHUNK_SIZE);
	const collectedLines: string[] = [];
	let lineIndex = 0;
	let collectedBytes = 0;
	let stoppedByByteLimit = false;
	let doneCollecting = false;
	let reachedEof = true;
	let fileHandle: fs.FileHandle | null = null;
	let currentLineLength = 0;
	let currentLineChunks: Buffer[] = [];
	let sawAnyByte = false;
	let endedWithNewline = false;
	let firstLinePreviewBytes = 0;
	const firstLinePreviewChunks: Buffer[] = [];
	let firstLineByteLength: number | undefined;
	let selectedBytesTotal = 0;
	let selectedLinesSeen = 0;
	let captureLine = false;
	let discardLineChunks = false;
	let lineCaptureLimit = 0;

	const setupLineState = () => {
		captureLine = !doneCollecting && lineIndex >= startLine;
		discardLineChunks = !captureLine;
		if (captureLine) {
			const separatorBytes = collectedLines.length > 0 ? 1 : 0;
			lineCaptureLimit = maxBytes - collectedBytes - separatorBytes;
			if (lineCaptureLimit <= 0) {
				discardLineChunks = true;
			}
		} else {
			lineCaptureLimit = 0;
		}
	};

	const decodeLine = (): string => {
		if (currentLineLength === 0) return "";
		if (currentLineChunks.length === 1 && currentLineChunks[0]?.length === currentLineLength) {
			return currentLineChunks[0].toString("utf-8");
		}
		return Buffer.concat(currentLineChunks, currentLineLength).toString("utf-8");
	};

	const maybeCapturePreview = (segment: Uint8Array) => {
		if (doneCollecting || lineIndex < startLine || collectedLines.length !== 0) return;
		if (firstLinePreviewBytes >= maxBytes || segment.length === 0) return;
		const remaining = maxBytes - firstLinePreviewBytes;
		const slice = segment.length > remaining ? segment.subarray(0, remaining) : segment;
		if (slice.length === 0) return;
		firstLinePreviewChunks.push(Buffer.from(slice));
		firstLinePreviewBytes += slice.length;
	};

	const appendSegment = (segment: Uint8Array) => {
		currentLineLength += segment.length;
		maybeCapturePreview(segment);
		if (!captureLine || discardLineChunks || segment.length === 0) return;
		if (currentLineLength <= lineCaptureLimit) {
			currentLineChunks.push(Buffer.from(segment));
		} else {
			discardLineChunks = true;
		}
	};

	const finalizeLine = () => {
		if (lineIndex >= startLine && (selectedLineLimit === null || selectedLinesSeen < selectedLineLimit)) {
			selectedBytesTotal += currentLineLength + (selectedLinesSeen > 0 ? 1 : 0);
			selectedLinesSeen++;
		}

		if (!doneCollecting && lineIndex >= startLine) {
			const separatorBytes = collectedLines.length > 0 ? 1 : 0;
			if (collectedLines.length >= maxLinesToCollect) {
				doneCollecting = true;
			} else if (collectedLines.length === 0 && currentLineLength > maxBytes) {
				stoppedByByteLimit = true;
				doneCollecting = true;
				if (firstLineByteLength === undefined) {
					firstLineByteLength = currentLineLength;
				}
			} else if (collectedLines.length > 0 && collectedBytes + separatorBytes + currentLineLength > maxBytes) {
				stoppedByByteLimit = true;
				doneCollecting = true;
			} else {
				const lineText = decodeLine();
				collectedLines.push(lineText);
				collectedBytes += separatorBytes + currentLineLength;
				if (firstLineByteLength === undefined) {
					firstLineByteLength = currentLineLength;
				}
				if (collectedBytes > maxBytes) {
					stoppedByByteLimit = true;
					doneCollecting = true;
				} else if (collectedLines.length >= maxLinesToCollect) {
					doneCollecting = true;
				}
			}
		} else if (lineIndex >= startLine && firstLineByteLength === undefined) {
			firstLineByteLength = currentLineLength;
		}

		lineIndex++;
		currentLineLength = 0;
		currentLineChunks = [];
		setupLineState();
	};

	setupLineState();

	try {
		fileHandle = await fs.open(filePath, "r");

		while (true) {
			throwIfAborted(signal);
			const { bytesRead } = await fileHandle.read(bufferChunk, 0, bufferChunk.length, null);
			if (bytesRead === 0) break;

			sawAnyByte = true;
			const chunk = bufferChunk.subarray(0, bytesRead);
			endedWithNewline = chunk[bytesRead - 1] === 0x0a;

			// Once collection and selected-line accounting are both finished, the
			// remaining scan only computes `totalFileLines` — count newlines with
			// native indexOf instead of the per-byte JS loop (a multi-GB tail
			// otherwise stalls the read for seconds to minutes).
			if (doneCollecting && selectedLineLimit !== null && selectedLinesSeen >= selectedLineLimit) {
				if (stopScanAfterCollect) {
					reachedEof = false;
					break;
				}
				let searchFrom = 0;
				let newlineAt = chunk.indexOf(0x0a);
				while (newlineAt !== -1) {
					lineIndex++;
					searchFrom = newlineAt + 1;
					newlineAt = chunk.indexOf(0x0a, searchFrom);
				}
				if (searchFrom === 0) {
					currentLineLength += chunk.length;
				} else {
					currentLineLength = chunk.length - searchFrom;
				}
				continue;
			}

			let start = 0;
			for (let i = 0; i < chunk.length; i++) {
				if (chunk[i] === 0x0a) {
					const segment = chunk.subarray(start, i);
					if (segment.length > 0) {
						appendSegment(segment);
					}
					finalizeLine();
					start = i + 1;
				}
			}

			if (start < chunk.length) {
				appendSegment(chunk.subarray(start));
			}
		}
	} finally {
		if (fileHandle) {
			await fileHandle.close();
		}
	}

	if (reachedEof && (currentLineLength > 0 || !sawAnyByte || (endedWithNewline && includeTerminalNewline))) {
		finalizeLine();
	}

	let firstLinePreview: { text: string; bytes: number } | undefined;
	if (firstLinePreviewBytes > 0) {
		const { text, bytes } = truncateHeadBytes(Buffer.concat(firstLinePreviewChunks, firstLinePreviewBytes), maxBytes);
		firstLinePreview = { text, bytes };
	}

	return {
		lines: collectedLines,
		totalFileLines: lineIndex,
		collectedBytes,
		stoppedByByteLimit,
		firstLinePreview,
		firstLineByteLength,
		selectedBytesTotal,
		reachedEof,
		hasTrailingNewline: reachedEof && endedWithNewline,
	};
}

// Maximum image file size (20MB) - larger images will be rejected to prevent OOM during serialization
const MAX_IMAGE_SIZE = MAX_IMAGE_INPUT_BYTES;

const readSchema = type({
	path: type("string").describe(
		"Local path, internal URI (e.g. memory://, skill://), or URL. Inline selectors are supported.",
	),
});

const readSchemaWithoutMemory = type({
	path: type("string").describe("Local path, internal URI (e.g. skill://), or URL. Inline selectors are supported."),
});

export type ReadToolInput = typeof readSchema.infer;

export interface ReadToolDetails {
	kind?: "file" | "url";
	truncation?: TruncationResult;
	isDirectory?: boolean;
	resolvedPath?: string;
	suffixResolution?: { from: string; to: string };
	url?: string;
	finalUrl?: string;
	contentType?: string;
	method?: string;
	notes?: string[];
	meta?: OutputMeta;
	/** Full on-disk byte size recorded before applying a file range. */
	fileSize?: number;
	/** Full source line count when the read reached EOF and the count is exact. */
	totalLines?: number;
	/** Raw text + start line for user-visible TUI rendering, set when content is text-like.
	 * Mirrors the same lines the model receives but without hashline/line-number prefixes,
	 * so the TUI can render the file content with its own gutter without re-parsing the formatted text. */
	displayContent?: {
		text: string;
		startLine: number;
		lineNumbers?: Array<number | null>;
	};
	summary?: { lines: number; elidedSpans: number; elidedLines: number };
	/** Number of unresolved git conflicts surfaced by this read (TUI uses for inline `⚠ N` badge). */
	conflictCount?: number;
	/** Paths recovered from a delimited read argument; used only by the TUI to render one call as multiple read rows. */
	displayReadTargets?: string[];
}
type ReadParams = ReadToolInput;

/**
 * Read tool implementation.
 *
 * Reads files with support for images, converted documents (via markit), and text.
 * Directories return a formatted listing with modification times.
 */
export class ReadTool implements AgentTool<typeof readSchema, ReadToolDetails> {
	readonly name = "read";
	readonly approval = (args: unknown): ToolTier => {
		let readPath = "";
		if (args && typeof args === "object" && "path" in args) readPath = String(args.path ?? "");
		if (pathTargetsSsh(readPath)) return "exec";
		const target = splitPathAndSel(readPath);
		return target.sel === undefined && splitPdfImageReadPath(readPath) ? "exec" : "read";
	};
	readonly label = "Read";
	readonly loadMode = "essential";
	description: string;
	get parameters(): typeof readSchema {
		return this.session.settings.get("memory.backend") === "off" ? readSchemaWithoutMemory : readSchema;
	}
	readonly strict = true;

	readonly #autoResizeImages: boolean;
	readonly #defaultLimit: number;
	#inspectImageActive: boolean;

	constructor(private readonly session: ToolSession) {
		this.#autoResizeImages = session.settings.get("images.autoResize");
		this.#defaultLimit = Math.max(
			1,
			Math.min(session.settings.get("read.defaultLimit") ?? DEFAULT_MAX_LINES, DEFAULT_MAX_LINES),
		);
		this.#inspectImageActive = this.#resolveInspectImageAvailability();
		this.description = this.#renderDescription();
	}

	/**
	 * Re-render the tool description for the current display mode and the
	 * effective inspect_image state (mode setting, `/vision` override, and
	 * active-model image capability all feed it, so it can change at runtime).
	 */
	#renderDescription(): string {
		const displayMode = resolveFileDisplayMode(this.session);
		return prompt.render(readDescription, {
			DEFAULT_LIMIT: String(this.#defaultLimit),
			DEFAULT_MAX_LINES: String(DEFAULT_MAX_LINES),
			IS_HL_MODE: displayMode.hashLines,
			IS_LINE_NUMBER_MODE: !displayMode.hashLines && displayMode.lineNumbers,
			INSPECT_IMAGE_ENABLED: this.#inspectImageActive,
		});
	}

	/**
	 * Whether the agent can actually reach `inspect_image` right now: exposed
	 * top-level, or mounted as an `xd://` device while the effective mode wants
	 * it (mounted devices stay executable via `write xd://inspect_image`, so a
	 * metadata-only read remains actionable). Sessions with neither
	 * availability signal (tests, embedded use) fall back to the mode
	 * computation alone. Restricted slates (subagents without the tool and
	 * without xdev) resolve to unavailable, so those sessions get inline image
	 * blocks instead of guidance pointing at an absent tool.
	 */
	#resolveInspectImageAvailability(): boolean {
		const topLevel = this.session.isToolActive?.("inspect_image");
		const xdev = this.session.xdev;
		if (topLevel === undefined && xdev === undefined) return isInspectImageToolActive(this.session);
		if (topLevel === true) return true;
		return xdev?.mountedNames.has("inspect_image") === true && isInspectImageToolActive(this.session);
	}

	/**
	 * Re-evaluate the effective inspect_image state; it can flip when the model
	 * or the `/vision` override changes after this tool was constructed. Keeps
	 * the behavior branch and the advertised description in lockstep. Called
	 * per image read and by tool reconciliation before prompt rebuilds (which
	 * passes the post-change availability as `availableOverride`).
	 */
	syncInspectImageState(availableOverride?: boolean): boolean {
		const active = availableOverride ?? this.#resolveInspectImageAvailability();
		if (active !== this.#inspectImageActive) {
			this.#inspectImageActive = active;
			this.description = this.#renderDescription();
		}
		return active;
	}

	/**
	 * Recover the active approved plan when a model rewrites its `local://` URL
	 * as a same-basename path in the working-directory root.
	 *
	 * Only missing cwd-root paths qualify, so a real working-tree file always
	 * wins and unrelated paths cannot escape into the session artifact sandbox.
	 */
	#approvedPlanAlias(missingAbsolutePath: string): string | undefined {
		const planReferencePath = this.session.getPlanReferencePath?.();
		if (!planReferencePath?.startsWith("local:")) return undefined;

		const requestedPath = path.resolve(missingAbsolutePath);
		if (path.dirname(requestedPath) !== path.resolve(this.session.cwd)) return undefined;

		const localProtocolOptions = this.session.localProtocolOptions ?? {
			getArtifactsDir: () => this.session.getArtifactsDir?.() ?? null,
			getSessionId: () => this.session.getSessionId?.() ?? null,
		};
		try {
			const approvedPlanPath = resolveLocalUrlToPath(planReferencePath, localProtocolOptions);
			return path.basename(requestedPath) === path.basename(approvedPlanPath) ? approvedPlanPath : undefined;
		} catch {
			return undefined;
		}
	}

	async #tryReadDelimitedPaths(
		readPath: string,
		signal?: AbortSignal,
		routedUrlPredicate?: (entry: string) => boolean,
	): Promise<AgentToolResult<ReadToolDetails> | null> {
		const parts = await splitDelimitedPathEntry(readPath, this.session.cwd, { routedUrlPredicate });
		if (!parts) return null;

		const notice = `Note: interpreted as ${parts.length} paths: ${parts.join(", ")}`;
		const notes = [notice];
		const content: Array<TextContent | ImageContent> = [];
		const displayReadTargets: string[] = [];
		let pendingText = notice;
		const flushText = () => {
			if (pendingText.length === 0) return;
			content.push({ type: "text", text: pendingText });
			pendingText = "";
		};
		const appendText = (text: string) => {
			pendingText = pendingText.length > 0 ? `${pendingText}\n\n${text}` : text;
		};

		for (const part of parts) {
			try {
				const result = await this.execute("read-delimited-part", { path: part }, signal);
				displayReadTargets.push(result.details?.suffixResolution?.to ?? part);
				for (const block of result.content) {
					if (block.type === "text") {
						appendText(block.text);
						continue;
					}
					flushText();
					content.push(block);
				}
			} catch (error) {
				if (error instanceof ToolAbortError || signal?.aborted) throw error;
				const message = error instanceof Error ? error.message : String(error);
				const errorNote = `Could not read ${part}: ${message}`;
				notes.push(errorNote);
				displayReadTargets.push(part);
				appendText(`[${errorNote}]`);
			}
		}
		flushText();

		return toolResult<ReadToolDetails>({ notes, displayReadTargets }).content(content).done();
	}

	async #readPdfPageScreenshot(options: {
		readPath: string;
		absolutePdfPath: string;
		page: number;
		pdfFileSize: number;
		suffixResolution?: { from: string; to: string };
		signal?: AbortSignal;
	}): Promise<AgentToolResult<ReadToolDetails>> {
		const { readPath, absolutePdfPath, page, pdfFileSize, suffixResolution, signal } = options;
		const screenshot = await renderPdfPageScreenshot(this.session, absolutePdfPath, page, signal);
		const screenshotFile = Bun.file(screenshot.dest);
		const screenshotMetadata = await readImageMetadata(screenshot.dest);
		const loaded = await this.#loadImageContent({
			readPath,
			absolutePath: screenshot.dest,
			mimeType: screenshot.mimeType,
			imageMetadata: screenshotMetadata,
			fileSize: screenshotFile.size,
		});
		if (suffixResolution) {
			const firstText = loaded.content.find((entry): entry is TextContent => entry.type === "text");
			if (firstText) firstText.text = prependSuffixResolutionNotice(firstText.text, suffixResolution);
		}
		const image = loaded.content.find((entry): entry is ImageContent => entry.type === "image");
		const details: ReadToolDetails = {
			...loaded.details,
			resolvedPath: absolutePdfPath,
			contentType: image?.mimeType ?? screenshot.mimeType,
			fileSize: pdfFileSize,
			suffixResolution,
		};
		return toolResult(details).content(loaded.content).sourcePath(loaded.sourcePath).done();
	}

	/**
	 * Build content blocks for an on-disk image file: an `inspect_image`
	 * metadata note when inspection is active, otherwise the decoded image
	 * block. Shared by the plain-file read path and the `local://` image fast
	 * path so both honor the effective inspect_image state, the size cap, and
	 * auto-resize identically. Too-large / unsupported images surface as {@link ToolError}.
	 */
	async #loadImageContent(options: {
		readPath: string;
		absolutePath: string;
		mimeType: string;
		imageMetadata: ImageMetadata | null;
		fileSize: number;
	}): Promise<{ content: Array<TextContent | ImageContent>; details: ReadToolDetails; sourcePath: string }> {
		const { readPath, absolutePath, mimeType, imageMetadata, fileSize } = options;
		if (this.syncInspectImageState()) {
			const outputMime = imageMetadata?.mimeType ?? mimeType;
			const metadataLines = [
				"Image metadata:",
				`- MIME: ${outputMime}`,
				`- Bytes: ${fileSize} (${formatBytes(fileSize)})`,
				imageMetadata?.width !== undefined && imageMetadata.height !== undefined
					? `- Dimensions: ${imageMetadata.width}x${imageMetadata.height}`
					: "- Dimensions: unknown",
				imageMetadata?.channels !== undefined ? `- Channels: ${imageMetadata.channels}` : "- Channels: unknown",
				imageMetadata?.hasAlpha === true
					? "- Alpha: yes"
					: imageMetadata?.hasAlpha === false
						? "- Alpha: no"
						: "- Alpha: unknown",
				"",
				`If you want to analyze the image, call inspect_image with path="${formatPathRelativeToCwd(
					absolutePath,
					this.session.cwd,
				)}" and a question describing what to inspect and the desired output format.`,
			];
			return { content: [{ type: "text", text: metadataLines.join("\n") }], details: {}, sourcePath: absolutePath };
		}

		if (fileSize > MAX_IMAGE_SIZE) {
			const sizeStr = formatBytes(fileSize);
			const maxStr = formatBytes(MAX_IMAGE_SIZE);
			throw new ToolError(`Image file too large: ${sizeStr} exceeds ${maxStr} limit.`);
		}
		try {
			const imageInput = await loadImageInput({
				path: readPath,
				cwd: this.session.cwd,
				autoResize: this.#autoResizeImages,
				maxBytes: MAX_IMAGE_SIZE,
				resolvedPath: absolutePath,
				detectedMimeType: mimeType,
				excludeWebP: webpExclusionForModel(this.session.getActiveModel?.()),
			});
			if (!imageInput) {
				throw new ToolError(`Read image file [${mimeType}] failed: unsupported image format.`);
			}
			return {
				content: [
					{ type: "text", text: imageInput.textNote },
					{ type: "image", data: imageInput.data, mimeType: imageInput.mimeType },
				],
				details: {},
				sourcePath: imageInput.resolvedPath,
			};
		} catch (error) {
			if (error instanceof ImageInputTooLargeError) {
				throw new ToolError(error.message);
			}
			throw error;
		}
	}

	/**
	 * Stream multiple non-contiguous ranges from a local file. ACP bridge takes
	 * priority when present (editor buffer is source of truth); otherwise each
	 * range is streamed independently with its own line/byte budget. Out-of-bounds
	 * ranges surface as inline notices rather than aborting the read.
	 */
	async #readLocalFileMultiRange(
		absolutePath: string,
		ranges: readonly LineRange[],
		fileSize: number,
		parsed: ParsedSelector,
		displayMode: { hashLines: boolean; lineNumbers: boolean },
		suffixResolution: { from: string; to: string } | undefined,
		signal: AbortSignal | undefined,
		allowBridge = true,
	): Promise<{
		outputText: string;
		columnTruncated: number;
		displayContent?: { text: string; startLine: number; lineNumbers?: Array<number | null> };
		bridgeResult?: AgentToolResult<ReadToolDetails>;
	}> {
		const rawSelector = isRawSelector(parsed);

		// ACP bridge first — the editor's in-memory buffer is source of truth.
		const bridgePromise = allowBridge ? routeReadThroughBridge(this.session, absolutePath) : undefined;
		if (bridgePromise !== undefined) {
			try {
				const bridgeText = await bridgePromise;
				const bridgeResult = buildInMemoryMultiRangeResult(this.session, bridgeText, ranges, {
					details: markMarkdownContentType(
						this.session,
						{ resolvedPath: absolutePath, suffixResolution },
						absolutePath,
					),
					sourcePath: absolutePath,
					entityLabel: "file",
					raw: rawSelector,
				});
				if (suffixResolution) {
					const notice = `[Path '${suffixResolution.from}' not found; resolved to '${suffixResolution.to}' via suffix match]`;
					const firstText = bridgeResult.content.find((c): c is TextContent => c.type === "text");
					if (firstText) firstText.text = `${notice}\n${firstText.text}`;
				}
				return { outputText: "", columnTruncated: 0, bridgeResult };
			} catch (error) {
				logger.warn("ACP fs readTextFile failed; falling back to disk", { path: absolutePath, error });
			}
		}

		const shouldAddHashLines = !rawSelector && displayMode.hashLines;
		const shouldAddLineNumbers = rawSelector ? false : shouldAddHashLines ? false : displayMode.lineNumbers;
		const maxColumns = resolveOutputMaxColumns(this.session.settings);

		const blocks: string[] = [];
		const notices: string[] = [];
		const visibleSpans: Array<{ startLine: number; endLine: number }> = [];
		const displayLineByNumber = new Map<number, string>();
		const fullLines = rawSelector ? undefined : await readBracketContextFullLines(absolutePath, fileSize);
		let columnTruncated = 0;
		let displayContent: { text: string; startLine: number; lineNumbers?: Array<number | null> } | undefined;

		for (const range of ranges) {
			const rangeStart = range.startLine - 1; // 0-indexed
			const requestedLength = range.endLine !== undefined ? range.endLine - range.startLine + 1 : this.#defaultLimit;
			const maxLines = Math.min(requestedLength, DEFAULT_MAX_LINES);

			// When the full file is already in memory (the common case for files
			// within the snapshot byte cap), slice ranges from it instead of
			// re-streaming the file once per range.
			let collectedLines: string[];
			let totalFileLines: number;
			if (fullLines) {
				totalFileLines = fullLines.length;
				collectedLines = fullLines.slice(rangeStart, rangeStart + maxLines);
			} else {
				const maxBytesForRead = Math.max(DEFAULT_MAX_BYTES, maxLines * 512);
				const streamResult = await streamLinesFromFile(
					absolutePath,
					rangeStart,
					maxLines,
					maxBytesForRead,
					maxLines,
					signal,
					{ includeTerminalNewline: rawSelector, stopScanAfterCollect: fileSize > SNAPSHOT_MAX_BYTES },
				);
				totalFileLines = streamResult.totalFileLines;
				collectedLines = streamResult.lines;
			}

			if (rangeStart >= totalFileLines) {
				const bound = range.endLine !== undefined ? `${range.startLine}-${range.endLine}` : `${range.startLine}`;
				notices.push(`[Range ${bound} is beyond end of file (${totalFileLines} lines total); skipped]`);
				continue;
			}

			// Column truncation is display-only; clone before stamping ellipsis so
			// the original on-disk lines stay intact for display reconstruction.
			let displayLines: string[] = collectedLines;
			if (!rawSelector && maxColumns > 0) {
				let cloned: string[] | undefined;
				for (let i = 0; i < collectedLines.length; i++) {
					const { text, wasTruncated } = truncateLine(collectedLines[i], maxColumns);
					if (wasTruncated) {
						if (!cloned) cloned = collectedLines.slice();
						cloned[i] = text;
						columnTruncated = maxColumns;
					}
				}
				if (cloned) displayLines = cloned;
			}
			if (displayLines.length > 0) {
				const endLine = range.startLine + displayLines.length - 1;
				visibleSpans.push({ startLine: range.startLine, endLine });
				for (let i = 0; i < displayLines.length; i++) {
					displayLineByNumber.set(range.startLine + i, displayLines[i] ?? "");
				}
				if (!fullLines || rawSelector) {
					const blockText = displayLines.join("\n");
					blocks.push(formatTextWithMode(blockText, range.startLine, shouldAddHashLines, shouldAddLineNumbers));
				}
			}
		}

		let outputText: string;
		if (!rawSelector && fullLines && visibleSpans.length > 0) {
			const entries = buildLineEntriesWithBlockContext(
				fullLines,
				visibleSpans,
				{ path: absolutePath },
				{
					lineText: (lineNumber, sourceText) => {
						const visibleText = displayLineByNumber.get(lineNumber);
						if (visibleText !== undefined) return visibleText;
						if (maxColumns <= 0) return sourceText;
						const truncated = truncateLine(sourceText, maxColumns);
						if (truncated.wasTruncated) {
							columnTruncated = maxColumns;
						}
						return truncated.text;
					},
				},
			);
			const firstLine = entries.find(entry => entry.kind === "line");
			displayContent = {
				text: lineEntriesToPlainText(entries, BRACKET_CONTEXT_ELLIPSIS),
				startLine: firstLine?.kind === "line" ? firstLine.lineNumber : (visibleSpans[0]?.startLine ?? 1),
				lineNumbers: entries.map(entry => (entry.kind === "line" ? entry.lineNumber : null)),
			};
			outputText = formatLineEntriesWithMode(entries, shouldAddHashLines, shouldAddLineNumbers);
		} else {
			outputText = blocks.join("\n\n…\n\n");
		}
		if (shouldAddHashLines && outputText) {
			const tag = await recordFileSnapshot(this.session, absolutePath);
			if (tag) {
				recordSeenLinesFromBody(this.session, absolutePath, tag, outputText);
				outputText = `${formatReadHashlineHeader(formatPathRelativeToCwd(absolutePath, this.session.cwd), tag)}\n${outputText}`;
			}
		} else if (rawSelector && visibleSpans.length > 0) {
			const rawSeenLines = lineNumbersFromSpans(visibleSpans);
			if (rawSeenLines.length > 0) await recordFileSnapshot(this.session, absolutePath, rawSeenLines);
		}
		if (notices.length > 0) {
			outputText = outputText ? `${outputText}\n${notices.join("\n")}` : notices.join("\n");
		}
		return { outputText, columnTruncated, displayContent };
	}

	async execute(
		_toolCallId: string,
		params: ReadParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ReadToolDetails>,
		_toolContext?: AgentToolContext,
	): Promise<AgentToolResult<ReadToolDetails>> {
		let { path: readPath } = params;
		if (readPath.startsWith("file://")) {
			readPath = expandPath(readPath);
		}

		const conflictUri = parseConflictUri(readPath);
		if (conflictUri) {
			if (conflictUri.id === "*") {
				throw new ToolError(
					"Reading `conflict://*` is not supported — wildcards are write-only. Use the `<path>:conflicts` read selector for the full list of conflicts in a file, or read `conflict://<N>` to inspect a single block.",
				);
			}
			return this.#readConflictRegion(conflictUri.id, conflictUri.scope);
		}
		const displayMode = resolveFileDisplayMode(this.session);

		const parsedUrlTarget = parseReadUrlTarget(readPath);
		if (parsedUrlTarget) {
			if (!this.session.settings.get("fetch.enabled")) {
				throw new ToolError("URL reads are disabled by settings.");
			}
			const urlRaw = parsedUrlTarget.raw;
			const urlRanges = parsedUrlTarget.ranges;
			if (urlRanges !== undefined && urlRanges.length > 1) {
				const entry = await fetchReadUrl(this.session, { path: parsedUrlTarget.path, raw: urlRaw }, signal, {
					ensureArtifact: true,
				});
				return buildInMemoryMultiRangeResult(this.session, entry.output, urlRanges, {
					details: { ...entry.details },
					sourceUrl: entry.details.finalUrl,
					entityLabel: "URL output",
					raw: urlRaw,
					immutable: true,
				});
			}
			const urlOffset = parsedUrlTarget.offset;
			const urlLimit = parsedUrlTarget.limit;
			if (urlOffset !== undefined || urlLimit !== undefined) {
				const entry = await fetchReadUrl(this.session, { path: parsedUrlTarget.path, raw: urlRaw }, signal, {
					ensureArtifact: true,
				});
				return buildInMemoryTextResult(this.session, entry.output, urlOffset, urlLimit, {
					details: { ...entry.details },
					sourceUrl: entry.details.finalUrl,
					entityLabel: "URL output",
					raw: urlRaw,
					immutable: true,
				});
			}
			return executeReadUrl(this.session, { path: parsedUrlTarget.path, raw: urlRaw }, signal);
		}

		// Handle native OMP URLs and custom-scheme resources advertised by MCP servers.
		const internalRouter = InternalUrlRouter.instance();
		const delimitedInternalResult = internalRouter.canResolve(readPath)
			? await this.#tryReadDelimitedPaths(readPath, signal, entry => internalRouter.canResolve(entry))
			: null;
		if (delimitedInternalResult) return delimitedInternalResult;

		// Peel malformed selectors through the internal-URL-aware parser before routing.
		let promotedSelector: string | undefined;
		if (internalRouter.canResolve(readPath)) {
			const internalTarget = splitInternalUrlSel(readPath);
			const parsed = parseSel(internalTarget.sel);
			if (internalTarget.sel !== undefined && parsed.kind === "none") {
				throw new ToolError(
					`Invalid selector ':${internalTarget.sel}' on '${internalTarget.path}'. Use :N, :N-M, :N+K, :N- (open-ended), a comma-separated list of ranges, :raw, or a range combined with raw (e.g. :raw:50-100).`,
				);
			}
			const urlMeta = parseInternalUrl(internalTarget.path);
			const scheme = urlMeta.protocol.replace(/:$/, "").toLowerCase();
			if (scheme === "local") {
				const localFile = await resolveLocalUrlToFile(urlMeta, {
					cwd: this.session.cwd,
					settings: this.session.settings,
					signal,
					localProtocolOptions: this.session.localProtocolOptions,
					skills: this.session.skills,
				});
				if (localFile) {
					readPath = localFile.path;
					// Preserve a local:// selector separately so a sibling literal file
					// cannot shadow the URL's selector semantics during filesystem routing.
					promotedSelector = internalTarget.sel;
				} else {
					return this.#handleInternalUrl(internalTarget.path, parsed, signal);
				}
			} else {
				return this.#handleInternalUrl(internalTarget.path, parsed, signal);
			}
		}

		// One suffix-glob memo per read call — archive, sqlite, and plain-path
		// resolution share misses instead of re-globbing the workspace.
		const suffixCache: SuffixMatchCache = new Map();

		// Prefer a literal filesystem match over selector interpretation so real
		// POSIX filenames containing selector-looking suffixes win over structured
		// archive / sqlite / unsupported PDF-image dispatch. A selector promoted from local://
		// remains separate so it cannot be mistaken for part of the resolved path.
		const literalSplit =
			promotedSelector === undefined
				? await splitPathAndSelPreferringLiteral(readPath, this.session.cwd)
				: { path: readPath, sel: promotedSelector };
		const rawPathIsLiteral =
			promotedSelector !== undefined
				? readPath.includes(":") && (await probeLiteralPathExists(readPath, this.session.cwd)) !== "missing"
				: literalSplit.sel === undefined && splitPathAndSel(readPath).sel !== undefined;

		let pdfImageRead: PdfImageReadTarget | null = null;

		if (!rawPathIsLiteral) {
			const archivePath = await resolveArchiveReadPath(this.session, readPath, suffixCache, signal);
			if (archivePath) {
				const archiveSubPath =
					promotedSelector === undefined
						? splitPathAndSel(archivePath.archiveSubPath)
						: { path: archivePath.archiveSubPath, sel: promotedSelector };
				const archiveParsed = parseSel(archiveSubPath.sel);
				return readArchive(
					this.session,
					readPath,
					archiveParsed,
					{ ...archivePath, archiveSubPath: archiveSubPath.path },
					signal,
				);
			}

			const sqlitePath = await resolveSqliteReadPath(this.session, readPath, suffixCache, signal);
			if (sqlitePath) {
				return readSqlite(sqlitePath, signal);
			}

			const pdfCandidate = literalSplit.sel === undefined ? splitPdfImageReadPath(readPath) : null;
			pdfImageRead =
				pdfCandidate && (await probeLiteralPathExists(readPath, this.session.cwd)) === "missing"
					? pdfCandidate
					: null;
		}

		const localTarget = pdfImageRead ? { path: pdfImageRead.pdfPath, sel: undefined } : literalSplit;
		const localReadPath = localTarget.path;
		const parsed = parseSel(localTarget.sel);

		let absolutePath = resolveReadPath(localReadPath, this.session.cwd);
		let suffixResolution: { from: string; to: string } | undefined;

		let isDirectory = false;
		let fileSize = 0;
		try {
			const stat = await Bun.file(absolutePath).stat();
			fileSize = stat.size;
			isDirectory = stat.isDirectory();
		} catch (error) {
			if (isNotFoundError(error)) {
				// Attempt unique suffix resolution before falling back to the approved-plan
				// alias or fuzzy suggestions. Existing workspace files retain precedence.
				if (!isRemoteMountPath(absolutePath)) {
					const suffixMatch = await findSuffixMatchCached(this.session, suffixCache, localReadPath, signal);
					if (suffixMatch) {
						try {
							const retryStat = await Bun.file(suffixMatch.absolutePath).stat();
							absolutePath = suffixMatch.absolutePath;
							fileSize = retryStat.size;
							isDirectory = retryStat.isDirectory();
							suffixResolution = { from: localReadPath, to: suffixMatch.displayPath };
						} catch {
							// Suffix match candidate no longer stats — continue through
							// approved-plan recovery and the original not-found error.
						}
					}
				}

				let recoveredApprovedPlan = false;
				if (!suffixResolution) {
					const approvedPlanPath = this.#approvedPlanAlias(absolutePath);
					if (approvedPlanPath) {
						try {
							const approvedPlanStat = await Bun.file(approvedPlanPath).stat();
							absolutePath = approvedPlanPath;
							fileSize = approvedPlanStat.size;
							isDirectory = approvedPlanStat.isDirectory();
							recoveredApprovedPlan = true;
						} catch {
							// The referenced plan disappeared after resolution; continue through
							// the ordinary delimited-path fallback and not-found error.
						}
					}
				}

				if (!recoveredApprovedPlan && !suffixResolution) {
					const delimitedResult = await this.#tryReadDelimitedPaths(readPath, signal);
					if (delimitedResult) return delimitedResult;
					throw new ToolError(`Path '${localReadPath}' not found`);
				}
			} else {
				throw error;
			}
		}

		if (isDirectory) {
			if (isMultiRange(parsed)) {
				throw new ToolError("Multi-range line selectors are not supported for directory listings.");
			}
			const { offset, limit } = selToOffsetLimit(parsed);
			// Directory listings are deterministic and fast; never abort them mid-scan
			// (an interrupt would otherwise surface a misleading "Operation aborted").
			const dirResult = await this.#readDirectory(absolutePath, offset, limit, undefined);
			if (suffixResolution) {
				dirResult.details ??= {};
				dirResult.details.suffixResolution = suffixResolution;
			}
			return dirResult;
		}

		if (parsed.kind === "conflicts") {
			return this.#readFileConflicts(absolutePath, suffixResolution, signal);
		}

		if (pdfImageRead) {
			return this.#readPdfPageScreenshot({
				readPath,
				absolutePdfPath: absolutePath,
				page: pdfImageRead.page,
				pdfFileSize: fileSize,
				suffixResolution,
				signal,
			});
		}

		const imageMetadata = await readImageMetadata(absolutePath);
		const mimeType = imageMetadata?.mimeType;
		const ext = path.extname(absolutePath).toLowerCase();
		const resolvedDisplayPath = formatPathRelativeToCwd(absolutePath, this.session.cwd);
		const shouldConvertWithMarkit = CONVERTIBLE_EXTENSIONS.has(ext);

		// Profiler reports (macOS `sample` call trees, V8 `.cpuprofile` JSON):
		// replace the raw dump with a bottleneck summary (hot paths, top self
		// time/samples). `:raw` reads the original bytes; text that merely wears
		// the extension falls through to the plain-text path.
		if (!mimeType && !isRawSelector(parsed) && fileSize <= MAX_PROFILE_SUMMARY_BYTES) {
			let rendered: string | null = null;
			if (isSampleProfilePath(absolutePath)) rendered = renderSampleProfile(await Bun.file(absolutePath).text());
			else if (isCpuProfilePath(absolutePath)) rendered = renderCpuProfile(await Bun.file(absolutePath).text());
			if (rendered) {
				if (isMultiRange(parsed) && parsed.kind === "lines") {
					return buildInMemoryMultiRangeResult(this.session, rendered, parsed.ranges, {
						details: { resolvedPath: absolutePath },
						sourcePath: absolutePath,
						entityLabel: "profile summary",
					});
				}
				const { offset, limit } = selToOffsetLimit(parsed);
				return buildInMemoryTextResult(this.session, rendered, offset, limit, {
					details: { resolvedPath: absolutePath },
					sourcePath: absolutePath,
					entityLabel: "profile summary",
				});
			}
		}
		// Read the file based on type
		let content: Array<TextContent | ImageContent> | undefined;
		let details: ReadToolDetails = {};
		let sourcePath: string | undefined;
		let columnTruncated = 0;
		let truncationInfo:
			| { result: TruncationResult; options: { direction: "head"; startLine?: number; totalFileLines?: number } }
			| undefined;

		if (mimeType) {
			({ content, details, sourcePath } = await this.#loadImageContent({
				readPath,
				absolutePath,
				mimeType,
				imageMetadata,
				fileSize,
			}));
		} else if (isNotebookPath(absolutePath) && !isRawSelector(parsed)) {
			const notebookText = await readEditableNotebookText(absolutePath, resolvedDisplayPath);
			if (isMultiRange(parsed) && parsed.kind === "lines") {
				return buildInMemoryMultiRangeResult(this.session, notebookText, parsed.ranges, {
					details: { resolvedPath: absolutePath },
					sourcePath: absolutePath,
					entityLabel: "notebook",
				});
			}
			const { offset, limit } = selToOffsetLimit(parsed);
			return buildInMemoryTextResult(this.session, notebookText, offset, limit, {
				details: { resolvedPath: absolutePath },
				sourcePath: absolutePath,
				entityLabel: "notebook",
			});
		} else if (shouldConvertWithMarkit) {
			// Convert document via markit.
			const result = await convertFileWithMarkit(absolutePath, signal);
			if (result.ok) {
				const renderedContent = result.content;
				// Route the converted markdown through the in-memory text builder
				// so line-range selectors (`file.pdf:50-100`, `:5-16,40-80`) and
				// raw mode apply against the converted output. Without this,
				// `file.pdf:50-100` silently returned the head of the document
				// because only `truncateHead` was being applied.
				if (isMultiRange(parsed) && parsed.kind === "lines") {
					return buildInMemoryMultiRangeResult(this.session, renderedContent, parsed.ranges, {
						details: {
							resolvedPath: absolutePath,
							contentType: this.session.settings.get("read.renderMarkdown") ? "text/markdown" : undefined,
						},
						sourcePath: absolutePath,
						entityLabel: "document",
					});
				}
				const { offset, limit } = selToOffsetLimit(parsed);
				return buildInMemoryTextResult(this.session, renderedContent, offset, limit, {
					details: {
						resolvedPath: absolutePath,
						contentType: this.session.settings.get("read.renderMarkdown") ? "text/markdown" : undefined,
					},
					sourcePath: absolutePath,
					entityLabel: "document",
					raw: isRawSelector(parsed),
				});
			} else if (result.error) {
				content = [{ type: "text", text: `[Cannot read ${ext} file: ${result.error || "conversion failed"}]` }];
			} else {
				content = [{ type: "text", text: `[Cannot read ${ext} file: conversion failed]` }];
			}
		} else {
			// Binary sniff before any UTF-8 text materialization. A binary file
			// (font, object, archive, packed blob) decodes to NUL/control bytes and
			// U+FFFD mojibake that corrupts the terminal and burns context. Images,
			// notebooks, and markit-convertible documents were already routed above;
			// everything reaching here is meant to be plain text. `:raw` stays the
			// explicit escape hatch for reading bytes verbatim. This single guard
			// covers both the multi-range and single-range disk paths below.
			if (!isRawSelector(parsed) && (await isProbablyBinary(absolutePath))) {
				return toolResult<ReadToolDetails>({ resolvedPath: absolutePath, suffixResolution })
					.text(
						prependSuffixResolutionNotice(
							`[Cannot read binary file '${resolvedDisplayPath}' (${formatBytes(fileSize)}); not valid UTF-8 text. Use ':raw' to read bytes verbatim.]`,
							suffixResolution,
						),
					)
					.sourcePath(absolutePath)
					.done();
			}

			if (
				parsed.kind === "none" &&
				this.session.settings.get("read.summarize.enabled") &&
				(this.session.settings.get("read.summarize.prose") || !isProseSummaryPath(absolutePath))
			) {
				const summary = await trySummarize(this.session, absolutePath, fileSize, signal);
				if (summary?.parsed && summary.elided) {
					const renderedSummary = renderSummary(this.session, summary);
					const footer = formatSummaryElisionFooter(
						resolvedDisplayPath,
						renderedSummary.elidedRanges,
						renderedSummary.elidedLines,
					);
					const summaryHashContext = displayMode.hashLines
						? await readHashlineHeaderContext(this.session, absolutePath, this.session.cwd)
						: undefined;
					const bodyText = footer ? `${renderedSummary.text}\n\n${footer}` : renderedSummary.text;
					const modelText = prependHashlineHeader(bodyText, summaryHashContext);
					if (summaryHashContext?.tag) {
						recordSeenLinesFromBody(this.session, absolutePath, summaryHashContext.tag, renderedSummary.text);
					}
					details = {
						displayContent: { text: renderedSummary.displayText, startLine: 1 },
						summary: {
							lines: countTextLines(renderedSummary.text),
							elidedSpans: renderedSummary.elidedRanges.length,
							elidedLines: renderedSummary.elidedLines,
						},
					};

					sourcePath = absolutePath;
					content = [{ type: "text", text: modelText }];
				}
			}

			if (!content) {
				if (isMultiRange(parsed) && parsed.kind === "lines") {
					const multiResult = await this.#readLocalFileMultiRange(
						absolutePath,
						parsed.ranges,
						fileSize,
						parsed,
						displayMode,
						suffixResolution,
						undefined, // plain-file read: deterministic and fast, never abort mid-read
					);
					if (multiResult.bridgeResult) return multiResult.bridgeResult;
					content = [{ type: "text", text: multiResult.outputText }];
					sourcePath = absolutePath;
					details = multiResult.displayContent ? { displayContent: multiResult.displayContent } : {};
					if (multiResult.columnTruncated > 0) {
						columnTruncated = multiResult.columnTruncated;
					}
				} else {
					// Raw text or line-range mode
					const { offset, limit } = selToOffsetLimit(parsed);
					// Try ACP bridge first — editor's in-memory buffer is source of truth.
					// Request full text so local range rendering keeps normal context and line numbers.
					const bridgePromise = routeReadThroughBridge(this.session, absolutePath);
					if (bridgePromise !== undefined) {
						try {
							const bridgeText = await bridgePromise;
							const bridgeResult = buildInMemoryTextResult(this.session, bridgeText, offset, limit, {
								details: markMarkdownContentType(
									this.session,
									{ resolvedPath: absolutePath, suffixResolution },
									absolutePath,
								),
								sourcePath: absolutePath,
								entityLabel: "file",
								raw: isRawSelector(parsed),
							});
							if (suffixResolution) {
								const notice = `[Path '${suffixResolution.from}' not found; resolved to '${suffixResolution.to}' via suffix match]`;
								const firstText = bridgeResult.content.find((c): c is TextContent => c.type === "text");
								if (firstText) firstText.text = `${notice}\n${firstText.text}`;
							}
							return bridgeResult;
						} catch (error) {
							logger.warn("ACP fs readTextFile failed; falling back to disk", { path: absolutePath, error });
						}
					}

					// User-requested 0-indexed range start. Lines BEFORE this become
					// leading context (added below if offset is explicit). Raw mode
					// never adds context: without line numbers the padding is
					// indistinguishable from requested content, so `raw:31-31` must
					// return line 31 and nothing else.
					const rawSelector = isRawSelector(parsed);
					const requestedStart = offset ? Math.max(0, offset - 1) : 0;
					const expandStart = !rawSelector && offset !== undefined && offset > 1;
					const expandEnd = !rawSelector && limit !== undefined;
					const leadingContext = expandStart ? Math.min(requestedStart, RANGE_LEADING_CONTEXT_LINES) : 0;
					const trailingContext = expandEnd ? RANGE_TRAILING_CONTEXT_LINES : 0;
					const startLine = requestedStart - leadingContext;
					const startLineDisplay = startLine + 1;

					const DEFAULT_LIMIT = this.#defaultLimit;
					const effectiveLimit = limit ?? DEFAULT_LIMIT;
					const maxLinesToCollect = Math.min(effectiveLimit + leadingContext + trailingContext, DEFAULT_MAX_LINES);
					const selectedLineLimit = effectiveLimit + leadingContext + trailingContext;
					// Scale byte budget with line limit so the configured line count actually fits.
					// Assume ~512 bytes/line average; never go below the shared default.
					const maxBytesForRead = Math.max(DEFAULT_MAX_BYTES, maxLinesToCollect * 512);

					const streamResult = await streamLinesFromFile(
						absolutePath,
						startLine,
						maxLinesToCollect,
						maxBytesForRead,
						selectedLineLimit,
						undefined, // plain-file read: deterministic and fast, never abort mid-read
						{ includeTerminalNewline: rawSelector, stopScanAfterCollect: fileSize > SNAPSHOT_MAX_BYTES },
					);

					const {
						lines: collectedLines,
						totalFileLines,
						collectedBytes,
						stoppedByByteLimit,
						firstLinePreview,
						firstLineByteLength,
						reachedEof,
						hasTrailingNewline,
					} = streamResult;

					// Check if offset is out of bounds - return graceful message instead of throwing
					if (requestedStart >= totalFileLines) {
						const suggestion =
							totalFileLines === 0
								? "The file is empty."
								: `Use :1 to read from the start, or :${totalFileLines} to read the last line.`;
						return toolResult<ReadToolDetails>({ resolvedPath: absolutePath, suffixResolution })
							.text(
								`Line ${requestedStart + 1} is beyond end of file (${totalFileLines} lines total). ${suggestion}`,
							)
							.done();
					}

					// Per-line column cap. Skipped in raw mode so `:raw` always returns
					// verbatim bytes for paste-back-into-tool workflows. Total byte/line
					// counts in `truncation` keep reflecting the source, not the trimmed
					// view — column truncation surfaces separately via `.limits()`.
					const maxColumns = resolveOutputMaxColumns(this.session.settings);
					// Column truncation is display-only. `collectedLines` MUST stay
					// byte-for-byte with the on-disk content so the snapshot recorded
					// below can be verified against the live file. Mutating it with
					// ellipsis-truncated text made every long-line file uneditable on
					// the next edit attempt.
					let displayLines: string[] = collectedLines;
					if (!rawSelector && maxColumns > 0) {
						let cloned: string[] | undefined;
						for (let i = 0; i < collectedLines.length; i++) {
							const { text, wasTruncated } = truncateLine(collectedLines[i], maxColumns);
							if (wasTruncated) {
								if (!cloned) cloned = collectedLines.slice();
								cloned[i] = text;
								columnTruncated = maxColumns;
							}
						}
						if (cloned) displayLines = cloned;
					}

					const displayLineByNumber = new Map<number, string>();
					for (let i = 0; i < displayLines.length; i++) {
						displayLineByNumber.set(startLineDisplay + i, displayLines[i] ?? "");
					}
					const bracketContextFullLines = rawSelector
						? undefined
						: await readBracketContextFullLines(absolutePath, fileSize);
					const displayedEndLine = startLineDisplay + Math.max(0, displayLines.length - 1);

					const selectedContent = displayLines.join("\n");
					const userLimitedLines = collectedLines.length;

					const totalSelectedLines = totalFileLines - startLine;
					const totalSelectedBytes = collectedBytes;
					const wasTruncated = collectedLines.length < totalSelectedLines || stoppedByByteLimit;
					const firstLineExceedsLimit = firstLineByteLength !== undefined && firstLineByteLength > maxBytesForRead;

					const truncation: TruncationResult = {
						content: selectedContent,
						truncated: wasTruncated,
						truncatedBy: stoppedByByteLimit ? "bytes" : wasTruncated ? "lines" : undefined,
						totalLines: totalSelectedLines,
						totalBytes: totalSelectedBytes,
						outputLines: collectedLines.length,
						outputBytes: collectedBytes,
						lastLinePartial: false,
						firstLineExceedsLimit,
					};

					const shouldAddHashLines = !rawSelector && displayMode.hashLines;
					const shouldAddLineNumbers = rawSelector ? false : shouldAddHashLines ? false : displayMode.lineNumbers;
					let hashContext: HashlineHeaderContext | undefined;
					if (shouldAddHashLines && collectedLines.length > 0 && !firstLineExceedsLimit) {
						// The tag is a content hash of the WHOLE file. A whole-file read
						// already holds every line in memory; a range read re-reads the
						// file (bounded by SNAPSHOT_MAX_BYTES) so the tag fingerprints the
						// full file and any anchor validates while the file is unchanged.
						const isWholeFile = offset === undefined && limit === undefined && !wasTruncated;
						const tag = isWholeFile
							? getFileSnapshotStore(this.session).record(
									canonicalSnapshotKey(absolutePath),
									normalizeToLF(`${collectedLines.join("\n")}${hasTrailingNewline ? "\n" : ""}`),
								)
							: await recordFileSnapshot(this.session, absolutePath);
						if (tag) {
							hashContext = hashlineHeaderContext(formatPathRelativeToCwd(absolutePath, this.session.cwd), tag);
						}
					}

					let capturedDisplayContent:
						| { text: string; startLine: number; lineNumbers?: Array<number | null> }
						| undefined;
					let emittedHashlineHeader = false;
					const formatText = (text: string, startNum: number): string => {
						const lineCount = countTextLines(text);
						capturedDisplayContent = {
							text,
							startLine: startNum,
							lineNumbers: Array.from({ length: lineCount }, (_, i) => startNum + i),
						};
						const formatted = formatTextWithMode(text, startNum, shouldAddHashLines, shouldAddLineNumbers);
						if (!hashContext || emittedHashlineHeader) return formatted;
						emittedHashlineHeader = true;
						return prependHashlineHeader(formatted, hashContext);
					};
					const formatBracketAwareText = (): string | undefined => {
						if (!bracketContextFullLines) return undefined;
						const entries = buildLineEntriesWithBlockContext(
							bracketContextFullLines,
							[{ startLine: startLineDisplay, endLine: displayedEndLine }],
							{ path: absolutePath },
							{
								lineText: (lineNumber, sourceText) => {
									const visibleText = displayLineByNumber.get(lineNumber);
									if (visibleText !== undefined) return visibleText;
									if (maxColumns <= 0) return sourceText;
									const truncated = truncateLine(sourceText, maxColumns);
									if (truncated.wasTruncated) {
										columnTruncated = maxColumns;
									}
									return truncated.text;
								},
							},
						);
						const firstLine = entries.find(entry => entry.kind === "line");
						capturedDisplayContent = {
							text: lineEntriesToPlainText(entries, BRACKET_CONTEXT_ELLIPSIS),
							startLine: firstLine?.kind === "line" ? firstLine.lineNumber : startLineDisplay,
							lineNumbers: entries.map(entry => (entry.kind === "line" ? entry.lineNumber : null)),
						};
						const formatted = formatLineEntriesWithMode(entries, shouldAddHashLines, shouldAddLineNumbers);
						if (!hashContext || emittedHashlineHeader) return formatted;
						emittedHashlineHeader = true;
						return prependHashlineHeader(formatted, hashContext);
					};

					let outputText: string;

					if (truncation.firstLineExceedsLimit) {
						const firstLineBytes = firstLineByteLength ?? 0;
						const snippet = firstLinePreview ?? { text: "", bytes: 0 };

						if (shouldAddHashLines) {
							outputText = `[Line ${startLineDisplay} is ${formatBytes(
								firstLineBytes,
							)}, exceeds ${formatBytes(maxBytesForRead)} limit. Hashline output requires full lines; cannot emit an editable numbered preview for a truncated line.]`;
						} else {
							outputText = formatText(snippet.text, startLineDisplay);
						}
						if (snippet.text.length === 0) {
							outputText = `[Line ${startLineDisplay} is ${formatBytes(
								firstLineBytes,
							)}, exceeds ${formatBytes(maxBytesForRead)} limit. Unable to display a valid UTF-8 snippet.]`;
						}
						details = { truncation };
						sourcePath = absolutePath;
						truncationInfo = {
							result: truncation,
							options: {
								direction: "head",
								startLine: startLineDisplay,
								totalFileLines: reachedEof ? totalFileLines : undefined,
							},
						};
					} else if (truncation.truncated) {
						outputText = formatBracketAwareText() ?? formatText(truncation.content, startLineDisplay);
						details = { truncation };
						sourcePath = absolutePath;
						truncationInfo = {
							result: truncation,
							options: {
								direction: "head",
								startLine: startLineDisplay,
								totalFileLines: reachedEof ? totalFileLines : undefined,
							},
						};
					} else if (startLine + userLimitedLines < totalFileLines || !reachedEof) {
						const nextOffset = startLine + userLimitedLines + 1;

						outputText = formatBracketAwareText() ?? formatText(truncation.content, startLineDisplay);
						outputText += reachedEof
							? `\n\n[${totalFileLines - (startLine + userLimitedLines)} more lines in file. Use :${nextOffset} to continue]`
							: `\n\n[More lines in file (${formatBytes(fileSize)} total; not scanned to EOF). Use :${nextOffset} to continue]`;
						details = {};
						sourcePath = absolutePath;
					} else {
						// No truncation, no user limit exceeded
						outputText = formatBracketAwareText() ?? formatText(truncation.content, startLineDisplay);
						details = {};
						sourcePath = absolutePath;
					}
					if (reachedEof) details.totalLines = totalFileLines;

					if (hashContext?.tag) {
						recordSeenLinesFromBody(this.session, absolutePath, hashContext.tag, outputText);
					}
					if (rawSelector && !firstLineExceedsLimit && collectedLines.length > 0) {
						await recordFileSnapshot(
							this.session,
							absolutePath,
							contiguousLineNumbers(startLineDisplay, collectedLines.length),
						);
					}

					if (capturedDisplayContent) {
						details.displayContent = capturedDisplayContent;
					}

					if (!firstLineExceedsLimit && collectedLines.length > 0) {
						const blocks = scanConflictLines(collectedLines, startLineDisplay);
						if (blocks.length > 0) {
							const history = getConflictHistory(this.session);
							const displayPathForWarning = formatPathRelativeToCwd(absolutePath, this.session.cwd);
							const entries = blocks.map(block =>
								history.register({
									absolutePath,
									displayPath: displayPathForWarning,
									...block,
								}),
							);
							// Cheap full-file scan only when the window already showed
							// at least one conflict — otherwise pay nothing on clean files.
							let totalInFile = entries.length;
							let scanTruncated = false;
							try {
								const fileScan = await scanFileForConflicts(absolutePath);
								totalInFile = Math.max(entries.length, fileScan.blocks.length);
								scanTruncated = fileScan.scanTruncated;
							} catch {
								// Best-effort enrichment; fall back to window-only count.
							}
							outputText += formatConflictWarning(entries, {
								totalInFile,
								displayPath: displayPathForWarning,
								scanTruncated,
							});
							details.conflictCount = entries.length;
						}
					}

					content = [{ type: "text", text: outputText }];
				}
			}
		}

		details.fileSize = fileSize;
		markMarkdownContentType(this.session, details, absolutePath);
		if (suffixResolution) {
			details.suffixResolution = suffixResolution;
			// Inline resolution notice into first text block so the model sees the actual path
			const notice = `[Path '${suffixResolution.from}' not found; resolved to '${suffixResolution.to}' via suffix match]`;
			const firstText = content.find((c): c is TextContent => c.type === "text");
			if (firstText) {
				firstText.text = `${notice}\n${firstText.text}`;
			} else {
				content = [{ type: "text", text: notice }, ...content];
			}
		}
		const resultBuilder = toolResult(details).content(content);
		if (sourcePath) {
			resultBuilder.sourcePath(sourcePath);
		}
		if (truncationInfo) {
			resultBuilder.truncation(truncationInfo.result, truncationInfo.options);
		}
		if (columnTruncated > 0) {
			resultBuilder.limits({ columnMax: columnTruncated });
		}
		return resultBuilder.done();
	}

	/**
	 * Render a `conflict://<N>` (or `conflict://<N>/<scope>`) region as
	 * regular file content. The lines are emitted with their original
	 * file line numbers so hashline anchors line up with the source
	 * file, and no truncation footer is appended.
	 */
	async #readConflictRegion(id: number, scope: ConflictScope | undefined): Promise<AgentToolResult<ReadToolDetails>> {
		const entry: ConflictEntry | undefined = getConflictHistory(this.session).get(id);
		if (!entry) {
			throw new ToolError(
				`Conflict #${id} not found. Conflict ids are registered when \`read\` surfaces a marker block; re-read the file to get a current id.`,
			);
		}

		const region = renderConflictRegion(entry, scope);
		const displayMode = resolveFileDisplayMode(this.session);
		const shouldAddHashLines = displayMode.hashLines;
		const shouldAddLineNumbers = shouldAddHashLines ? false : displayMode.lineNumbers;

		const rawText = region.lines.join("\n");
		const tag = shouldAddHashLines ? await recordFileSnapshot(this.session, entry.absolutePath) : undefined;
		const hashContext = tag
			? hashlineHeaderContext(formatPathRelativeToCwd(entry.absolutePath, this.session.cwd), tag)
			: undefined;
		const formattedBody = formatTextWithMode(rawText, region.startLine, shouldAddHashLines, shouldAddLineNumbers);
		const formattedText = prependHashlineHeader(formattedBody, hashContext);

		const details: ReadToolDetails = {
			resolvedPath: entry.absolutePath,
			displayContent: { text: rawText, startLine: region.startLine },
		};
		return toolResult<ReadToolDetails>(details).text(formattedText).sourcePath(entry.absolutePath).done();
	}

	/**
	 * Implement the `<path>:conflicts` read selector: scan the whole file once, register
	 * every block in the session's conflict history, and return a compact
	 * `#N L_a-L_b` index instead of file content. Designed for heavily
	 * conflicted files where dumping every body would be wasteful.
	 */
	async #readFileConflicts(
		absolutePath: string,
		suffixResolution: { from: string; to: string } | undefined,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult<ReadToolDetails>> {
		throwIfAborted(signal);
		const scan = await scanFileForConflicts(absolutePath);
		const displayPath = formatPathRelativeToCwd(absolutePath, this.session.cwd);
		const history = getConflictHistory(this.session);
		const entries = scan.blocks.map(block =>
			history.register({
				absolutePath,
				displayPath,
				...block,
			}),
		);

		const summary =
			entries.length === 0
				? `No unresolved git merge conflicts in ${displayPath}.`
				: formatConflictSummary(entries, { displayPath, scanTruncated: scan.scanTruncated });

		const details: ReadToolDetails = {
			resolvedPath: absolutePath,
			suffixResolution,
			conflictCount: entries.length,
		};
		return toolResult<ReadToolDetails>(details).text(summary).sourcePath(absolutePath).done();
	}

	#formatArtifactWorkflowNotice(artifact: ResolvedArtifactFile, artifactUrl: string): string {
		const displayPath = shortenPath(artifact.path);
		return `Artifact storage: ${displayPath} (${formatBytes(artifact.size)}). Use ${artifactUrl}:N-M to page, ${artifactUrl}:raw:N-M for verbatim chunks, and the artifact file path for search/copy workflows.`;
	}

	#formatRawArtifactBlockedNotice(artifact: ResolvedArtifactFile, artifactUrl: string): string {
		const displayPath = shortenPath(artifact.path);
		return `Unbounded raw read blocked for ${artifactUrl} (${formatBytes(
			artifact.size,
		)}). Reading the whole artifact verbatim can exhaust memory. Use ${artifactUrl}:raw:1-3000 for bounded verbatim chunks, ${artifactUrl}:1-3000 for numbered exploration, and the artifact file path for search/copy workflows: ${displayPath}`;
	}

	async #readArtifactFile(
		url: InternalUrl,
		parsedSel: ParsedSelector,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ReadToolDetails>> {
		const artifact = await resolveArtifactFile(url, {
			cwd: this.session.cwd,
			settings: this.session.settings,
			signal,
			localProtocolOptions: this.session.localProtocolOptions,
			skills: this.session.skills,
		});
		const artifactUrl = `artifact://${artifact.id}`;
		const details: ReadToolDetails = {
			resolvedPath: artifact.path,
			contentType: "text/plain",
		};

		if (parsedSel.kind === "raw" && artifact.size > MAX_ARTIFACT_RAW_INLINE_BYTES) {
			return toolResult<ReadToolDetails>(details)
				.text(this.#formatRawArtifactBlockedNotice(artifact, artifactUrl))
				.sourcePath(artifact.path)
				.sourceInternal(url.href)
				.done();
		}

		const rawSelector = isRawSelector(parsedSel);
		const displayMode = resolveFileDisplayMode(this.session, { raw: rawSelector, immutable: true });
		if (isMultiRange(parsedSel) && parsedSel.kind === "lines") {
			const read = await this.#readLocalFileMultiRange(
				artifact.path,
				parsedSel.ranges,
				artifact.size,
				parsedSel,
				displayMode,
				undefined,
				signal,
				false,
			);
			if (read.bridgeResult) return read.bridgeResult;
			if (read.displayContent) details.displayContent = read.displayContent;
			let text = read.outputText;
			if (!rawSelector && artifact.size > MAX_ARTIFACT_RAW_INLINE_BYTES) {
				text = text
					? `${text}\n\n[${this.#formatArtifactWorkflowNotice(artifact, artifactUrl)}]`
					: this.#formatArtifactWorkflowNotice(artifact, artifactUrl);
			}
			const resultBuilder = toolResult<ReadToolDetails>(details)
				.text(text)
				.sourcePath(artifact.path)
				.sourceInternal(url.href);
			if (read.columnTruncated > 0) resultBuilder.limits({ columnMax: read.columnTruncated });
			return resultBuilder.done();
		}

		const { offset, limit } = selToOffsetLimit(parsedSel);
		const requestedStart = offset ? Math.max(0, offset - 1) : 0;
		// Raw mode never adds context lines — see the plain-file range path.
		const expandStart = !rawSelector && offset !== undefined && offset > 1;
		const expandEnd = !rawSelector && limit !== undefined;
		const leadingContext = expandStart ? Math.min(requestedStart, RANGE_LEADING_CONTEXT_LINES) : 0;
		const trailingContext = expandEnd ? RANGE_TRAILING_CONTEXT_LINES : 0;
		const startLine = requestedStart - leadingContext;
		const startLineDisplay = startLine + 1;
		const effectiveLimit = limit ?? this.#defaultLimit;
		const maxLinesToCollect = Math.min(effectiveLimit + leadingContext + trailingContext, DEFAULT_MAX_LINES);
		const selectedLineLimit = effectiveLimit + leadingContext + trailingContext;
		const maxBytesForRead = Math.max(DEFAULT_MAX_BYTES, maxLinesToCollect * 512);
		const streamResult = await streamLinesFromFile(
			artifact.path,
			startLine,
			maxLinesToCollect,
			maxBytesForRead,
			selectedLineLimit,
			signal,
			{ includeTerminalNewline: rawSelector, stopScanAfterCollect: artifact.size > SNAPSHOT_MAX_BYTES },
		);
		const {
			lines: collectedLines,
			totalFileLines,
			collectedBytes,
			stoppedByByteLimit,
			firstLinePreview,
			firstLineByteLength,
			reachedEof,
		} = streamResult;

		if (requestedStart >= totalFileLines) {
			const suggestion =
				totalFileLines === 0
					? "The artifact is empty."
					: `Use ${artifactUrl}:1 to read from the start, or ${artifactUrl}:${totalFileLines} to read the last line.`;
			return toolResult<ReadToolDetails>(details)
				.text(`Line ${requestedStart + 1} is beyond end of artifact (${totalFileLines} lines total). ${suggestion}`)
				.sourcePath(artifact.path)
				.sourceInternal(url.href)
				.done();
		}

		const shouldAddLineNumbers = rawSelector ? false : displayMode.hashLines ? false : displayMode.lineNumbers;
		const selectedContent = collectedLines.join("\n");
		const totalSelectedLines = totalFileLines - startLine;
		const wasTruncated = collectedLines.length < totalSelectedLines || stoppedByByteLimit;
		const firstLineExceedsLimit = firstLineByteLength !== undefined && firstLineByteLength > maxBytesForRead;
		const truncation: TruncationResult = {
			content: selectedContent,
			truncated: wasTruncated,
			truncatedBy: stoppedByByteLimit ? "bytes" : wasTruncated ? "lines" : undefined,
			totalLines: totalSelectedLines,
			totalBytes: collectedBytes,
			outputLines: collectedLines.length,
			outputBytes: collectedBytes,
			lastLinePartial: false,
			firstLineExceedsLimit,
		};

		let displayContent: { text: string; startLine: number; lineNumbers?: Array<number | null> } | undefined;
		const formatText = (text: string, startNum: number): string => {
			const lineCount = countTextLines(text);
			displayContent = {
				text,
				startLine: startNum,
				lineNumbers: Array.from({ length: lineCount }, (_, i) => startNum + i),
			};
			return formatTextWithMode(text, startNum, false, shouldAddLineNumbers);
		};

		let outputText: string;
		let truncationInfo:
			| { result: TruncationResult; options: { direction: "head"; startLine?: number; totalFileLines?: number } }
			| undefined;
		if (truncation.firstLineExceedsLimit) {
			const firstLineBytes = firstLineByteLength ?? 0;
			const snippet = firstLinePreview ?? { text: "", bytes: 0 };
			outputText =
				snippet.text.length > 0
					? formatText(snippet.text, startLineDisplay)
					: `[Line ${startLineDisplay} is ${formatBytes(
							firstLineBytes,
						)}, exceeds ${formatBytes(maxBytesForRead)} limit. Unable to display a valid UTF-8 snippet.]`;
			truncationInfo = {
				result: truncation,
				options: {
					direction: "head",
					startLine: startLineDisplay,
					totalFileLines: reachedEof ? totalFileLines : undefined,
				},
			};
		} else {
			outputText = formatText(truncation.content, startLineDisplay);
			if (truncation.truncated) {
				truncationInfo = {
					result: truncation,
					options: {
						direction: "head",
						startLine: startLineDisplay,
						totalFileLines: reachedEof ? totalFileLines : undefined,
					},
				};
			} else if (startLine + collectedLines.length < totalFileLines || !reachedEof) {
				const nextOffset = startLine + collectedLines.length + 1;
				outputText += reachedEof
					? `\n\n[${totalFileLines - (startLine + collectedLines.length)} more lines in artifact. Use ${artifactUrl}:${nextOffset} to continue]`
					: `\n\n[More lines in artifact (${formatBytes(artifact.size)} total; not scanned to EOF). Use ${artifactUrl}:${nextOffset} to continue]`;
			}
		}

		if (!rawSelector && artifact.size > MAX_ARTIFACT_RAW_INLINE_BYTES) {
			outputText += `\n\n[${this.#formatArtifactWorkflowNotice(artifact, artifactUrl)}]`;
		}
		if (reachedEof) details.totalLines = totalFileLines;
		if (displayContent) details.displayContent = displayContent;
		if (truncationInfo) details.truncation = truncationInfo.result;
		const resultBuilder = toolResult<ReadToolDetails>(details)
			.text(outputText)
			.sourcePath(artifact.path)
			.sourceInternal(url.href);
		if (truncationInfo) resultBuilder.truncation(truncationInfo.result, truncationInfo.options);
		return resultBuilder.done();
	}

	/**
	 * Handle internal URLs (agent://, artifact://, memory://, skill://, rule://, local://, mcp://).
	 * Supports pagination via offset/limit but rejects them when query extraction is used.
	 */
	async #handleInternalUrl(
		url: string,
		parsedSel: ParsedSelector,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ReadToolDetails>> {
		const internalRouter = InternalUrlRouter.instance();

		// Check if URL has query extraction (agent:// only).
		// Use parseInternalUrl which handles colons in host (namespaced skills).
		let urlMeta: InternalUrl;
		try {
			urlMeta = parseInternalUrl(url);
		} catch (e) {
			throw new ToolError(e instanceof Error ? e.message : String(e));
		}
		const scheme = urlMeta.protocol.replace(/:$/, "").toLowerCase();
		let hasExtraction = false;
		if (scheme === "agent") {
			const hasPathExtraction = urlMeta.pathname && urlMeta.pathname !== "/" && urlMeta.pathname !== "";
			const queryParam = urlMeta.searchParams.get("q");
			const hasQueryExtraction = queryParam !== null && queryParam !== "";
			hasExtraction = hasPathExtraction || hasQueryExtraction;
		}
		if (scheme === "artifact") {
			return this.#readArtifactFile(urlMeta, parsedSel, signal);
		}

		// local:// files are real on-disk paths. Detect image files and emit a
		// decoded image block before the text-only resource contract UTF-8
		// decodes the binary into mojibake. The fast path returns null for
		// non-images, directories, listings, or any resolution failure, so the
		// text path below reproduces the router's not-found / symlink-escape
		// behavior unchanged.
		if (scheme === "local") {
			const imageResult = await this.#tryReadLocalImage(urlMeta, signal);
			if (imageResult) return imageResult;
		}

		// Reject line selectors when query extraction is used
		if (hasExtraction && parsedSel.kind !== "none" && parsedSel.kind !== "raw") {
			throw new ToolError("Cannot combine query extraction with line selectors");
		}

		// Resolve the internal URL
		const resource = await internalRouter.resolve(url, {
			cwd: this.session.cwd,
			settings: this.session.settings,
			signal,
			localProtocolOptions: this.session.localProtocolOptions,
			skills: this.session.skills,
			xd: {
				read: async name => {
					if (name === REPORT_ISSUE_DEVICE_NAME) return reportIssueDeviceUsage();
					if (name && isResolutionDeviceName(name)) return resolutionDeviceUsage(name);
					const xdev = this.session.xdev;
					if (!xdev) throw new ToolError("xd:// is not mounted in this session.");
					return name === null ? xdevListing(xdev) : xdevDocs(xdev, name);
				},
			},
		});
		const details: ReadToolDetails = { resolvedPath: resource.sourcePath, contentType: resource.contentType };

		// If extraction was used, return directly (no pagination)
		if (hasExtraction) {
			return toolResult(details).text(resource.content).sourceInternal(url).done();
		}

		const raw = isRawSelector(parsedSel);
		if (isMultiRange(parsedSel) && parsedSel.kind === "lines") {
			return buildInMemoryMultiRangeResult(this.session, resource.content, parsedSel.ranges, {
				details,
				sourcePath: resource.sourcePath,
				sourceInternal: url,
				entityLabel: "resource",
				immutable: resource.immutable,
				raw,
			});
		}

		const { offset, limit } = selToOffsetLimit(parsedSel);
		return buildInMemoryTextResult(this.session, resource.content, offset, limit, {
			details,
			sourcePath: resource.sourcePath,
			sourceInternal: url,
			entityLabel: "resource",
			ignoreResultLimits: scheme === "skill",
			immutable: resource.immutable,
			raw,
		});
	}

	/**
	 * Fast path for `local://` image files. Resolves the URL to its real
	 * on-disk path with the same realpath + containment checks as
	 * {@link LocalProtocolHandler.resolve} (via {@link resolveLocalUrlToFile}),
	 * and — only when the target is a genuine image — emits a decoded image
	 * block. Returns null for non-images, directories, listings, or any
	 * resolution failure (not-found, symlink escape) so the caller falls back to
	 * normal text resolution, which reproduces the router's errors. Errors from
	 * a confirmed image (too large / unsupported) propagate rather than
	 * degrading into a corrupted text read.
	 */
	async #tryReadLocalImage(url: InternalUrl, signal?: AbortSignal): Promise<AgentToolResult<ReadToolDetails> | null> {
		let file: { path: string; size: number } | null;
		try {
			file = await resolveLocalUrlToFile(url, {
				cwd: this.session.cwd,
				settings: this.session.settings,
				signal,
				localProtocolOptions: this.session.localProtocolOptions,
			});
		} catch {
			// Not found / containment escape / no session — let the text path
			// surface the router's canonical error.
			return null;
		}
		if (!file) return null;

		const imageMetadata = await readImageMetadata(file.path);
		const mimeType = imageMetadata?.mimeType;
		if (!mimeType) return null;

		const { content, details, sourcePath } = await this.#loadImageContent({
			readPath: url.href,
			absolutePath: file.path,
			mimeType,
			imageMetadata,
			fileSize: file.size,
		});
		const resultBuilder = toolResult(details).content(content).sourceInternal(url.href);
		if (sourcePath) resultBuilder.sourcePath(sourcePath);
		return resultBuilder.done();
	}

	/** Read directory contents as a formatted listing */
	async #readDirectory(
		absolutePath: string,
		offset: number | undefined,
		limit: number | undefined,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ReadToolDetails>> {
		const READ_DIRECTORY_MAX_DEPTH = 2;
		const READ_DIRECTORY_CHILD_LIMIT = 12;

		throwIfAborted(signal);
		let tree: DirectoryTree;
		try {
			tree = await buildDirectoryTree(absolutePath, {
				maxDepth: READ_DIRECTORY_MAX_DEPTH,
				perDirLimit: READ_DIRECTORY_CHILD_LIMIT,
				rootLimit: null,
				// `lineCap` truncates the rendered tree itself, so apply it only when the caller
				// did not request an offset — otherwise we'd cap the first N lines before slicing.
				lineCap: offset === undefined && limit !== undefined ? limit : null,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new ToolError(`Cannot read directory: ${message}`);
		}
		throwIfAborted(signal);

		const output = tree.totalLines <= 1 ? "(empty directory)" : tree.rendered;
		const details: ReadToolDetails = {
			isDirectory: true,
			resolvedPath: tree.rootPath,
		};

		// Slice the rendered listing when the caller passed an offset/limit. We do this
		// instead of passing the selector down to `buildDirectoryTree` because the tree
		// builder lays out entries hierarchically (per-dir caps, recent-then-elided
		// summaries); line-based slicing operates on the formatted text and matches what
		// users expect from `:N-M` on long listings.
		const wantsSlice = offset !== undefined || limit !== undefined;
		if (wantsSlice) {
			const allLines = output.split("\n");
			const start = offset ? Math.max(0, offset - 1) : 0;
			if (start >= allLines.length) {
				const suggestion =
					allLines.length === 0
						? "The listing is empty."
						: `Use :1 to read from the start, or :${allLines.length} to read the last line.`;
				return toolResult(details)
					.text(`Line ${start + 1} is beyond end of listing (${allLines.length} lines total). ${suggestion}`)
					.sourcePath(tree.rootPath)
					.done();
			}
			const end = limit !== undefined ? Math.min(start + limit, allLines.length) : allLines.length;
			const sliced = allLines.slice(start, end).join("\n");
			const resultBuilder = toolResult(details).sourcePath(tree.rootPath);
			let text = sliced;
			if (end < allLines.length) {
				const remaining = allLines.length - end;
				text += `\n\n[${remaining} more lines in listing. Use :${end + 1} to continue]`;
			}
			resultBuilder.text(text);
			if (tree.truncated) {
				resultBuilder.limits({ resultLimit: 1 });
			}
			return resultBuilder.done();
		}

		const truncation = truncateHead(output, { maxLines: Number.MAX_SAFE_INTEGER });
		const resultBuilder = toolResult(details).text(truncation.content).sourcePath(tree.rootPath);
		if (tree.truncated) {
			resultBuilder.limits({ resultLimit: 1 });
		}
		if (truncation.truncated) {
			resultBuilder.truncation(truncation, { direction: "head" });
			details.truncation = truncation;
		}

		return resultBuilder.done();
	}
}
