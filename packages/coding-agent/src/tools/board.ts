/**
 * `board` tool — read/query/edit the desktop's kanban boards (the same
 * store the GUI renders: ~/.musepi/boards/boards.json). Agents design and
 * update board cards through this tool: list boards, read one board,
 * save an edited board (validated: known widget types + integer
 * positions), or query the widget schema (types/fields/defaults/tones)
 * before authoring widgets.
 */
import { type } from "@musepi/omptype";
import boardDescription from "../prompts/tools/board.md" with { type: "text" };
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@musepi/pi-agent-core";
import type { ToolExample } from "@musepi/pi-ai";
import { readBoards, validateBoards, writeBoards } from "../daemon/boards";
import { WIDGET_TONES, WIDGET_TYPES } from "./widget";

const boardSchema = type({
	action: type("string").describe("list | get | save | schema"),
	"id?": type("string").describe("Board id (get/save targets)"),
	"board?": type("object").describe("Full board object {id,title,widgets} for save"),
});

export class BoardTool implements AgentTool<typeof boardSchema, unknown> {
	readonly name = "board";
	readonly label = "Board";
	readonly strict = true;
	readonly approval = "read" as const;
	readonly description = boardDescription;
	readonly parameters = boardSchema;
	readonly examples: readonly ToolExample<typeof boardSchema.infer>[] = [
		{ caption: "List all boards", call: { action: "list" } },
		{ caption: "Query the widget schema", call: { action: "schema" } },
		{
			caption: "Add a pomodoro card to a board",
			call: {
				action: "save",
				id: "hello",
				board: {
					id: "hello",
					title: "一块活的看板",
					widgets: [{ id: "w1", type: "pomodoro", title: "番茄钟", data: {}, pos: { x: 0, y: 0, w: 300, h: 300 } }],
				},
			},
		},
	];

	async execute(
		_toolCallId: string,
		params: typeof boardSchema.infer,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<unknown>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<unknown>> {
		const action = typeof params.action === "string" ? params.action : "";
		switch (action) {
			case "list": {
				const boards = readBoards();
				return {
					content: [{ type: "text", text: `${boards.length} board(s): ${boards.map(b => `${b.id} "${b.title}" (${b.widgets.length} widgets)`).join(", ") || "none"}` }],
					details: { boards },
				};
			}
			case "get": {
				const boards = readBoards();
				const id = typeof params.id === "string" ? params.id : "";
				const board = boards.find(b => b.id === id);
				if (!board) {
					return {
						content: [{ type: "text", text: `board: no board with id "${id}" — available: ${boards.map(b => b.id).join(", ") || "none"}` }],
						isError: true,
					};
				}
				return { content: [{ type: "text", text: `board "${board.title}" (${board.widgets.length} widgets)` }], details: { board } };
			}
			case "schema": {
				return {
					content: [{ type: "text", text: `widget types: ${Object.keys(WIDGET_TYPES).join(", ")}` }],
					details: { types: WIDGET_TYPES, tones: WIDGET_TONES },
				};
			}
			case "save": {
				const board = params.board as unknown;
				const check = validateBoards([board], WIDGET_TYPES);
				if (!check.ok) {
					return { content: [{ type: "text", text: `board: invalid — ${check.error}` }], isError: true };
				}
				const id = typeof params.id === "string" ? params.id : "";
				const current = readBoards();
				// Seed examples are protected: agents cannot modify them
				// (the GUI also hides delete for builtin boards).
				const existing = current.find(b => b.id === id);
				if (existing && (existing as { builtin?: boolean }).builtin === true) {
					return {
						content: [{ type: "text", text: `board: "${id}" is a built-in example and cannot be modified — create a new board instead` }],
						isError: true,
					};
				}
				const idx = current.findIndex(b => b.id === id);
				if (idx >= 0) current[idx] = board as never;
				else current.push(board as never);
				writeBoards(current);
				return {
					content: [{ type: "text", text: `saved board "${id}" (${((board as { widgets?: unknown[] }).widgets ?? []).length} widgets)` }],
					details: { boards: current },
				};
			}
			default: {
				return { content: [{ type: "text", text: `board: unknown action "${action}" — list | get | save | schema` }], isError: true };
			}
		}
	}
}
