/**
 * Shared board store: read/write/validate ~/.musepi/boards/boards.json.
 * Used by BOTH the daemon RPC (board.list / board.save) and the model's
 * `board` AgentTool so agents and the GUI share one authoritative store
 * with identical validation.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
}

export function boardsFile(): string {
	return path.join(os.homedir(), ".musepi", "boards", "boards.json");
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
			widgets: Array.isArray(b.widgets)
				? b.widgets.map((w: { pos?: Record<string, unknown> }) => {
						const p = w.pos ?? {};
						return {
							...(w as object),
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

/** Atomic write (tmp + rename). */
export function writeBoards(boards: BoardRecord[]): void {
	const file = boardsFile();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(boards, null, 2));
	fs.renameSync(tmp, file);
}

export interface ValidateResult {
	ok: boolean;
	error?: string;
}

/** Validate boards for persistence: known widget types, integer
 *  positions (whole-pixel canvas), id/title strings. */
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
			if (w.type === "html") {
				const html = (w as { data?: { html?: unknown } }).data?.html;
				if (typeof html !== "string" || html.length > 64_000) {
					return { ok: false, error: `html widget needs data.html string ≤ 64KB` };
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
