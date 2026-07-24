import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import {
	formatHashlineHeader,
	HASHLINE_EDIT_DESCRIPTION,
	HASHLINE_EDIT_PROMPT_GUIDELINES,
	type HashlineFs,
	parseHashlineHeader,
	parsePatch,
} from "@musepi/core/hashline/index.js";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { renderDiff } from "../../modes/interactive/components/diff.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { HashlineContext } from "../../musepi/hashline.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	applyEditsToNormalizedContent,
	computeEditsDiff,
	detectLineEnding,
	type Edit,
	type EditDiffError,
	type EditDiffResult,
	generateDiffString,
	generateUnifiedPatch,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { renderToolPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

type EditPreview = EditDiffResult | EditDiffError;

type EditRenderState = {
	callComponent?: EditCallRenderComponent;
};

const replaceEditSchema = Type.Object(
	{
		oldText: Type.String({
			description:
				"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
		}),
		newText: Type.String({ description: "Replacement text for this targeted edit." }),
	},
	{},
);

const editSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		edits: Type.Array(replaceEditSchema, {
			description:
				"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
		}),
	},
	{},
);

export type EditToolInput = Static<typeof editSchema>;
type LegacyEditToolInput = EditToolInput & {
	oldText?: unknown;
	newText?: unknown;
};

export interface EditToolDetails {
	/** Display-oriented diff of the changes made */
	diff: string;
	/** Standard unified patch of the changes made */
	patch: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
}

/**
 * Pluggable operations for the edit tool.
 * Override these to delegate file editing to remote systems (for example SSH).
 */
export interface EditOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Check if file is readable and writable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
	/** Custom operations for file editing. Default: local filesystem */
	operations?: EditOperations;
	/** MusePi hashline context: switches the tool to tag-anchored patch editing. */
	hashline?: HashlineContext;
}

function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object") {
		return input as EditToolInput;
	}

	const args = input as Record<string, unknown>;

	// Some models (Opus 4.6, GLM-5.1) send edits as a JSON string instead of an array
	if (typeof args.edits === "string") {
		try {
			const parsed = JSON.parse(args.edits);
			if (Array.isArray(parsed)) args.edits = parsed;
		} catch {}
	}

	const legacy = args as LegacyEditToolInput;
	if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") {
		return args as EditToolInput;
	}

	const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
	edits.push({ oldText: legacy.oldText, newText: legacy.newText });
	const { oldText: _oldText, newText: _newText, ...rest } = legacy;
	return { ...rest, edits } as EditToolInput;
}

function validateEditInput(input: EditToolInput): { path: string; edits: Edit[] } {
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
	}
	return { path: input.path, edits: input.edits };
}

type RenderableEditArgs = {
	path?: string;
	file_path?: string;
	edits?: Edit[];
	oldText?: string;
	newText?: string;
};

type EditToolResultLike = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: EditToolDetails;
};

type EditCallRenderComponent = Box & {
	preview?: EditPreview;
	previewArgsKey?: string;
	previewPending?: boolean;
	settledError?: boolean;
};

function createEditCallRenderComponent(): EditCallRenderComponent {
	return Object.assign(new Box(1, 1, (text: string) => text), {
		preview: undefined as EditPreview | undefined,
		previewArgsKey: undefined as string | undefined,
		previewPending: false,
		settledError: false,
	});
}

function getEditCallRenderComponent(state: EditRenderState, lastComponent: unknown): EditCallRenderComponent {
	if (lastComponent instanceof Box) {
		const component = lastComponent as EditCallRenderComponent;
		state.callComponent = component;
		return component;
	}
	if (state.callComponent) {
		return state.callComponent;
	}
	const component = createEditCallRenderComponent();
	state.callComponent = component;
	return component;
}

function getRenderablePreviewInput(args: RenderableEditArgs | undefined): { path: string; edits: Edit[] } | null {
	if (!args) {
		return null;
	}

	const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : null;
	if (!path) {
		return null;
	}

	if (
		Array.isArray(args.edits) &&
		args.edits.length > 0 &&
		args.edits.every((edit) => typeof edit?.oldText === "string" && typeof edit?.newText === "string")
	) {
		return { path, edits: args.edits };
	}

	if (typeof args.oldText === "string" && typeof args.newText === "string") {
		return { path, edits: [{ oldText: args.oldText, newText: args.newText }] };
	}

	return null;
}

function formatEditCall(args: RenderableEditArgs | undefined, theme: Theme, cwd: string): string {
	const pathDisplay = renderToolPath(str(args?.file_path ?? args?.path), theme, cwd);
	return `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;
}

function formatEditResult(
	args: RenderableEditArgs | undefined,
	preview: EditPreview | undefined,
	result: EditToolResultLike,
	theme: Theme,
	isError: boolean,
): string | undefined {
	const rawPath = str(args?.file_path ?? args?.path);
	const previewDiff = preview && !("error" in preview) ? preview.diff : undefined;
	const previewError = preview && "error" in preview ? preview.error : undefined;
	if (isError) {
		const errorText = result.content
			.filter((c) => c.type === "text")
			.map((c) => c.text || "")
			.join("\n");
		if (!errorText || errorText === previewError) {
			return undefined;
		}
		return theme.fg("error", errorText);
	}

	const resultDiff = result.details?.diff;
	if (resultDiff && resultDiff !== previewDiff) {
		return renderDiff(resultDiff, { filePath: rawPath ?? undefined });
	}

	return undefined;
}

function getEditHeaderBg(
	preview: EditPreview | undefined,
	settledError: boolean | undefined,
	theme: Theme,
): (text: string) => string {
	if (preview) {
		if ("error" in preview) {
			return (text: string) => theme.bg("toolErrorBg", text);
		}
		return (text: string) => theme.bg("toolSuccessBg", text);
	}
	if (settledError) {
		return (text: string) => theme.bg("toolErrorBg", text);
	}
	return (text: string) => theme.bg("toolPendingBg", text);
}

function buildEditCallComponent(
	component: EditCallRenderComponent,
	args: RenderableEditArgs | undefined,
	theme: Theme,
	cwd: string,
): EditCallRenderComponent {
	component.setBgFn(getEditHeaderBg(component.preview, component.settledError, theme));
	component.clear();
	component.addChild(new Text(formatEditCall(args, theme, cwd), 0, 0));

	if (!component.preview) {
		return component;
	}

	const body =
		"error" in component.preview ? theme.fg("error", component.preview.error) : renderDiff(component.preview.diff);
	component.addChild(new Spacer(1));
	component.addChild(new Text(body, 0, 0));
	return component;
}

function setEditPreview(
	component: EditCallRenderComponent,
	preview: EditPreview,
	argsKey: string | undefined,
): boolean {
	const current = component.preview;
	const changed =
		current === undefined ||
		("error" in current && "error" in preview
			? current.error !== preview.error
			: "error" in current !== "error" in preview) ||
		(!("error" in current) &&
			!("error" in preview) &&
			(current.diff !== preview.diff || current.firstChangedLine !== preview.firstChangedLine));
	component.preview = preview;
	component.previewArgsKey = argsKey;
	component.previewPending = false;
	return changed;
}

export function createEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): ToolDefinition<typeof editSchema, EditToolDetails | undefined, EditRenderState> {
	// MusePi hashline: same tool name, tag-anchored patch contract instead of
	// exact-replacement edits. The schema swap is config-determined, so the
	// cast below never pairs a native schema with hashline runtime behavior.
	if (options?.hashline) {
		return createHashlineEditToolDefinition(cwd, {
			...options,
			hashline: options.hashline,
		}) as unknown as ToolDefinition<typeof editSchema, EditToolDetails | undefined, EditRenderState>;
	}
	const ops = options?.operations ?? defaultEditOperations;
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
		promptSnippet:
			"Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
		promptGuidelines: [
			"Use edit for precise changes (edits[].oldText must match exactly)",
			"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
			"Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
			"Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
		],
		parameters: editSchema,
		renderShell: "self",
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, input: EditToolInput, signal?: AbortSignal, _onUpdate?, _ctx?) {
			const { path, edits } = validateEditInput(input);
			const absolutePath = resolveToCwd(path, cwd);

			return withFileMutationQueue(absolutePath, async () => {
				// Do not reject from an abort event listener here: that would release the
				// mutation queue while an in-flight filesystem operation may still finish.
				// Checking signal.aborted after each await observes the same aborts while
				// keeping the queue locked until the current operation has settled.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();

				// Check if file exists.
				try {
					await ops.access(absolutePath);
				} catch (error: unknown) {
					throwIfAborted();
					const errorMessage =
						error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
					throw new Error(`Could not edit file: ${path}. ${errorMessage}.`);
				}
				throwIfAborted();

				// Read the file.
				const buffer = await ops.readFile(absolutePath);
				const rawContent = buffer.toString("utf-8");
				throwIfAborted();

				// Strip BOM before matching. The model will not include an invisible BOM in oldText.
				const { bom, text: content } = stripBom(rawContent);
				const originalEnding = detectLineEnding(content);
				const normalizedContent = normalizeToLF(content);
				const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);
				throwIfAborted();

				const finalContent = bom + restoreLineEndings(newContent, originalEnding);
				await ops.writeFile(absolutePath, finalContent);
				throwIfAborted();

				const diffResult = generateDiffString(baseContent, newContent);
				const patch = generateUnifiedPatch(path, baseContent, newContent);
				return {
					content: [
						{
							type: "text",
							text: `Successfully replaced ${edits.length} block(s) in ${path}.`,
						},
					],
					details: { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine },
				};
			});
		},
		renderCall(args, theme, context) {
			const component = getEditCallRenderComponent(context.state, context.lastComponent);
			const previewInput = getRenderablePreviewInput(args as RenderableEditArgs | undefined);
			const argsKey = previewInput
				? JSON.stringify({ path: previewInput.path, edits: previewInput.edits })
				: undefined;

			if (component.previewArgsKey !== argsKey) {
				component.preview = undefined;
				component.previewArgsKey = argsKey;
				component.previewPending = false;
				component.settledError = false;
			}

			if (context.argsComplete && previewInput && !component.preview && !component.previewPending) {
				component.previewPending = true;
				const requestKey = argsKey;
				void computeEditsDiff(previewInput.path, previewInput.edits, context.cwd).then((preview) => {
					if (component.previewArgsKey === requestKey) {
						setEditPreview(component, preview, requestKey);
						context.invalidate();
					}
				});
			}

			return buildEditCallComponent(component, args, theme, context.cwd);
		},
		renderResult(result, _options, theme, context) {
			const callComponent = context.state.callComponent;
			const previewInput = getRenderablePreviewInput(context.args as RenderableEditArgs | undefined);
			const argsKey = previewInput
				? JSON.stringify({ path: previewInput.path, edits: previewInput.edits })
				: undefined;
			const typedResult = result as EditToolResultLike;
			const resultDiff = !context.isError ? typedResult.details?.diff : undefined;
			let changed = false;
			if (callComponent) {
				if (typeof resultDiff === "string") {
					changed =
						setEditPreview(
							callComponent,
							{ diff: resultDiff, firstChangedLine: typedResult.details?.firstChangedLine },
							argsKey,
						) || changed;
				}
				if (callComponent.settledError !== context.isError) {
					callComponent.settledError = context.isError;
					changed = true;
				}
				if (changed) {
					buildEditCallComponent(
						callComponent,
						context.args as RenderableEditArgs | undefined,
						theme,
						context.cwd,
					);
				}
			}

			const output = formatEditResult(context.args, callComponent?.preview, typedResult, theme, context.isError);
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			component.clear();
			if (!output) {
				return component;
			}
			component.addChild(new Spacer(1));
			component.addChild(new Text(output, 1, 0));
			return component;
		},
	};
}

export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema> {
	return wrapToolDefinition(createEditToolDefinition(cwd, options));
}

// ============================================================
// MusePi hashline edit definition
//
// Same tool name ("edit"), tag-anchored patch contract. The engine
// (parse/apply/recovery/atomic write) lives in @musepi/core/hashline;
// everything below is host glue: schema, result formatting, the
// streaming diff preview, and per-file mutation-queue locking.
// ============================================================

const hashlineEditSchema = Type.Object(
	{
		patch: Type.String({
			description:
				"Hashline patch: one or more [path#TAG] sections with SWAP/DEL/INS hunks addressing original file lines. See the tool description for the exact format.",
		}),
	},
	{},
);

export type HashlineEditToolInput = Static<typeof hashlineEditSchema>;

type HashlineRenderableArgs = { patch?: string };

/** Acquire per-file mutation queues in sorted order (deadlock-free), then run fn. */
async function withMutationQueues<T>(paths: readonly string[], fn: () => Promise<T>): Promise<T> {
	const sorted = [...new Set(paths)].sort();
	const run = (index: number): Promise<T> =>
		index >= sorted.length ? fn() : withFileMutationQueue(sorted[index]!, () => run(index + 1));
	return run(0);
}

function getHashlinePreviewInput(args: HashlineRenderableArgs | undefined): { patch: string } | null {
	if (!args || typeof args.patch !== "string" || args.patch.trim().length === 0) return null;
	return { patch: args.patch };
}

/** Extract section paths from a (possibly partially streamed) patch for display. */
function hashlineSectionPaths(patchText: string): string[] {
	const paths: string[] = [];
	for (const line of patchText.split("\n")) {
		const header = parseHashlineHeader(line);
		if (header) paths.push(header.path);
	}
	return paths;
}

function formatHashlineEditCall(args: HashlineRenderableArgs | undefined, theme: Theme, cwd: string): string {
	const paths = args?.patch ? hashlineSectionPaths(args.patch) : [];
	if (paths.length === 0) {
		return `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("dim", "(hashline patch)")}`;
	}
	const rendered = paths.map((p) => renderToolPath(p, theme, cwd)).join(", ");
	return `${theme.fg("toolTitle", theme.bold("edit"))} ${rendered}`;
}

/** In-memory preview: preflight the patch and produce a display diff, or an error card. */
async function computeHashlinePreview(
	patchText: string,
	ctx: HashlineContext,
	cwd: string,
	ops: EditOperations,
): Promise<EditPreview> {
	try {
		const engine = ctx.createEngine(hashlineFsSeam(ops), (p) => resolveToCwd(p, cwd));
		const result = await engine.applyPatch(patchText, { dryRun: true });
		return { diff: combinedDiff(result.sections), firstChangedLine: result.sections[0]?.firstChangedLine };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function combinedDiff(sections: ReadonlyArray<{ absolutePath: string; oldText: string; newText: string }>): string {
	const parts: string[] = [];
	for (const section of sections) {
		if (sections.length > 1) parts.push(`--- ${section.absolutePath}`);
		parts.push(generateDiffString(section.oldText, section.newText).diff);
	}
	return parts.join("\n");
}

function hashlineFsSeam(ops: EditOperations): HashlineFs {
	return {
		readFile: async (absolutePath) => (await ops.readFile(absolutePath)).toString("utf-8"),
		writeFile: (absolutePath, content) => ops.writeFile(absolutePath, content),
	};
}

function createHashlineEditToolDefinition(
	cwd: string,
	options: EditToolOptions & { hashline: HashlineContext },
): ToolDefinition<typeof hashlineEditSchema, EditToolDetails | undefined, EditRenderState> {
	const hashline = options.hashline;
	const ops = options.operations ?? defaultEditOperations;
	return {
		name: "edit",
		label: "edit",
		description: HASHLINE_EDIT_DESCRIPTION,
		promptSnippet: "Edit files with tag-anchored hashline patches (SWAP/DEL/INS hunks on [path#TAG] sections)",
		promptGuidelines: [...HASHLINE_EDIT_PROMPT_GUIDELINES],
		parameters: hashlineEditSchema,
		renderShell: "self",
		async execute(_toolCallId, input: HashlineEditToolInput, signal?: AbortSignal, _onUpdate?, _ctx?) {
			if (typeof input.patch !== "string" || input.patch.trim().length === 0) {
				throw new Error("Edit tool input is invalid. patch must be a non-empty hashline patch string.");
			}
			// Parse once up front to enumerate target paths for the mutation queues;
			// parse errors are actionable and surface to the model as-is.
			const parsed = parsePatch(input.patch);
			const paths = parsed.sections.map((section) => resolveToCwd(section.path, cwd));

			return withMutationQueues(paths, async () => {
				if (signal?.aborted) throw new Error("Operation aborted");
				const engine = hashline.createEngine(hashlineFsSeam(ops), (p) => resolveToCwd(p, cwd));
				const result = await engine.applyPatch(input.patch);
				if (signal?.aborted) throw new Error("Operation aborted");

				const applied = result.sections.map((section) => {
					const displayPath = renderPlainPath(section.absolutePath, cwd);
					const header = formatHashlineHeader(displayPath, section.newTag);
					const notes: string[] = [];
					if (section.recovered) notes.push("recovered from a stale tag");
					if (section.firstChangedLine !== undefined)
						notes.push(`first change at line ${section.firstChangedLine}`);
					return `${header} — applied${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`;
				});
				const lines = [
					...applied,
					...(result.warnings.length > 0 ? ["", "Warnings:", ...result.warnings] : []),
					"",
					"These are fresh tags minted from the new file contents. Anchor any follow-up edit on them (or re-read) — pre-edit tags and line numbers are dead.",
				];

				const patch = result.sections
					.map((section) => generateUnifiedPatch(section.absolutePath, section.oldText, section.newText))
					.join("\n");
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: {
						diff: combinedDiff(result.sections),
						patch,
						firstChangedLine: result.sections[0]?.firstChangedLine,
					},
				};
			});
		},
		renderCall(args, theme, context) {
			const component = getEditCallRenderComponent(context.state, context.lastComponent);
			const typedArgs = args as HashlineRenderableArgs | undefined;
			const previewInput = getHashlinePreviewInput(typedArgs);
			const argsKey = previewInput?.patch;

			if (component.previewArgsKey !== argsKey) {
				component.preview = undefined;
				component.previewArgsKey = argsKey;
				component.previewPending = false;
				component.settledError = false;
			}

			if (context.argsComplete && previewInput && !component.preview && !component.previewPending) {
				component.previewPending = true;
				const requestKey = argsKey;
				void computeHashlinePreview(previewInput.patch, hashline, context.cwd, ops).then((preview) => {
					if (component.previewArgsKey === requestKey) {
						setEditPreview(component, preview, requestKey);
						context.invalidate();
					}
				});
			}

			component.setBgFn(getEditHeaderBg(component.preview, component.settledError, theme));
			component.clear();
			component.addChild(new Text(formatHashlineEditCall(typedArgs, theme, context.cwd), 0, 0));
			if (component.preview) {
				const body =
					"error" in component.preview
						? theme.fg("error", component.preview.error)
						: renderDiff(component.preview.diff);
				component.addChild(new Spacer(1));
				component.addChild(new Text(body, 0, 0));
			}
			return component;
		},
		renderResult(result, _options, theme, context) {
			const callComponent = context.state.callComponent;
			const typedResult = result as EditToolResultLike;
			let changed = false;
			if (callComponent) {
				const resultDiff = !context.isError ? typedResult.details?.diff : undefined;
				if (typeof resultDiff === "string") {
					changed =
						setEditPreview(
							callComponent,
							{ diff: resultDiff, firstChangedLine: typedResult.details?.firstChangedLine },
							callComponent.previewArgsKey,
						) || changed;
				}
				if (callComponent.settledError !== context.isError) {
					callComponent.settledError = context.isError;
					changed = true;
				}
				if (changed) {
					callComponent.setBgFn(getEditHeaderBg(callComponent.preview, callComponent.settledError, theme));
					callComponent.clear();
					callComponent.addChild(
						new Text(
							formatHashlineEditCall(context.args as HashlineRenderableArgs | undefined, theme, context.cwd),
							0,
							0,
						),
					);
					if (callComponent.preview) {
						const body =
							"error" in callComponent.preview
								? theme.fg("error", callComponent.preview.error)
								: renderDiff(callComponent.preview.diff);
						callComponent.addChild(new Spacer(1));
						callComponent.addChild(new Text(body, 0, 0));
					}
				}
			}

			let output: string | undefined;
			if (context.isError) {
				const errorText = typedResult.content
					.filter((c) => c.type === "text")
					.map((c) => c.text || "")
					.join("\n");
				output = errorText ? theme.fg("error", errorText) : undefined;
			} else {
				const resultDiff = typedResult.details?.diff;
				const previewDiff =
					callComponent?.preview && !("error" in callComponent.preview) ? callComponent.preview.diff : undefined;
				if (resultDiff && resultDiff !== previewDiff) output = renderDiff(resultDiff);
			}

			const component = (context.lastComponent as Container | undefined) ?? new Container();
			component.clear();
			if (!output) return component;
			component.addChild(new Spacer(1));
			component.addChild(new Text(output, 1, 0));
			return component;
		},
	};
}

/** Path relative to cwd when possible (matches how anchors are displayed by read/grep). */
function renderPlainPath(absolutePath: string, cwd: string): string {
	if (absolutePath.startsWith(cwd)) {
		const rel = absolutePath.slice(cwd.length).replace(/^[/\\]+/, "");
		if (rel && !rel.startsWith("..")) return rel.replace(/\\/g, "/");
	}
	return absolutePath;
}
