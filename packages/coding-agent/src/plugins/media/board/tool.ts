/**
 * `board` tool — read/query/edit the desktop's kanban boards (the same
 * store the GUI renders: ~/.musepi/boards/boards.json). Agents design and
 * update board cards through this tool: list boards, read one board,
 * save an edited board (validated: known widget types + integer
 * positions), or query the widget schema (types/fields/defaults/tones)
 * before authoring widgets.
 */
import { type } from "@musepi/musepi-type";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@musepi/pi-agent-core";
import type { ToolExample } from "@musepi/pi-ai";
import type { ExtensionWidget } from "../../../extensibility/extensions/widget-types";
import { widgetTonesWith, widgetTypesWith } from "./catalog";
import boardDescription from "./prompt.md" with { type: "text" };
import { listCardResources, ResourceScopeError, readCardText, writeCardText } from "./resources";
import { readBoards, validateBoards, writeBoards } from "./store";

const boardSchema = type({
	action: type("string").describe("list | get | save | schema | resource.list | resource.read | resource.write"),
	"id?": type("string").describe("Board id (get/save/resource targets)"),
	"board?": type("object").describe("Full board object {id,title,widgets} for save"),
	"widgetId?": type("string").describe("Card id, for resource.list / resource.read"),
	"resourcePath?": type("string").describe("Card-relative file path, for resource.read / resource.write"),
	"resourceText?": type("string").describe("Text to write, for resource.write"),
	"expectedRev?": type("number").describe(
		"Revision you last read; save refuses when the board moved on (another writer won)",
	),
});

/** A scope refusal is the model's mistake to read, not a stack trace. */
function scopeError(error: unknown): string {
	if (error instanceof ResourceScopeError) return error.message;
	return error instanceof Error ? error.message : String(error);
}

/** What the board validator reads from the session context: plugin types. */
type BoardToolContext = {
	getRegisteredWidgets?(): readonly ExtensionWidget[];
};

export class BoardTool implements AgentTool<typeof boardSchema, unknown> {
	readonly name = "board";
	readonly label = "Board";
	readonly strict = true;
	readonly approval = "read" as const;
	/** Keep the board in the top-level schema (extension tools default to
	 *  discoverable otherwise). */
	readonly loadMode = "essential" as const;
	/** Session gate: the board presentation switch must keep working now that
	 *  the tool ships as a builtin plugin. */
	readonly enabled = ({ settings }: { settings: { get(key: string): unknown } }): boolean =>
		settings.get("board.enabled") !== false;
	readonly description = boardDescription;
	readonly parameters = boardSchema;
	readonly examples: readonly ToolExample<typeof boardSchema.infer>[] = [
		{ caption: "List all boards", call: { action: "list" } },
		{ caption: "Query the widget schema", call: { action: "schema" } },
		{
			caption: "Put a generated block on a board",
			call: {
				action: "save",
				id: "hello",
				board: {
					id: "hello",
					title: "一块活的看板",
					widgets: [
						{
							id: "w1",
							type: "block",
							title: "迁移顺序",
							data: { source: 'root = Stack([Steps([{title: "影子写", status: "done"}, {title: "切主"}])])' },
							pos: { x: 0, y: 0, w: 452, h: 200 },
						},
					],
				},
			},
		},
	];

	async execute(
		_toolCallId: string,
		params: typeof boardSchema.infer,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<unknown>,
		_context?: unknown,
	): Promise<AgentToolResult<unknown>> {
		const action = typeof params.action === "string" ? params.action : "";
		// Plugin-contributed card types never enter the static table (their
		// plugin runs from its own copied tree); merge the session's registry
		// so agents can save and inspect cards they registered.
		const runtimeWidgets = (_context as BoardToolContext | undefined)?.getRegisteredWidgets?.() ?? [];
		const types = widgetTypesWith(runtimeWidgets);
		const tones = widgetTonesWith(runtimeWidgets);
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
		const widgetLine = (w: {
			type: string;
			title?: string;
			pos?: unknown;
			data?: Record<string, unknown>;
		}): string => {
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
						content: [
							{
								type: "text",
								text: `board: no board with id "${id}" — available: ${boards.map(b => b.id).join(", ") || "none"}`,
							},
						],
						isError: true,
					};
				}
				const lines = board.widgets.map((w, i) => `[${i + 1}] ${widgetLine(w as never)}`);
				return {
					content: [
						{
							type: "text",
							text: `board "${board.title}" (${board.widgets.length} widgets)\n${lines.join("\n")}`,
						},
					],
					details: { board },
				};
			}
			case "schema": {
				const lines = Object.entries(types).map(
					([type, spec]) =>
						`${type}: fields=[${spec.fields.map(f => `${f.key}:${f.type}`).join(", ")}] defaults=${compact(spec.defaults, 160)} tone=${tones[type] ?? "default"}`,
				);
				return {
					content: [{ type: "text", text: `widget schema:\n${lines.join("\n")}` }],
					details: { types, tones },
				};
			}
			case "resource.list": {
				const boardId = typeof params.id === "string" ? params.id : "";
				const widgetId = typeof params.widgetId === "string" ? params.widgetId : "";
				if (!boardId || !widgetId) {
					return { content: [{ type: "text", text: "board: resource.list needs id + widgetId" }], isError: true };
				}
				try {
					const entries = listCardResources(boardId, widgetId);
					const text = entries.length
						? entries
								.map(
									entry =>
										`${entry.kind === "dir" ? "dir " : "file"} ${entry.path}${entry.kind === "file" ? ` (${entry.bytes}B)` : ""}`,
								)
								.join("\n")
						: "（这张卡没有资源文件）";
					return { content: [{ type: "text", text }] };
				} catch (error) {
					return { content: [{ type: "text", text: `board: ${scopeError(error)}` }], isError: true };
				}
			}
			case "resource.read": {
				const boardId = typeof params.id === "string" ? params.id : "";
				const widgetId = typeof params.widgetId === "string" ? params.widgetId : "";
				const resourcePath = typeof params.resourcePath === "string" ? params.resourcePath : "";
				if (!boardId || !widgetId || !resourcePath) {
					return {
						content: [{ type: "text", text: "board: resource.read needs id + widgetId + resourcePath" }],
						isError: true,
					};
				}
				try {
					return { content: [{ type: "text", text: readCardText(boardId, widgetId, resourcePath) }] };
				} catch (error) {
					return { content: [{ type: "text", text: `board: ${scopeError(error)}` }], isError: true };
				}
			}
			case "resource.write": {
				const boardId = typeof params.id === "string" ? params.id : "";
				const widgetId = typeof params.widgetId === "string" ? params.widgetId : "";
				const resourcePath = typeof params.resourcePath === "string" ? params.resourcePath : "";
				const resourceText = typeof params.resourceText === "string" ? params.resourceText : "";
				if (!boardId || !widgetId || !resourcePath) {
					return {
						content: [{ type: "text", text: "board: resource.write needs id + widgetId + resourcePath" }],
						isError: true,
					};
				}
				try {
					const bytes = writeCardText(boardId, widgetId, resourcePath, resourceText);
					return { content: [{ type: "text", text: `已写入 ${resourcePath}（${bytes}B）` }] };
				} catch (error) {
					return { content: [{ type: "text", text: `board: ${scopeError(error)}` }], isError: true };
				}
			}
			case "save": {
				// `builtin` is a system flag set only by the seed code — strip
				// any agent-supplied copy so a model can't create a board that
				// the GUI treats as a protected example (undeletable, and the
				// tool itself refuses to modify it later).
				const { builtin: _strip, ...clean } = (params.board as { builtin?: unknown }) ?? {};
				const board = clean as unknown;
				const check = validateBoards([board], types);
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
						content: [
							{
								type: "text",
								text: `board: "${id}" is a built-in example and cannot be modified — create a new board instead`,
							},
						],
						isError: true,
					};
				}
				// A stale regeneration must not overwrite a newer one. The board
				// carries a revision; a caller that read it passes it back, and a
				// mismatch means someone else wrote in between.
				const storedRev = (existing as unknown as { rev?: unknown } | undefined)?.rev;
				const currentRev = typeof storedRev === "number" ? storedRev : 0;
				if (typeof params.expectedRev === "number" && params.expectedRev !== currentRev) {
					return {
						content: [
							{
								type: "text",
								text: `board: "${id}" changed since you read it (rev ${params.expectedRev} → ${currentRev}) — read it again and re-apply your edit`,
							},
						],
						isError: true,
					};
				}
				const next = { ...(board as Record<string, unknown>), rev: currentRev + 1 } as unknown;
				const idx = current.findIndex(b => b.id === id);
				if (idx >= 0) current[idx] = next as never;
				else current.push(next as never);
				writeBoards(current);
				return {
					content: [
						{
							type: "text",
							text: `saved board "${id}" (${((board as { widgets?: unknown[] }).widgets ?? []).length} widgets)`,
						},
					],
					details: { boards: current },
				};
			}
			default: {
				return {
					content: [{ type: "text", text: `board: unknown action "${action}" — list | get | save | schema` }],
					isError: true,
				};
			}
		}
	}
}
