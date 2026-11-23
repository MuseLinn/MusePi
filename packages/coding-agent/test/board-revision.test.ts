import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BoardTool } from "../src/plugins/media/board/tool";

/**
 * A regenerated board must not overwrite one a user just edited. The board
 * carries a revision, and a caller that read it passes it back; a mismatch is
 * a conflict the model can act on, not a silent overwrite.
 */

let dir: string;
const previousRoot = process.env.MUSEPI_BOARDS_DIR;
const board = (title: string) => ({
	id: "b1",
	title,
	widgets: [
		{
			type: "block",
			title: "x",
			data: { source: 'root = Stack([Text("hi")])' },
			pos: { x: 0, y: 0, w: 320, h: 200 },
		},
	],
});

beforeAll(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-board-rev-"));
	process.env.MUSEPI_BOARDS_DIR = dir;
});

afterAll(() => {
	if (previousRoot === undefined) delete process.env.MUSEPI_BOARDS_DIR;
	else process.env.MUSEPI_BOARDS_DIR = previousRoot;
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("board revision", () => {
	it("stamps the first save as rev 1", async () => {
		const tool = new BoardTool();
		await tool.execute("c1", { action: "save", id: "b1", board: board("first") });
		const saved = JSON.parse(fs.readFileSync(path.join(dir, "boards.json"), "utf8"));
		expect(saved[0].rev).toBe(1);
	});

	it("accepts a save that names the revision it read", async () => {
		const tool = new BoardTool();
		const res = await tool.execute("c1", { action: "save", id: "b1", board: board("second"), expectedRev: 1 });
		expect(res.isError).not.toBe(true);
		const saved = JSON.parse(fs.readFileSync(path.join(dir, "boards.json"), "utf8"));
		expect(saved[0].rev).toBe(2);
		expect(saved[0].title).toBe("second");
	});

	it("refuses a stale save and says how far behind it is", async () => {
		const tool = new BoardTool();
		const res = await tool.execute("c1", { action: "save", id: "b1", board: board("stale"), expectedRev: 1 });
		expect(res.isError).toBe(true);
		const text = res.content[0]?.type === "text" ? res.content[0].text : "";
		expect(text).toMatch(/changed since you read it/);
		const saved = JSON.parse(fs.readFileSync(path.join(dir, "boards.json"), "utf8"));
		expect(saved[0].title).toBe("second");
	});
});
