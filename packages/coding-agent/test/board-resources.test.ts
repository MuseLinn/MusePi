import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	cardDir,
	listCardResources,
	MAX_RESOURCE_BYTES,
	ResourceScopeError,
	readCardText,
	resolveCardPath,
} from "../src/plugins/media/board/resources";

/**
 * A card's workspace is a folder, and a model writes the paths into it. These
 * cases are the scope rule: a path that leaves the card is refused, whether it
 * says so (`..`), hides in an absolute form, or leaves through a link.
 */

let home: string;
const previousRoot = process.env.MUSEPI_BOARDS_DIR;

beforeAll(() => {
	// The store resolves under one root; point it at a scratch directory.
	home = fs.mkdtempSync(path.join(process.env.TEMP ?? process.env.TMPDIR ?? "/tmp", "musepi-board-res-"));
	process.env.MUSEPI_BOARDS_DIR = home;
});

afterAll(() => {
	if (previousRoot === undefined) delete process.env.MUSEPI_BOARDS_DIR;
	else process.env.MUSEPI_BOARDS_DIR = previousRoot;
	fs.rmSync(home, { recursive: true, force: true });
});

describe("card scope", () => {
	it("builds a folder per card", () => {
		expect(cardDir("main", "w1")).toBe(path.join(home, "main", "w1"));
	});

	it("refuses ids that are not folder names", () => {
		for (const id of ["..", ".", "a/b", "", "a b", "x".repeat(80)]) {
			expect(() => cardDir(id, "w1")).toThrow(ResourceScopeError);
		}
	});

	it("refuses a path that leaves the card", () => {
		for (const rel of ["../other/secret.txt", "../../etc/passwd", "/etc/passwd", "C:/Windows/win.ini", "a/../../b"]) {
			expect(() => resolveCardPath("main", "w1", rel)).toThrow(ResourceScopeError);
		}
	});

	it("refuses a link that points outside", () => {
		const dir = cardDir("main", "w1");
		fs.mkdirSync(dir, { recursive: true });
		const outside = path.join(home, "outside.txt");
		fs.writeFileSync(outside, "secret");
		const link = path.join(dir, "link.txt");
		try {
			fs.symlinkSync(outside, link);
		} catch {
			return; // no symlink privilege on this host
		}
		expect(() => resolveCardPath("main", "w1", "link.txt")).toThrow(/link/);
	});
});

describe("card resources", () => {
	it("lists what a card owns and nothing else", () => {
		const dir = cardDir("main", "w2");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "data.csv"), "a,b\n1,2\n");
		const entries = listCardResources("main", "w2");
		expect(entries.map(entry => entry.path)).toEqual(["data.csv"]);
		expect(entries[0]?.bytes).toBe(8);
	});

	it("an absent folder is an empty card, not an error", () => {
		expect(listCardResources("main", "nope")).toEqual([]);
	});

	it("reads text inside the card", () => {
		const dir = cardDir("main", "w3");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "note.md"), "# 说明\n");
		expect(readCardText("main", "w3", "note.md")).toBe("# 说明\n");
	});

	it("refuses binary content instead of mangling it", () => {
		const dir = cardDir("main", "w3");
		fs.writeFileSync(path.join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
		expect(() => readCardText("main", "w3", "logo.png")).toThrow(/binary/);
	});

	it("refuses a file over the read cap", () => {
		const dir = cardDir("main", "w3");
		fs.writeFileSync(path.join(dir, "big.txt"), "x".repeat(MAX_RESOURCE_BYTES + 1));
		expect(() => readCardText("main", "w3", "big.txt")).toThrow(/exceeds/);
	});
});

describe("writing card resources", () => {
	it("writes inside the card and reads it back", async () => {
		const { writeCardText } = await import("../src/plugins/media/board/resources");
		const bytes = writeCardText("main", "w4", "data/rates.csv", "pair,value\nUSD/CNY,7.24\n");
		expect(bytes).toBeGreaterThan(0);
		expect(readCardText("main", "w4", "data/rates.csv")).toContain("USD/CNY");
		// the folder is created on demand, and the write left no temp file behind
		expect(listCardResources("main", "w4").map(entry => entry.path)).toEqual(["data"]);
	});

	it("refuses to write outside the card", async () => {
		const { writeCardText } = await import("../src/plugins/media/board/resources");
		expect(() => writeCardText("main", "w4", "../escape.txt", "x")).toThrow(ResourceScopeError);
	});

	it("refuses a write over the cap", async () => {
		const { writeCardText } = await import("../src/plugins/media/board/resources");
		expect(() => writeCardText("main", "w4", "big.txt", "x".repeat(MAX_RESOURCE_BYTES + 1))).toThrow(/exceeds/);
	});
});

describe("one card is one folder", () => {
	it("the save moves a card's content into its folder and thins the index", async () => {
		const { readBoards, writeBoards } = await import("../src/plugins/media/board/store");
		const source = 'root = Stack([Text("放在文件里")])';
		writeBoards([
			{
				id: "dir",
				title: "t",
				widgets: [{ id: "c1", type: "block", title: "x", data: { source }, pos: { x: 0, y: 0, w: 320, h: 200 } }],
			},
		]);
		const onDisk = JSON.parse(fs.readFileSync(path.join(home, "boards.json"), "utf8"));
		expect(onDisk[0].widgets[0].data.source).toBeUndefined();
		expect(fs.existsSync(path.join(home, "dir", "c1", "source.oui"))).toBe(true);
		// and reading gives the content back, so the renderer never changes
		expect(readBoards()[0]?.widgets[0]?.data.source).toBe(source);
	});

	it("a page goes to page.html", async () => {
		const { readBoards, writeBoards } = await import("../src/plugins/media/board/store");
		writeBoards([
			{
				id: "dir2",
				title: "t",
				widgets: [
					{
						id: "c2",
						type: "html",
						title: "p",
						data: { html: "<h1>hi</h1>" },
						pos: { x: 0, y: 0, w: 320, h: 200 },
					},
				],
			},
		]);
		expect(fs.readFileSync(path.join(home, "dir2", "c2", "page.html"), "utf8")).toBe("<h1>hi</h1>");
		expect(readBoards()[0]?.widgets[0]?.data.html).toBe("<h1>hi</h1>");
	});

	it("a card whose file vanished still loads the board", async () => {
		const { readBoards, writeBoards } = await import("../src/plugins/media/board/store");
		writeBoards([
			{
				id: "dir3",
				title: "t",
				widgets: [
					{
						id: "c3",
						type: "block",
						title: "x",
						data: { source: "root = Stack([])" },
						pos: { x: 0, y: 0, w: 1, h: 1 },
					},
				],
			},
		]);
		fs.rmSync(path.join(home, "dir3", "c3", "source.oui"));
		expect(readBoards()[0]?.widgets).toHaveLength(1);
	});
});
