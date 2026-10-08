/**
 * The viewer registry, and the built-in viewers that moved into it.
 *
 * Two contracts are being held here. One is the order: a viewer registered by a
 * plugin must not silently displace a built-in it never heard of, and a viewer
 * that declines a file must leave the next one a turn. The other is the
 * fall-through: a format that can fail to decode — an encrypted workbook, a
 * corrupt PDF — has to decline rather than throw, because the host's answer for
 * those is to open the file elsewhere, not to show an error where a picture
 * should be.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { type BuiltinViewerDeps, builtinFileViewers, looksLikeText } from "../src/lib/builtin-file-viewers";
import {
	registerFileViewer,
	renderWithViewers,
	resetFileViewers,
	selectFileViewer,
	VIEWER_PRIORITY,
	type ViewerInput,
} from "../src/lib/file-viewers";

/** A neutral input; every case overrides the two or three fields it is about. */
const FILE_TEST_INPUT: ViewerInput = {
	name: "sample.txt",
	path: "/tmp/sample.txt",
	size: 4,
	bytes: new Uint8Array(new ArrayBuffer(4)),
	mime: "text/plain",
	ext: "txt",
};

const noDeps: BuiltinViewerDeps = {};

function input(partial: Partial<ViewerInput> & { bytes?: Uint8Array<ArrayBuffer> }): ViewerInput {
	return { ...FILE_TEST_INPUT, ...partial };
}

/** Bytes backed by a plain ArrayBuffer, which is what every consumer here needs. */
function bytes(text: string): Uint8Array<ArrayBuffer> {
	return new Uint8Array(new TextEncoder().encode(text).buffer as ArrayBuffer);
}

afterEach(() => {
	resetFileViewers();
});

describe("viewer registry", () => {
	it("tries viewers in priority order rather than registration order", async () => {
		// A plugin claiming `override` must beat the host's own viewer, and a
		// fallback viewer must not — otherwise "add a plugin" and "take over a
		// format" are the same operation with different luck.
		registerFileViewer({
			id: "fallback",
			priority: VIEWER_PRIORITY.fallback,
			matches: () => true,
			render: async () => ({ kind: "text", text: "fallback" }),
		});
		registerFileViewer({
			id: "override",
			priority: VIEWER_PRIORITY.override,
			matches: () => true,
			render: async () => ({ kind: "text", text: "override" }),
		});
		const result = await renderWithViewers(input({ ext: "ts", bytes: bytes("x") }));
		expect(result).toEqual({ kind: "text", text: "override" });
	});

	it("lets the next viewer take a file the previous one declined", async () => {
		// The decline path is what makes fall-through to the system app
		// possible: a viewer that matched and then failed must not consume the
		// file.
		registerFileViewer({
			id: "claims-pdf-then-declines",
			matches: input2 => input2.mime === "application/pdf",
			render: async () => undefined,
		});
		for (const viewer of builtinFileViewers({
			...noDeps,
			renderPdfPages: async () => ["data:image/png;base64,AA"],
		})) {
			registerFileViewer(viewer);
		}
		const result = await renderWithViewers(input({ ext: "pdf", mime: "application/pdf", bytes: bytes("%PDF") }));
		expect(result).toEqual({ kind: "pdf", pages: ["data:image/png;base64,AA"] });
	});

	it("reports no viewer rather than a failure when nothing takes the file", async () => {
		// `undefined` is the caller's cue to open it externally; an exception
		// here would turn "we do not handle this" into "this file is broken".
		expect(
			await renderWithViewers(input({ ext: "bin", mime: "application/octet-stream", bytes: bytes("x") })),
		).toBeUndefined();
	});

	it("replaces a viewer registered twice under one id", () => {
		// Reloading a plugin must not leave the old viewer in the table behind
		// the new one, or a reload silently changes which viewer wins.
		registerFileViewer({ id: "x", matches: () => true, render: async () => ({ kind: "text", text: "first" }) });
		registerFileViewer({ id: "x", matches: () => true, render: async () => ({ kind: "text", text: "second" }) });
		const ids = selectFileViewer(input({ bytes: bytes("a") }))?.id;
		expect(ids).toBe("x");
	});
});

describe("built-in viewers", () => {
	it("sends an HTML file to the live renderer rather than showing its source", async () => {
		for (const viewer of builtinFileViewers(noDeps)) registerFileViewer(viewer);
		const result = await renderWithViewers(input({ ext: "html", bytes: bytes("<h1>hi</h1>") }));
		expect(result?.kind).toBe("html");
	});

	it("sends Markdown to the Markdown renderer and everything else to text", async () => {
		for (const viewer of builtinFileViewers(noDeps)) registerFileViewer(viewer);
		expect((await renderWithViewers(input({ ext: "md", bytes: bytes("# t") })))?.kind).toBe("markdown");
		expect((await renderWithViewers(input({ ext: "rs", bytes: bytes("fn x() {}") })))?.kind).toBe("text");
	});

	it("reads a file whose extension says source but whose bytes say binary", () => {
		// A `.ts` file full of NULs is a binary that happens to be named like
		// source; treating it as text is how a preview renders a screenful of
		// replacement characters.
		const nul = new Uint8Array([0x00, 0x01, 0x00]);
		expect(looksLikeText({ ext: "ts", bytes: nul })).toBe(false);
		expect(looksLikeText({ ext: "ts", bytes: bytes("const x = 1;") })).toBe(true);
		// A mime the host resolved outranks the extension entirely.
		expect(looksLikeText({ ext: "ts", mime: "text/markdown", bytes: nul })).toBe(true);
	});

	it("withholds the editor buffer from a file past the editor ceiling", async () => {
		for (const viewer of builtinFileViewers(noDeps)) registerFileViewer(viewer);
		const big = bytes("x".repeat(2 * 1024 * 1024 + 10));
		const result = await renderWithViewers(input({ ext: "txt", bytes: big }));
		expect(result?.kind).toBe("text");
		expect(result).not.toHaveProperty("raw");
	});

	it("declines a spreadsheet when no sheet builder is available", async () => {
		// No builder means no viewer — the file opens elsewhere rather than
		// rendering an empty table that looks like the file was blank.
		// The mime is the real one: a workbook is not `text/*`, and a fixture that
		// claimed otherwise would be testing the text viewer's short-circuit
		// rather than the decline.
		for (const viewer of builtinFileViewers(noDeps)) registerFileViewer(viewer);
		const result = await renderWithViewers(
			input({
				name: "book.xlsx",
				ext: "xlsx",
				mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
				bytes: bytes("PK"),
			}),
		);
		expect(result).toBeUndefined();
	});

	it("declines a PDF rather than failing when rendering throws", async () => {
		for (const viewer of builtinFileViewers({
			...noDeps,
			renderPdfPages: async () => {
				throw new Error("encrypted");
			},
		})) {
			registerFileViewer(viewer);
		}
		expect(
			await renderWithViewers(input({ ext: "pdf", mime: "application/pdf", bytes: bytes("%PDF") })),
		).toBeUndefined();
	});

	it("claims a PDF with no renderer configured only as a decline, so nothing else is shadowed", async () => {
		for (const viewer of builtinFileViewers(noDeps)) registerFileViewer(viewer);
		expect(selectFileViewer(input({ ext: "pdf", mime: "application/pdf" }))?.id).toBe("pdf");
		expect(
			await renderWithViewers(input({ ext: "pdf", mime: "application/pdf", bytes: bytes("%PDF") })),
		).toBeUndefined();
	});
});
