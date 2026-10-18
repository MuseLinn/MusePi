/**
 * Project knowledge store — notes, todos and plans, one owner for all three.
 *
 * The right panel (项目知识) and the agent both read and write these. Splitting
 * them by owner was the bug this module removes:
 *
 *  - notes and plans lived in the daemon (one markdown file per item under
 *    `<agentDir>/{notes,plans}/<cwdHash>/`), reachable only through `notes.*` /
 *    `plans.*` RPC — the agent had no tool for either;
 *  - todos lived in the GUI's `localStorage` under `musepi-gui-todos:<cwd>`, so
 *    the agent could never read them AT ALL, and a session with no window (a
 *    scheduled task, a dispatched subagent) had nothing to read.
 *
 * The panel UI needing a browser to own project knowledge is the same mistake
 * openchamber removed ("The client used to own this... A session started
 * without a UI got nothing at all"). So todos move here, next to their
 * siblings, and the tool + RPC share this one implementation.
 *
 * Layout mirrors the existing on-disk shape so notes/plans keep working
 * unchanged; todos are a single JSON file per project:
 *
 *   <agentDir>/notes/<cwdHash>/<id>.md
 *   <agentDir>/plans/<cwdHash>/<id>.md
 *   <agentDir>/todos/<cwdHash>.json
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@musepi/pi-utils/dirs";

/** One project's knowledge, as the panel and the tool both want it. */
export interface KnowledgeSnapshot {
	notes: KnowledgeNote[];
	todos: KnowledgeTodo[];
	plans: KnowledgePlan[];
}

export interface KnowledgeNote {
	id: string;
	body: string;
	createdAt: string;
	updatedAt: string;
}

export interface KnowledgeTodo {
	id: string;
	text: string;
	done: boolean;
	createdAt: number;
}

export interface KnowledgePlan {
	id: string;
	title: string;
	createdAt: string;
	/** Markdown body; omitted from `list` (titles are enough there) and
	 *  present on `get`. */
	body?: string;
}

/** Todo text cap (the panel's inline editor never produced longer). */
export const TODO_TEXT_MAX = 240;
export const NOTE_BODY_MAX = 20_000;
export const PLAN_BODY_MAX = 200_000;

/** Stable per-project directory key — the same hash the RPC handlers used, so
 *  existing notes and plans stay where they are. */
export function projectSlug(cwd: string): string {
	return createHash("sha1").update(cwd).digest("hex").slice(0, 16);
}

function notesDir(slug: string): string {
	return path.join(getAgentDir(), "notes", slug);
}

function plansDir(slug: string): string {
	return path.join(getAgentDir(), "plans", slug);
}

function todosFile(slug: string): string {
	return path.join(getAgentDir(), "todos", `${slug}.json`);
}

/** Filename stamp for a new item: sortable, filesystem-safe. */
function stamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/** Ids are filenames: refuse anything that could escape the directory. */
export function isValidKnowledgeId(id: string): boolean {
	return typeof id === "string" && id.length > 0 && id.length <= 120 && !/[^a-zA-Z0-9-]/.test(id);
}

/* ── notes ─────────────────────────────────────────────────────────── */

export async function listNotes(cwd: string): Promise<KnowledgeNote[]> {
	const dir = notesDir(projectSlug(cwd));
	let files: string[] = [];
	try {
		files = (await fs.readdir(dir)).filter(f => f.endsWith(".md"));
	} catch {
		return [];
	}
	const out: KnowledgeNote[] = [];
	for (const f of files.sort()) {
		const id = f.slice(0, -3);
		let createdAt = f.slice(0, 15);
		let updatedAt = createdAt;
		try {
			const st = await fs.stat(path.join(dir, f));
			updatedAt = st.mtime.toISOString().replace(/[:.]/g, "-").slice(0, 19);
			if (createdAt.length < 14) createdAt = st.mtime.toISOString().slice(0, 10);
		} catch {
			// keep the filename date
		}
		try {
			out.push({ id, body: await fs.readFile(path.join(dir, f), "utf8"), createdAt, updatedAt });
		} catch {
			// unreadable file is not a note
		}
	}
	return out.reverse();
}

export async function createNote(cwd: string, body: string): Promise<KnowledgeNote> {
	if (!body.trim()) throw new Error("blank note body");
	if (body.length > NOTE_BODY_MAX) throw new Error(`note body exceeds ${NOTE_BODY_MAX} characters`);
	const dir = notesDir(projectSlug(cwd));
	await fs.mkdir(dir, { recursive: true });
	const base = stamp();
	let id = `${base}-note`;
	// Two notes in the same second would collide; suffix until free.
	for (let n = 2; n < 100; n += 1) {
		try {
			await fs.access(path.join(dir, `${id}.md`));
			id = `${base}-note-${n}`;
		} catch {
			break;
		}
	}
	const file = path.join(dir, `${id}.md`);
	await fs.writeFile(file, body, "utf8");
	const st = await fs.stat(file);
	return {
		id,
		body,
		createdAt: base.slice(0, 15),
		updatedAt: st.mtime.toISOString().replace(/[:.]/g, "-").slice(0, 19),
	};
}

export async function updateNote(cwd: string, id: string, body: string): Promise<void> {
	if (!isValidKnowledgeId(id)) throw new Error("invalid note id");
	if (!body.trim()) throw new Error("blank note body");
	if (body.length > NOTE_BODY_MAX) throw new Error(`note body exceeds ${NOTE_BODY_MAX} characters`);
	await fs.writeFile(path.join(notesDir(projectSlug(cwd)), `${id}.md`), body, "utf8");
}

export async function deleteNote(cwd: string, id: string): Promise<boolean> {
	if (!isValidKnowledgeId(id)) throw new Error("invalid note id");
	try {
		await fs.unlink(path.join(notesDir(projectSlug(cwd)), `${id}.md`));
		return true;
	} catch {
		return false;
	}
}

/* ── todos ─────────────────────────────────────────────────────────── */

/** Todos for one project. A missing file is an empty list, not an error. */
export async function listTodos(cwd: string): Promise<KnowledgeTodo[]> {
	const file = todosFile(projectSlug(cwd));
	try {
		const raw = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
		if (!Array.isArray(raw)) return [];
		return raw
			.filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
			.map(t => ({
				id: String(t.id ?? ""),
				text: String(t.text ?? ""),
				done: t.done === true,
				createdAt: Number.isFinite(Number(t.createdAt)) ? Number(t.createdAt) : Date.now(),
			}))
			.filter(t => t.id !== "" && t.text !== "");
	} catch {
		return [];
	}
}

async function writeTodos(cwd: string, todos: KnowledgeTodo[]): Promise<void> {
	const file = todosFile(projectSlug(cwd));
	await fs.mkdir(path.dirname(file), { recursive: true });
	// Write-then-rename: a crash must not truncate the only copy.
	const tmp = `${file}.tmp-${process.pid}`;
	await fs.writeFile(tmp, JSON.stringify(todos, null, 2), "utf8");
	await fs.rename(tmp, file);
}

export async function createTodo(cwd: string, text: string): Promise<KnowledgeTodo> {
	const trimmed = text.trim();
	if (!trimmed) throw new Error("blank todo text");
	if (trimmed.length > TODO_TEXT_MAX) throw new Error(`todo text exceeds ${TODO_TEXT_MAX} characters`);
	const todos = await listTodos(cwd);
	const todo: KnowledgeTodo = {
		id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
		text: trimmed,
		done: false,
		createdAt: Date.now(),
	};
	todos.push(todo);
	await writeTodos(cwd, todos);
	return todo;
}

/**
 * Update a todo. `text` and `done` are independent: the panel toggles
 * completion without resending the label, and the tool may send only `done`
 * (openchamber's `knowledge.save` allows exactly that).
 */
export async function updateTodo(
	cwd: string,
	id: string,
	patch: { text?: string; done?: boolean },
): Promise<KnowledgeTodo | null> {
	const todos = await listTodos(cwd);
	const idx = todos.findIndex(t => t.id === id);
	if (idx === -1) return null;
	const current = todos[idx]!;
	const next: KnowledgeTodo = { ...current };
	if (patch.text !== undefined) {
		const trimmed = patch.text.trim();
		if (!trimmed) throw new Error("blank todo text");
		if (trimmed.length > TODO_TEXT_MAX) throw new Error(`todo text exceeds ${TODO_TEXT_MAX} characters`);
		next.text = trimmed;
	}
	if (patch.done !== undefined) next.done = patch.done;
	todos[idx] = next;
	await writeTodos(cwd, todos);
	return next;
}

export async function deleteTodo(cwd: string, id: string): Promise<boolean> {
	const todos = await listTodos(cwd);
	const next = todos.filter(t => t.id !== id);
	if (next.length === todos.length) return false;
	await writeTodos(cwd, next);
	return true;
}

/**
 * Replace the whole todo list, preserving ORDER.
 *
 * The panel's list is order-sensitive (a new todo lands before the first
 * completed one; completing moves an item to the end) and that order is part of
 * what the user sees. A per-item create/update/delete API cannot express it
 * without a separate reorder call, so the GUI writes its list wholesale. The
 * tool keeps the per-item functions — the right shape for an agent editing one
 * thing at a time.
 */
export async function replaceTodos(cwd: string, todos: KnowledgeTodo[]): Promise<KnowledgeTodo[]> {
	const clean: KnowledgeTodo[] = [];
	const seen = new Set<string>();
	for (const t of todos) {
		const id = String(t.id ?? "");
		const text = String(t.text ?? "").trim();
		if (!id || !text || seen.has(id)) continue;
		seen.add(id);
		clean.push({
			id,
			text: text.slice(0, TODO_TEXT_MAX),
			done: t.done === true,
			createdAt: Number.isFinite(Number(t.createdAt)) ? Number(t.createdAt) : Date.now(),
		});
	}
	await writeTodos(cwd, clean);
	return clean;
}

/**
 * Adopt todos produced by the GUI's old `localStorage` store.
 *
 * One-shot and idempotent by construction: the caller passes everything it
 * found, ids are preserved, and a todo already present is skipped. The caller
 * deletes its keys only after this resolves, so a failed migration leaves the
 * old data recoverable instead of losing it.
 */
export async function importLegacyTodos(
	cwd: string,
	legacy: Array<{ id?: unknown; text?: unknown; done?: unknown; createdAt?: unknown }>,
): Promise<{ imported: number; skipped: number }> {
	const existing = await listTodos(cwd);
	const seen = new Set(existing.map(t => t.id));
	let imported = 0;
	let skipped = 0;
	for (const raw of legacy) {
		// A legacy row without a usable id is not migrated: the GUI always wrote
		// one (`crypto.randomUUID()`), so a missing id means the entry is
		// corrupt, and inventing an id would import junk the user cannot
		// recognise. Same for a non-string label.
		const id = typeof raw.id === "string" ? raw.id.trim() : "";
		const text = typeof raw.text === "string" ? raw.text.trim() : "";
		if (!id || !text || !isValidKnowledgeId(id) || seen.has(id)) {
			skipped += 1;
			continue;
		}
		existing.push({
			id,
			text: text.slice(0, TODO_TEXT_MAX),
			done: raw.done === true,
			createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : Date.now(),
		});
		seen.add(id);
		imported += 1;
	}
	if (imported > 0) await writeTodos(cwd, existing);
	return { imported, skipped };
}

/* ── plans ─────────────────────────────────────────────────────────── */

export async function listPlans(cwd: string): Promise<KnowledgePlan[]> {
	const dir = plansDir(projectSlug(cwd));
	let files: string[] = [];
	try {
		files = (await fs.readdir(dir)).filter(f => f.endsWith(".md"));
	} catch {
		return [];
	}
	const out: KnowledgePlan[] = [];
	for (const f of files.sort()) {
		const id = f.slice(0, -3);
		let title = id.split("-").slice(1).join("-") || id;
		let createdAt = f.slice(0, 15);
		try {
			const heading = /^#\s+(.+)$/m.exec(await fs.readFile(path.join(dir, f), "utf8"));
			if (heading) title = heading[1]!.trim();
		} catch {
			// keep the fallback title
		}
		try {
			const st = await fs.stat(path.join(dir, f));
			if (createdAt.length < 14) createdAt = st.mtime.toISOString().slice(0, 10);
		} catch {
			// keep the filename date
		}
		out.push({ id, title, createdAt });
	}
	return out.reverse();
}

export async function getPlan(cwd: string, id: string): Promise<KnowledgePlan | null> {
	if (!isValidKnowledgeId(id)) throw new Error("invalid plan id");
	try {
		const body = await fs.readFile(path.join(plansDir(projectSlug(cwd)), `${id}.md`), "utf8");
		const heading = /^#\s+(.+)$/m.exec(body);
		return { id, title: heading ? heading[1]!.trim() : id, createdAt: id.slice(0, 15), body };
	} catch {
		return null;
	}
}

/**
 * Create a plan from a markdown body, or replace one by id.
 *
 * The body IS the document and conventionally opens with a `# title` line
 * (the list derives the title from it, so no separate title argument can
 * disagree with the file).
 */
export async function savePlan(cwd: string, body: string, id?: string): Promise<KnowledgePlan> {
	if (!body.trim()) throw new Error("blank plan body");
	if (body.length > PLAN_BODY_MAX) throw new Error(`plan body exceeds ${PLAN_BODY_MAX} characters`);
	const dir = plansDir(projectSlug(cwd));
	await fs.mkdir(dir, { recursive: true });
	let planId = id;
	if (planId !== undefined && !isValidKnowledgeId(planId)) throw new Error("invalid plan id");
	if (planId === undefined) {
		const heading = /^#\s+(.+)$/m.exec(body);
		const slug =
			(heading?.[1] ?? "plan")
				.toLowerCase()
				.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
				.replace(/^-+|-+$/g, "")
				.slice(0, 40) || "plan";
		planId = `${stamp()}-${slug}`;
	}
	await fs.writeFile(path.join(dir, `${planId}.md`), body, "utf8");
	const heading = /^#\s+(.+)$/m.exec(body);
	return { id: planId, title: heading ? heading[1]!.trim() : planId, createdAt: planId.slice(0, 15), body };
}

export async function deletePlan(cwd: string, id: string): Promise<boolean> {
	if (!isValidKnowledgeId(id)) throw new Error("invalid plan id");
	try {
		await fs.unlink(path.join(plansDir(projectSlug(cwd)), `${id}.md`));
		return true;
	} catch {
		return false;
	}
}

/* ── snapshot ──────────────────────────────────────────────────────── */

/** Everything at once — the panel's initial load and the tool's `list`. */
export async function readKnowledge(cwd: string): Promise<KnowledgeSnapshot> {
	const [notes, todos, plans] = await Promise.all([listNotes(cwd), listTodos(cwd), listPlans(cwd)]);
	return { notes, todos, plans };
}
