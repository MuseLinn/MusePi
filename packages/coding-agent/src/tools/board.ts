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
		// Provider serializers send only `content` to the model — everything
		// the agent needs to author boards (existing cards, field schemas)
		// must live in text, with `details` as the GUI's render payload.
		const compact = (v: unknown, max = 400): string => {
			try {
				const s = JSON.stringify(v);
				return s.length > max ? `${s.slice(0, max)}…` : s;
			} catch {
				return String(v);
			}
		};
		const widgetLine = (w: { type: string; title?: string; pos?: unknown; data?: Record<string, unknown> }): string => {
			const t = typeof w.title === "string" && w.title.length > 0 ? ` "${w.title}"` : "";
			const p = w.pos ? ` pos=${compact(w.pos, 120)}` : "";
			const d = w.data && Object.keys(w.data).length > 0 ? ` data=${compact(w.data)}` : "";
			return `${w.type}${t}${p}${d}`;
		};
		switch (action) {
			case "list": {
				const boards = readBoards();
				const text =
					boards.length === 0
						? "no boards yet"
						: boards
								.map(
									b =>
										`${b.id} "${b.title}" (${b.widgets.length} widgets): ${b.widgets.map(w => w.type).join(", ") || "empty"}`,
								)
								.join("\n");
				return {
					content: [{ type: "text", text: `${boards.length} board(s):\n${text}` }],
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
				const lines = board.widgets.map((w, i) => `[${i + 1}] ${widgetLine(w as never)}`);
				return {
					content: [{ type: "text", text: `board "${board.title}" (${board.widgets.length} widgets)\n${lines.join("\n")}` }],
					details: { board },
				};
			}
			case "schema": {
				const lines = Object.entries(WIDGET_TYPES).map(
					([type, spec]) =>
						`${type}: fields=[${spec.fields.map(f => `${f.key}:${f.type}`).join(", ")}] defaults=${compact(spec.defaults, 160)} tone=${WIDGET_TONES[type] ?? "default"}`,
				);
				return {
					content: [{ type: "text", text: `widget schema:\n${lines.join("\n")}` }],
					details: { types: WIDGET_TYPES, tones: WIDGET_TONES },
				};
			}
			case "save": {
				// `builtin` is a system flag set only by the seed code — strip
				// any agent-supplied copy so a model can't create a board that
				// the GUI treats as a protected example (undeletable, and the
				// tool itself refuses to modify it later).
				const { builtin: _strip, ...clean } = (params.board as { builtin?: unknown }) ?? {};
				const board = clean as unknown;
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
