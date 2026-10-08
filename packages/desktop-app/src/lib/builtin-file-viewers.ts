/**
 * The host's own file viewers.
 *
 * These are the branches lifted out of `FilePane`'s read ladder. The behaviour is
 * deliberately identical — same formats, same fall-through-to-the-system-app on a
 * failed decode, same inline editor buffer — because moving them into a registry
 * is only worth doing if it changes where a viewer lives, not what it shows.
 *
 * What genuinely changed is that they are now addressable: a plugin can look at
 * this list, claim a priority, and take a format, instead of editing a component.
 *
 * @module desktop-app/lib/builtin-file-viewers
 */
import { type FileViewer, VIEWER_PRIORITY, type ViewerInput, type ViewerResult } from "./file-viewers";

/**
 * Files whose bytes are decoded as text when the mime does not say so.
 *
 * The list is the original branch chain's, kept deliberately narrow. It is not
 * a typo that `cpp`, `java`, `php` and `sql` are absent even though they are in
 * {@link EXT_LANG}: a file whose extension is in EXT_LANG but not here does not
 * preview as text at all — the mime alone decides. Widening this set would
 * change the boundary between "shows a preview" and "opens in the system app",
 * which is exactly the kind of drift a refactor that promises identical
 * behaviour must not introduce.
 */
const TEXT_EXT = new Set([
	"txt",
	"md",
	"ts",
	"tsx",
	"js",
	"jsx",
	"json",
	"toml",
	"yaml",
	"yml",
	"css",
	"html",
	"xml",
	"log",
	"c",
	"h",
	"rs",
	"py",
	"go",
	"sh",
	"zsh",
	"bash",
	"csv",
	"env",
	"gitignore",
	"ini",
	"conf",
]);

/** Extension → tree-sitter language, mirroring the transcript diff set so a
 *  file previews and a diff highlight the same languages. */
const EXT_LANG: Record<string, string> = {
	ts: "typescript",
	mts: "typescript",
	cts: "typescript",
	tsx: "tsx",
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	jsx: "javascript",
	json: "json",
	md: "markdown",
	markdown: "markdown",
	toml: "toml",
	yaml: "yaml",
	yml: "yaml",
	css: "css",
	scss: "scss",
	html: "html",
	htm: "html",
	xml: "xml",
	c: "c",
	h: "c",
	cpp: "cpp",
	cc: "cpp",
	cxx: "cpp",
	hpp: "cpp",
	hh: "cpp",
	rs: "rust",
	py: "python",
	pyi: "python",
	rb: "ruby",
	go: "go",
	sh: "bash",
	zsh: "bash",
	bash: "bash",
	java: "java",
	kt: "kotlin",
	kts: "kotlin",
	swift: "swift",
	php: "php",
	sql: "sql",
};

/**
 * Whether the bytes are text.
 *
 * The extension alone is not enough — a `.ts` file full of NUL bytes is a binary
 * that happens to be named like source — so the head of the file decides.
 */
export function looksLikeText(input: Pick<ViewerInput, "ext" | "mime" | "bytes">): boolean {
	if (input.mime?.startsWith("text/")) return true;
	return TEXT_EXT.has(input.ext) && !input.bytes.subarray(0, 4096).includes(0);
}

/** The editors' byte ceiling, mirrored here so a viewer cannot hand the pane a
 *  buffer the editor would refuse. */
const MAX_EDIT_BYTES = 2 * 1024 * 1024;

/** Services the built-in viewers need, supplied by the host that owns the pane.
 *  Typed against the real highlighter contract (`CodeHighlightFn` from
 *  client-core returns ANSI or null), so the wiring is not an `unknown` handoff. */
export interface BuiltinViewerDeps {
	/** Tree-sitter highlight, returning ANSI output or null. Absent when the
	 *  bridge is unavailable, and the viewer falls back to plain text rather
	 *  than failing. */
	readonly highlight?: (text: string, language: string) => Promise<string | null>;
	/** Turn a highlighter's ANSI output into preview HTML. */
	readonly highlightToHtml?: (ansi: string) => string;
	/** Render a spreadsheet to escaped HTML tables. Absent disables the sheets viewer. */
	readonly buildSheets?: (bytes: Uint8Array) => { name: string; html: string; truncated: boolean }[] | null;
	/** Render PDF pages to data URLs. Absent disables the pdf viewer. */
	readonly renderPdfPages?: (bytes: Uint8Array) => Promise<string[]>;
}

/**
 * The decoded editor buffer, or `undefined` for a file too large to hold.
 *
 * Not exported: the ceiling is the editor's, not a caller's, and a viewer
 * deciding this for itself would hand the pane a buffer the editor refuses.
 */
function editorBuffer(text: string, bytes: Uint8Array, maxBytes: number): string | undefined {
	return bytes.length <= maxBytes ? text : undefined;
}

function decode(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

function plainTextViewer(deps: BuiltinViewerDeps): FileViewer {
	return {
		id: "text",
		priority: VIEWER_PRIORITY.builtin,
		matches: input => looksLikeText(input),
		render: async (input: ViewerInput): Promise<ViewerResult> => {
			const text = decode(input.bytes);
			const raw = editorBuffer(text, input.bytes, MAX_EDIT_BYTES);
			// HTML previews ARE the page, not its source — same decision the
			// ladder made, for the same reason: a file panel showing markup
			// source for a page the person asked to see is the wrong answer.
			if (input.ext === "html" || input.ext === "htm") {
				return { kind: "html", text, ...(raw === undefined ? {} : { raw }) };
			}
			if (input.ext === "md" || input.ext === "markdown") {
				return { kind: "markdown", text, ...(raw === undefined ? {} : { raw }) };
			}
			const language = EXT_LANG[input.ext];
			if (language && deps.highlight && deps.highlightToHtml) {
				try {
					const highlighted = await deps.highlight(text, language);
					if (highlighted) {
						return {
							kind: "highlighted",
							html: deps.highlightToHtml(highlighted),
							...(raw === undefined ? {} : { raw }),
						};
					}
				} catch {
					// Highlighting is decoration. A bridge failure falls through to
					// plain text rather than failing the preview.
				}
			}
			return { kind: "text", text, ...(raw === undefined ? {} : { raw }) };
		},
	};
}

function imageViewer(): FileViewer {
	return {
		id: "image",
		priority: VIEWER_PRIORITY.builtin,
		matches: input => input.mime?.startsWith("image/") ?? false,
		render: async (input: ViewerInput) => ({
			kind: "image",
			blobUrl: URL.createObjectURL(new Blob([input.bytes], { type: input.mime })),
		}),
	};
}

function pdfViewer(deps: BuiltinViewerDeps): FileViewer {
	return {
		id: "pdf",
		priority: VIEWER_PRIORITY.builtin,
		matches: input => input.mime === "application/pdf",
		render: async (input: ViewerInput) => {
			if (!deps.renderPdfPages) return undefined;
			// A corrupt or encrypted PDF declines rather than failing: the host's
			// answer for those is to open it in the system app.
			try {
				return { kind: "pdf", pages: await deps.renderPdfPages(input.bytes) };
			} catch {
				return undefined;
			}
		},
	};
}

function docxViewer(): FileViewer {
	return {
		id: "docx",
		priority: VIEWER_PRIORITY.builtin,
		matches: input => input.ext === "docx",
		render: async (input: ViewerInput) => ({
			kind: "docx",
			bytes: input.bytes.buffer.slice(input.bytes.byteOffset, input.bytes.byteOffset + input.bytes.byteLength),
		}),
	};
}

function sheetsViewer(deps: BuiltinViewerDeps): FileViewer {
	return {
		id: "sheets",
		priority: VIEWER_PRIORITY.builtin,
		matches: input => input.ext === "xlsx" || input.ext === "xls" || input.ext === "csv",
		render: async (input: ViewerInput) => {
			if (!deps.buildSheets) return undefined;
			const sheets = deps.buildSheets(input.bytes);
			// An encrypted or corrupt workbook declines to the system app.
			return sheets ? { kind: "sheets", sheets } : undefined;
		},
	};
}

/** Every built-in viewer, in the order they should be tried. */
export function builtinFileViewers(deps: BuiltinViewerDeps): FileViewer[] {
	return [plainTextViewer(deps), imageViewer(), pdfViewer(deps), docxViewer(), sheetsViewer(deps)];
}
