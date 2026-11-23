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

	async renderImages(request: OfficeImagesRequest, signal?: AbortSignal): Promise<OfficeImagesResult> {
		if (request.sheet !== undefined || request.range !== undefined) {
			throw new OfficeKitError(
				"invalid-request",
				"Worksheet-area rendering needs the native Office engine; omit sheet/range to render whole sheets.",
			);
		}
		const dpi = request.dpi ?? DEFAULT_DPI;
		const pdf =
			request.extension === "pdf"
				? new Uint8Array(await Bun.file(request.input).arrayBuffer())
				: await this.#toPdf(request.input, signal);
		const pageCount = pdfPageCount(pdf);
		const pages = request.pages
			? [...request.pages]
			: pdfPageCount(pdf) > 0
				? Array.from({ length: pageCount }, (_, index) => index + 1)
				: [1];
		if (request.maxImages !== undefined && pages.length > request.maxImages) {
			throw new OfficeKitError(
				"output-too-large",
				`The selection has ${pages.length} pages; the limit is ${request.maxImages}.`,
			);
		}
		const dir = await this.#scratch();
		const pdfPath = path.join(dir, "source.pdf");
		await Bun.write(pdfPath, pdf);
		const rasterizer = this.#pdftoppm();
		const images: OfficeRenderedImage[] = [];
		let totalBytes = 0;
		for (const page of pages) {
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
			const pngPath = `${prefix}.png`;
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
		}
		return { pageCount, dpi, images };
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
