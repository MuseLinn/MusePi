/**
 * Shared board store: read/write/validate ~/.musepi/boards/boards.json.
 * Used by BOTH the daemon RPC (board.list / board.save) and the model's
 * `board` AgentTool so agents and the GUI share one authoritative store
 * with identical validation.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { MAX_WIDGET_HTML } from "@musepi/pi-utils";
import { boardsRoot, CARD_CONTENT_FIELD, CARD_CONTENT_FILE, readCardText, writeCardText } from "./resources";

export interface BoardPos {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface BoardWidgetRecord {
	id: string;
	type: string;
	title: string;
	data: Record<string, unknown>;
	pos: BoardPos;
}

export interface BoardRecord {
	id: string;
	title: string;
	widgets: BoardWidgetRecord[];
	/** Seed examples: protected from agent modification. */
	builtin?: boolean;
	/** Bumped on every save; a caller that read the board passes it back. */
	rev?: number;
}

export function boardsFile(): string {
	return path.join(boardsRoot(), "boards.json");
}

/** Read boards; [] when missing/corrupt. Whole-pixel positions enforced. */
export function readBoards(): BoardRecord[] {
	try {
		const file = boardsFile();
		if (!fs.existsSync(file)) return [];
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!Array.isArray(parsed)) return [];
		return parsed.map((b: { id?: unknown; title?: unknown; widgets?: unknown; builtin?: unknown }) => ({
			id: typeof b.id === "string" ? b.id : "b",
			title: typeof b.title === "string" ? b.title : "",
			...(b.builtin === true ? { builtin: true as const } : {}),
			...(typeof (b as { rev?: unknown }).rev === "number" ? { rev: (b as { rev: number }).rev } : {}),
			widgets: Array.isArray(b.widgets)
				? b.widgets.map((w: { pos?: Record<string, unknown>; type?: unknown; id?: unknown }) => {
						const p = w.pos ?? {};
						return {
							...hydrateCardContent(typeof b.id === "string" ? b.id : "b", w as unknown as BoardWidgetRecord),
							pos: {
								x: Math.round(Number(p.x) || 0),
								y: Math.round(Number(p.y) || 0),
								w: Math.round(Number(p.w) || 0),
								h: Math.round(Number(p.h) || 0),
							},
						} as BoardWidgetRecord;
					})
				: [],
		})) as BoardRecord[];
	} catch {
		return [];
	}
}

/**
 * The content a card draws lives in its folder, not in the index.
 *
 * `boards.json` keeps identity, layout, revision and the small `data` fields a
 * renderer needs; the block program or HTML document goes to
 * `<board>/<card>/source.oui` / `page.html`. The index therefore stays small no
 * matter how long a page is, and a card's assets sit next to the content that
 * references them.
 */
function hydrateCardContent(boardId: string, widget: BoardWidgetRecord): BoardWidgetRecord {
	const file = CARD_CONTENT_FILE[widget.type];
	const field = CARD_CONTENT_FIELD[widget.type];
	if (!file || !field) return widget;
	const data = widget.data ?? {};
	if (typeof data[field] === "string") return widget;
	try {
		const text = readCardText(boardId, widget.id, file);
		return { ...widget, data: { ...data, [field]: text } };
	} catch {
		// A card whose file is gone still loads: it renders as empty and its
		// failure is visible, rather than the whole board failing to read.
		return widget;
	}
}

/** Persist every card's content into its folder, then drop it from the index. */
function externalizeCardContent(boardId: string, widget: BoardWidgetRecord): BoardWidgetRecord {
	const file = CARD_CONTENT_FILE[widget.type];
	const field = CARD_CONTENT_FIELD[widget.type];
	if (!file || !field) return widget;
	const data = widget.data ?? {};
	const content = data[field];
	if (typeof content !== "string") return widget;
	try {
		writeCardText(boardId, widget.id, file, content);
	} catch {
		// A card outside the scope (bad id) keeps its inline copy: losing the
		// content would be worse than a large index entry.
		return widget;
	}
	const { [field]: _moved, ...rest } = data;
	return { ...widget, data: rest };
}

/** Atomic write (tmp + rename), with each card's content in its own folder. */
export function writeBoards(boards: BoardRecord[]): void {
	const file = boardsFile();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const thin = boards.map(board => ({
		...board,
		widgets: (board.widgets ?? []).map(widget => externalizeCardContent(board.id, widget)),
	}));
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(thin, null, 2));
	fs.renameSync(tmp, file);
}

export interface ValidateResult {
	ok: boolean;
	error?: string;
}

/** Validate boards for persistence: known widget types, integer
 *  positions (whole-pixel canvas), id/title strings. */
/** A block on a board is read at a glance; anything longer belongs in a page. */
const MAX_BLOCK_SOURCE = 12_000;

export function validateBoards(boards: unknown, knownTypes: Record<string, unknown>): ValidateResult {
	if (!Array.isArray(boards)) return { ok: false, error: "board expects boards: array" };
	for (const b of boards) {
		const board = b as { id?: unknown; title?: unknown; widgets?: unknown };
		if (typeof board.id !== "string" || typeof board.title !== "string") {
			return { ok: false, error: "each board needs id + title strings" };
		}
		if (!Array.isArray(board.widgets)) return { ok: false, error: `${board.id} widgets must be an array` };
		for (const w of board.widgets as Array<{ type?: unknown; pos?: unknown }>) {
			if (typeof w.type !== "string" || !(w.type in knownTypes)) {
				return { ok: false, error: `unknown widget type "${String(w.type)}"` };
			}
			if (w.type === "block") {
				const source = (w as { data?: { source?: unknown } }).data?.source;
				if (typeof source !== "string" || source.trim().length === 0 || source.length > MAX_BLOCK_SOURCE) {
					return { ok: false, error: `block widget needs data.source (OpenUI Lang) ≤ ${MAX_BLOCK_SOURCE}` };
				}
				// A block that cannot parse is a candidate the board must refuse
				// now, not a card that will draw an error later: the save is the
				// one moment the agent is still here to fix it.
				if (!/^\s*root\s*=\s*Stack\s*\(/m.test(source)) {
					return {
						ok: false,
						error: "block widget needs a `root = Stack([...])` program as its source",
					};
				}
			}
			if (w.type === "html") {
				const html = (w as { data?: { html?: unknown } }).data?.html;
				if (typeof html !== "string" || html.length > MAX_WIDGET_HTML) {
					return { ok: false, error: `html widget needs data.html string ≤ ${MAX_WIDGET_HTML}` };
				}
			}
			const p = w.pos as { x?: unknown; y?: unknown; w?: unknown; h?: unknown } | undefined;
			if (!p || [p.x, p.y, p.w, p.h].some(v => typeof v !== "number" || !Number.isInteger(v))) {
				return { ok: false, error: `widget ${String(w.type)} needs integer pos {x,y,w,h}` };
			}
		}
	}
	return { ok: true };
}
