/**
 * `board` tool — the model's door into the desktop kanban store: list,
 * get, save (validated) and widget-schema queries. The GUI renders the
 * same ~/.musepi/boards/boards.json, so agents and the GUI share one
 * authoritative board.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BoardTool } from "../../src/tools/board";

function boardsFile(): string {
	return path.join(os.homedir(), ".musepi", "boards", "boards.json");
}

function withTempBoard(body: () => Promise<void>): Promise<void> {
	const file = boardsFile();
	const backup = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		JSON.stringify([
			{
				id: "b1",
				title: "测试板",
				widgets: [{ id: "w1", type: "clock", title: "时钟", data: {}, pos: { x: 0, y: 0, w: 300, h: 210 } }],
			},
			{ id: "bbuiltin", title: "内置示例", builtin: true, widgets: [] },
		]),
	);
	return body().finally(() => {
		if (backup === null) fs.rmSync(file, { force: true });
		else fs.writeFileSync(file, backup);
	});
}

describe("board tool", () => {
	test("list returns the persisted boards", async () => {
		await withTempBoard(async () => {
			const tool = new BoardTool();
			const res = await tool.execute("c1", { action: "list" });
			expect(res.isError).not.toBe(true);
			const details = res.details as { boards: unknown[] };
			expect(details.boards).toHaveLength(2);
			expect((details.boards[0] as { id: string }).id).toBe("b1");
			expect((details.boards[1] as { builtin?: boolean }).builtin).toBe(true);
		});
	});

	test("get returns one board or a clear error", async () => {
		await withTempBoard(async () => {
			const tool = new BoardTool();
			const ok = await tool.execute("c1", { action: "get", id: "b1" });
			expect((ok.details as { board: { title: string } }).board.title).toBe("测试板");
			const miss = await tool.execute("c1", { action: "get", id: "nope" });
			expect(miss.isError).toBe(true);
		});
	});

	test("schema exposes types and tones", async () => {
		const tool = new BoardTool();
		const res = await tool.execute("c1", { action: "schema" });
		const details = res.details as { types: Record<string, unknown>; tones: Record<string, string> };
		expect(details.types).toHaveProperty("clock");
		expect(details.types).toHaveProperty("pomodoro");
		expect(details.tones.clock).toBe("dark");
		expect(details.tones.pomodoro).toBe("blue");
	});

	test("save upserts a board", async () => {
		await withTempBoard(async () => {
			const tool = new BoardTool();
			const board = {
				id: "b1",
				title: "测试板 v2",
				widgets: [
					{ id: "w1", type: "clock", title: "时钟", data: {}, pos: { x: 0, y: 0, w: 300, h: 210 } },
					{ id: "w2", type: "pomodoro", title: "番茄钟", data: {}, pos: { x: 0, y: 240, w: 300, h: 300 } },
				],
			};
			const res = await tool.execute("c1", { action: "save", id: "b1", board });
			expect(res.isError).not.toBe(true);
			const after = JSON.parse(fs.readFileSync(boardsFile(), "utf8")) as { widgets: unknown[] }[];
			expect(after[0].widgets).toHaveLength(2);
		});
	});

	test("save rejects unknown widget types", async () => {
		await withTempBoard(async () => {
			const tool = new BoardTool();
			const res = await tool.execute("c1", {
				action: "save",
				id: "b1",
				board: {
					id: "b1",
					title: "x",
					widgets: [{ id: "w", type: "nope", data: {}, pos: { x: 0, y: 0, w: 100, h: 100 } }],
				},
			});
			expect(res.isError).toBe(true);
			const text = res.content[0].type === "text" ? res.content[0].text : "";
			expect(text).toContain("unknown widget type");
		});
	});

	test("save rejects fractional positions (whole-pixel canvas)", async () => {
		await withTempBoard(async () => {
			const tool = new BoardTool();
			const res = await tool.execute("c1", {
				action: "save",
				id: "b1",
				board: {
					id: "b1",
					title: "x",
					widgets: [{ id: "w", type: "clock", data: {}, pos: { x: 0, y: 0.5, w: 100, h: 100 } }],
				},
			});
			expect(res.isError).toBe(true);
			const text = res.content[0].type === "text" ? res.content[0].text : "";
			expect(text).toContain("integer pos");
		});
	});

	test("rejects saving over a built-in example board", async () => {
		await withTempBoard(async () => {
			const tool = new BoardTool();
			const res = await tool.execute("c1", {
				action: "save",
				id: "bbuiltin",
				board: { id: "bbuiltin", title: "篡改", widgets: [] },
			});
			expect(res.isError).toBe(true);
			const text = res.content[0].type === "text" ? res.content[0].text : "";
			expect(text).toContain("built-in example");
		});
	});

	test("rejects unknown actions", async () => {
		const tool = new BoardTool();
		const res = await tool.execute("c1", { action: "nope" });
		expect(res.isError).toBe(true);
	});
});
