/**
 * Office conversion service.
 *
 * `office_render`, `office_convert` and `office_recalculate` never parse a
 * document format on their own: they hand the authorized source to this seam
 * and project the result. A host supplies an engine through
 * {@link setOfficeKit}; the default engine drives a LibreOffice installation,
 * and reports every operation as `unavailable` when that engine is missing —
 * the same failure an unconfigured service produces.
 *
 * Raw document bytes never reach the transcript: rendered pages become image
 * blocks, and converted files land in the kit's output store as a path the
 * model copies with the shell.
 */
import { existsSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

/** Document families the seam distinguishes by input extension. */
export type OfficeExtension = "doc" | "docx" | "odt" | "xls" | "xlsx" | "ods" | "ppt" | "pptx" | "odp" | "pdf";

/** Classified failure codes; tools map these onto their own error envelopes. */
export type OfficeKitErrorCode =
	| "unavailable"
	| "invalid-request"
	| "input-too-large"
	| "output-too-large"
	| "engine-failed"
	| "source-changed"
	| "busy";

export class OfficeKitError extends Error {
	readonly code: OfficeKitErrorCode;
	constructor(code: OfficeKitErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "OfficeKitError";
		this.code = code;
	}
}

/** One rendered page, slide, or worksheet area as a PNG. */
export interface OfficeRenderedImage {
	png: Uint8Array;
	width: number;
	height: number;
	page?: number;
	sheet?: string;
	range?: string;
}

export interface OfficeImagesRequest {
	/** Absolute source path. */
	input: string;
	extension: OfficeExtension;
	/** Distinct one-based pages or slides; omitted renders every page. */
	pages?: readonly number[];
	/** Spreadsheet worksheet to render; omitted renders the engine's default view. */
	sheet?: string;
	/** A1 range within {@link sheet}. */
	range?: string;
	/** Rendering resolution, 24–600. */
	dpi?: number;
	maxImages?: number;
	maxBytes?: number;
}

export interface OfficeImagesResult {
	pageCount: number;
	dpi: number;
	images: OfficeRenderedImage[];
}

export interface OfficeFileRequest {
	/** Absolute source path. */
	input: string;
	extension: OfficeExtension;
	format: string;
	/** Owner whose output directory the file lands in. */
	owner: string;
	/** File name inside the owner directory, e.g. `report.pdf`. */
	name: string;
}

export interface OfficeFileResult {
	/** Absolute path in the kit's output store. */
	path: string;
	bytes: number;
	pageCount?: number;
}

/** The conversion service tools consume. */
export interface OfficeKit {
	/** Absolute directory converted files are written to. */
	readonly outputDirectory: string;
	renderImages(request: OfficeImagesRequest, signal?: AbortSignal): Promise<OfficeImagesResult>;
	convertTo(request: OfficeFileRequest, signal?: AbortSignal): Promise<OfficeFileResult>;
	recalculate(request: OfficeFileRequest, signal?: AbortSignal): Promise<OfficeFileResult>;
}

let activeKit: OfficeKit | null | undefined;

/** Resolve the host's Office kit; the default engine is created on first use. */
export function getOfficeKit(): OfficeKit {
	activeKit ??= new LibreOfficeKit();
	return activeKit;
}

/** Replace the Office kit (host integration, tests). `null` restores the default. */
export function setOfficeKit(kit: OfficeKit | null): void {
	activeKit = kit;
}

/** Classify a kit failure for a tool message. */
export function isOfficeKitError(error: unknown, code?: OfficeKitErrorCode): error is OfficeKitError {
	return error instanceof OfficeKitError && (code === undefined || error.code === code);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

function pngSize(bytes: Uint8Array): { width: number; height: number } {
	if (bytes.length < 24 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
		throw new OfficeKitError("engine-failed", "the renderer returned a non-PNG image");
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Count PDF pages with the page-tree objects; a malformed PDF reports 0. */
function pdfPageCount(bytes: Uint8Array): number {
	const text = Buffer.from(bytes).toString("latin1");
	return (text.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
}

function extensionOf(input: string): OfficeExtension | undefined {
	const dot = input.lastIndexOf(".");
	if (dot <= 0) return undefined;
	const extension = input.slice(dot + 1).toLowerCase();
	switch (extension) {
		case "doc":
		case "docx":
		case "odt":
		case "xls":
		case "xlsx":
		case "ods":
		case "ppt":
		case "pptx":
		case "odp":
		case "pdf":
			return extension;
		default:
			return undefined;
	}
}

export { extensionOf as officeExtensionOf };

function familyOf(extension: OfficeExtension): "text" | "spreadsheet" | "presentation" | "pdf" {
	if (extension === "pdf") return "pdf";
	if (extension === "doc" || extension === "docx" || extension === "odt") return "text";
	if (extension === "xls" || extension === "xlsx" || extension === "ods") return "spreadsheet";
	return "presentation";
}

/** Whether an extension belongs to the spreadsheet family. */
export function isSpreadsheet(extension: OfficeExtension): boolean {
	return familyOf(extension) === "spreadsheet";
}

const XLSX_WORKBOOK = "xl/workbook.xml";

function attributeValue(tag: string, name: string): string | undefined {
	return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
}

/** Set, replace, or remove one attribute on a single XML tag. */
function setAttribute(tag: string, name: string, value: string | undefined): string {
	const pattern = new RegExp(`\\s${name}="[^"]*"`);
	if (value === undefined) return tag.replace(pattern, "");
	if (pattern.test(tag)) return tag.replace(pattern, ` ${name}="${value}"`);
	return tag.replace(/\s*\/?>$/, match => ` ${name}="${value}"${match.trimStart()}`);
}

function escapeXml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Normalize an A1 range to the absolute form a print area uses ($A$1:$H$40). */
export function normalizePrintRange(range: string): string {
	const match = /^([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)$/.exec(range.trim());
	if (!match) throw new OfficeKitError("invalid-request", `invalid range "${range}"; expected A1:H40`);
	return `$${match[1]!.toUpperCase()}$${match[2]}:$${match[3]!.toUpperCase()}$${match[4]}`;
}

export interface WorkbookSheetSelection {
	/** Exact worksheet name. */
	sheet: string;
	/** A1 range inside the sheet; omitted prints the sheet's used area. */
	range?: string;
}

/**
 * Rewrite an `.xlsx` package so the engine prints one worksheet, optionally
 * only one cell range: every other worksheet is hidden and an
 * `_xlnm.Print_Area` defined name scopes the output. This keeps worksheet
 * selection and ranges inside the engine instead of cropping rendered pages.
 * Only OOXML workbooks carry this structure; legacy `.xls` and `.ods` input is
 * refused.
 */
export function selectWorkbookSheet(bytes: Uint8Array, selection: WorkbookSheetSelection): Uint8Array {
	let files: Record<string, Uint8Array>;
	try {
		files = unzipSync(bytes);
	} catch (error) {
		throw new OfficeKitError(
			"invalid-request",
			`cannot read the workbook: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const workbook = files[XLSX_WORKBOOK];
	if (!workbook) {
		throw new OfficeKitError("invalid-request", "not an Excel workbook: xl/workbook.xml is missing");
	}
	const source = strFromU8(workbook);
	const tags = [...source.matchAll(/<sheet\b[^>]*\/?>/g)].map(match => match[0]);
	const names = tags.map(tag => attributeValue(tag, "name") ?? "");
	const index = names.findIndex(name => name.toLowerCase() === selection.sheet.toLowerCase());
	if (index < 0) {
		throw new OfficeKitError(
			"invalid-request",
			`worksheet "${selection.sheet}" not found; available: ${names.join(", ") || "(none)"}`,
		);
	}

	let rewritten = source;
	for (let position = 0; position < tags.length; position += 1) {
		const tag = tags[position]!;
		const next = setAttribute(tag, "state", position === index ? "visible" : "hidden");
		rewritten = rewritten.replace(tag, next);
	}

	if (selection.range !== undefined) {
		const sheetName = names[index]!.replaceAll("'", "''");
		const area = escapeXml(`'${sheetName}'!${normalizePrintRange(selection.range)}`);
		const defined = `<definedName name="_xlnm.Print_Area" localSheetId="${index}">${area}</definedName>`;
		rewritten = rewritten.replace(
			new RegExp(
				`<definedName\\b[^>]*name="_xlnm\\.Print_Area"[^>]*localSheetId="${index}"[^>]*>[\\s\\S]*?</definedName>`,
				"g",
			),
			"",
		);
		if (/<definedNames\b[^>]*\/>/.test(rewritten)) {
			rewritten = rewritten.replace(/<definedNames\b[^>]*\/>/, `<definedNames>${defined}</definedNames>`);
		} else if (rewritten.includes("</definedNames>")) {
			rewritten = rewritten.replace("</definedNames>", `${defined}</definedNames>`);
		} else {
			rewritten = rewritten.replace("</sheets>", `</sheets><definedNames>${defined}</definedNames>`);
		}
	}

	files[XLSX_WORKBOOK] = strToU8(rewritten);
	return zipSync(files);
}

const LIBREOFFICE_CANDIDATES = [
	"soffice",
	"libreoffice",
	"soffice.exe",
	"libreoffice.exe",
	"/Applications/LibreOffice.app/Contents/MacOS/soffice",
	"C:\\Program Files\\LibreOffice\\program\\soffice.exe",
	"C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
];

const PDFTOPPM_CANDIDATES = ["pdftoppm", "pdftoppm.exe"];

function findExecutable(candidates: readonly string[]): string | undefined {
	for (const candidate of candidates) {
		if (path.isAbsolute(candidate)) {
			if (existsSync(candidate)) return candidate;
			continue;
		}
		const found = Bun.which(candidate);
		if (found) return found;
	}
	return undefined;
}

const DEFAULT_DPI = 144;
const ENGINE_TIMEOUT_MS = 120_000;

async function run(
	command: readonly string[],
	options: { signal?: AbortSignal; cwd?: string },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const signal = options.signal ?? AbortSignal.timeout(ENGINE_TIMEOUT_MS);
	const proc = Bun.spawn([...command], {
		cwd: options.cwd,
		stdout: "pipe",
		stderr: "pipe",
		signal,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

let scratchCounter = 0;

/**
 * The default engine: LibreOffice for conversion and recalculation, poppler's
 * `pdftoppm` for page images. Both are discovered at call time; a missing
 * engine is `unavailable`, never a silent text substitute.
 */
export class LibreOfficeKit implements OfficeKit {
	readonly outputDirectory: string;
	constructor(outputDirectory = path.join(os.tmpdir(), "musepi-office")) {
		this.outputDirectory = outputDirectory;
	}

	#soffice(): string {
		const binary = findExecutable(LIBREOFFICE_CANDIDATES);
		if (binary === undefined) {
			throw new OfficeKitError("unavailable", "No Office converter is installed.");
		}
		return binary;
	}

	#pdftoppm(): string {
		const binary = findExecutable(PDFTOPPM_CANDIDATES);
		if (binary === undefined) {
			throw new OfficeKitError("unavailable", "No PDF rasterizer is installed.");
		}
		return binary;
	}

	async #scratch(): Promise<string> {
		scratchCounter += 1;
		const dir = path.join(this.outputDirectory, "scratch", `${process.pid}-${Date.now()}-${scratchCounter}`);
		await fsp.mkdir(dir, { recursive: true });
		return dir;
	}

	async #toPdf(input: string, signal?: AbortSignal): Promise<Uint8Array> {
		const dir = await this.#scratch();
		const result = await run([this.#soffice(), "--headless", "--convert-to", "pdf", "--outdir", dir, input], {
			signal,
		});
		if (result.exitCode !== 0) {
			throw new OfficeKitError("engine-failed", `The Office converter failed: ${tail(result.stderr)}`);
		}
		const stem = path.basename(input).replace(/\.[^.]*$/u, "");
		const pdf = path.join(dir, `${stem}.pdf`);
		const exists = await Bun.file(pdf).exists();
		if (!exists) throw new OfficeKitError("engine-failed", "The Office converter produced no PDF.");
		return new Uint8Array(await Bun.file(pdf).arrayBuffer());
	}

	/** Convert already-rewritten document bytes (e.g. one hidden sheet). */
	async #toPdfBytes(bytes: Uint8Array, extension: "xlsx", signal?: AbortSignal): Promise<Uint8Array> {
		const dir = await this.#scratch();
		const input = path.join(dir, `input.${extension}`);
		await Bun.write(input, bytes);
		const result = await run([this.#soffice(), "--headless", "--convert-to", "pdf", "--outdir", dir, input], {
			signal,
		});
		if (result.exitCode !== 0) {
			throw new OfficeKitError("engine-failed", `The Office converter failed: ${tail(result.stderr)}`);
		}
		const pdf = path.join(dir, "input.pdf");
		if (!(await Bun.file(pdf).exists())) {
			throw new OfficeKitError("engine-failed", "The Office converter produced no PDF.");
		}
		return new Uint8Array(await Bun.file(pdf).arrayBuffer());
	}

	async renderImages(request: OfficeImagesRequest, signal?: AbortSignal): Promise<OfficeImagesResult> {
		const spreadsheet = isSpreadsheet(request.extension);
		if (spreadsheet && request.pages !== undefined) {
			throw new OfficeKitError(
				"invalid-request",
				"pages does not apply to spreadsheets; select sheet and range instead.",
			);
		}
		if (!spreadsheet && (request.sheet !== undefined || request.range !== undefined)) {
			throw new OfficeKitError("invalid-request", "sheet and range apply only to spreadsheets.");
		}
		if (request.range !== undefined && request.sheet === undefined) {
			throw new OfficeKitError("invalid-request", "range requires sheet.");
		}
		if (request.extension === "pdf" && (request.sheet !== undefined || request.range !== undefined)) {
			throw new OfficeKitError("invalid-request", "sheet and range apply only to spreadsheets.");
		}
		if (request.sheet !== undefined && request.extension !== "xlsx") {
			throw new OfficeKitError(
				"invalid-request",
				`worksheet selection needs an .xlsx workbook; convert this ${request.extension} file first.`,
			);
		}
		const dpi = request.dpi ?? DEFAULT_DPI;
		const pdf =
			request.extension === "pdf"
				? new Uint8Array(await Bun.file(request.input).arrayBuffer())
				: request.sheet === undefined
					? await this.#toPdf(request.input, signal)
					: await this.#toPdfBytes(
							// Worksheet selection and ranges are a workbook rewrite: only the
							// chosen sheet stays visible, and its print area is the range.
							selectWorkbookSheet(new Uint8Array(await Bun.file(request.input).arrayBuffer()), {
								sheet: request.sheet,
								...(request.range === undefined ? {} : { range: request.range }),
							}),
							"xlsx",
							signal,
						);
		return this.#rasterize(pdf, request, dpi, signal);
	}

	async #rasterize(
		pdf: Uint8Array,
		request: OfficeImagesRequest,
		dpi: number,
		signal?: AbortSignal,
	): Promise<OfficeImagesResult> {
		if (request.pages !== undefined && request.maxImages !== undefined && request.pages.length > request.maxImages) {
			throw new OfficeKitError(
				"output-too-large",
				`The selection has ${request.pages.length} pages; the limit is ${request.maxImages}.`,
			);
		}
		const dir = await this.#scratch();
		const pdfPath = path.join(dir, "source.pdf");
		await Bun.write(pdfPath, pdf);
		const rasterizer = this.#pdftoppm();
		const images: OfficeRenderedImage[] = [];
		let totalBytes = 0;
		const add = async (pngPath: string, page: number): Promise<void> => {
			if (!(await Bun.file(pngPath).exists())) {
				throw new OfficeKitError("invalid-request", `Page ${page} does not exist.`);
			}
			const png = new Uint8Array(await Bun.file(pngPath).arrayBuffer());
			totalBytes += png.byteLength;
			if (request.maxBytes !== undefined && totalBytes > request.maxBytes) {
				throw new OfficeKitError("output-too-large", `Rendered images exceed the ${request.maxBytes}-byte limit.`);
			}
			const { width, height } = pngSize(png);
			images.push({ png, width, height, page });
		};

		// No selection: one rasterizer pass writes every page, and the directory
		// is the page count. PDF page-tree regexes miss compressed object streams,
		// so the produced files are the authoritative count.
		if (request.pages === undefined) {
			const result = await run([rasterizer, "-png", "-r", String(dpi), pdfPath, path.join(dir, "page")], {
				signal,
			});
			if (result.exitCode !== 0) {
				throw new OfficeKitError("engine-failed", `The PDF rasterizer failed: ${tail(result.stderr)}`);
			}
			const produced = (await fsp.readdir(dir))
				.filter(name => /^page-\d+\.png$/.test(name))
				.sort((left, right) => Number(left.match(/(\d+)/)?.[1]) - Number(right.match(/(\d+)/)?.[1]));
			if (produced.length === 0) {
				throw new OfficeKitError("invalid-request", "The document has no renderable pages.");
			}
			if (request.maxImages !== undefined && produced.length > request.maxImages) {
				throw new OfficeKitError(
					"output-too-large",
					`The document has ${produced.length} pages; the limit is ${request.maxImages}.`,
				);
			}
			for (const name of produced) {
				await add(path.join(dir, name), Number(name.match(/(\d+)/)?.[1]));
			}
			return { pageCount: images.length, dpi, images };
		}

		for (const page of request.pages) {
			const prefix = path.join(dir, `page-${page}`);
			const result = await run(
				[
					rasterizer,
					"-png",
					"-r",
					String(dpi),
					"-f",
					String(page),
					"-l",
					String(page),
					"-singlefile",
					pdfPath,
					prefix,
				],
				{ signal },
			);
			if (result.exitCode !== 0) {
				throw new OfficeKitError("engine-failed", `The PDF rasterizer failed: ${tail(result.stderr)}`);
			}
			await add(`${prefix}.png`, page);
		}
		return { pageCount: Math.max(pdfPageCount(pdf), ...request.pages), dpi, images };
	}

	async convertTo(request: OfficeFileRequest, signal?: AbortSignal): Promise<OfficeFileResult> {
		const dir = await this.#scratch();
		const result = await run(
			[this.#soffice(), "--headless", "--convert-to", request.format, "--outdir", dir, request.input],
			{ signal },
		);
		if (result.exitCode !== 0) {
			throw new OfficeKitError("engine-failed", `The Office converter failed: ${tail(result.stderr)}`);
		}
		const stem = path.basename(request.input).replace(/\.[^.]*$/u, "");
		const produced = path.join(dir, `${stem}.${request.format}`);
		if (!(await Bun.file(produced).exists())) {
			throw new OfficeKitError("engine-failed", `The converter produced no ${request.format} file.`);
		}
		const saved = await this.#save(
			request.owner,
			request.name,
			new Uint8Array(await Bun.file(produced).arrayBuffer()),
		);
		return { path: saved.path, bytes: saved.bytes };
	}

	async recalculate(): Promise<OfficeFileResult> {
		throw new OfficeKitError(
			"unavailable",
			"No Office recalculation engine is configured; converting a workbook does not refresh its formula results.",
		);
	}

	/** Write one output into the owner's store and return its absolute path. */
	async #save(owner: string, name: string, bytes: Uint8Array): Promise<{ path: string; bytes: number }> {
		const folder = path.join(this.outputDirectory, "out", sanitize(owner));
		await fsp.mkdir(folder, { recursive: true });
		const file = path.join(folder, sanitize(name));
		await Bun.write(file, bytes);
		return { path: file, bytes: bytes.byteLength };
	}
}

function tail(text: string): string {
	const line = text.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "no diagnostics";
	return line.slice(0, 400);
}

function sanitize(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "output";
}
