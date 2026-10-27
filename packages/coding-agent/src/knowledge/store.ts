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
 * The panel UI needing a browser to own project knowledge means a session
 * started without a UI gets nothing at all. So todos live here, next to their
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
	/** Absolute path of the plan's markdown file. A plan IS a markdown file, so
	 *  the agent reads or edits it with its own file tools rather than pulling
	 *  the whole document through a tool result. */
	path?: string;
	/** `## Steps` checklist progress, when the plan has one. */
	steps?: { done: number; total: number };
}

/** Todo text cap (the panel's inline editor never produced longer). */
export const TODO_TEXT_MAX = 240;
export const NOTE_BODY_MAX = 20_000;
export const PLAN_BODY_MAX = 200_000;

/**
 * Raised when a caller passes `expected` and the stored text no longer matches.
 *
 * A silent last-write-wins replace loses whatever the other writer (usually the
 * user, in the panel) typed in between; comparing against the text the caller
 * read turns that into a recoverable error.
 */
export class KnowledgeConflictError extends Error {
	constructor(kind: string, id: string) {
		super(`${kind} ${id} changed since it was read; list it again before replacing`);
		this.name = "KnowledgeConflictError";
	}
}

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

/**
 * Resolve which project a knowledge call addresses.
 *
 * Two ways in, mirroring how a session names a project:
 *  - `directory` — an absolute workspace path (what the panel and the calling
 *    session pass);
 *  - `projectId` — the slug the store keys on, so a caller that listed one
 *    project can address it again without knowing its filesystem path.
 *
 * Supplying both is refused rather than silently preferring one: they can
 * disagree (a projectId from a different checkout), and picking either would
 * write into a project the caller did not mean.
 */
export function resolveProject(input: { projectId?: unknown; directory?: unknown }, fallbackDirectory: string): string {
	const projectId = typeof input.projectId === "string" ? input.projectId.trim() : "";
	const directory = typeof input.directory === "string" ? input.directory.trim() : "";
	if (projectId !== "" && directory !== "") {
		throw new Error("Provide only one of projectId or directory");
	}
	// The slug IS the identity — everything below keys on it, so both spellings
	// converge here.
	if (projectId !== "") {
		if (!/^[a-f0-9]{16}$/.test(projectId)) throw new Error("invalid projectId");
		return projectId;
	}
	const target = directory !== "" ? directory : fallbackDirectory;
	if (!path.isAbsolute(target) && !path.win32.isAbsolute(target)) {
		throw new Error("An absolute project directory is required");
	}
	return projectSlug(target);
}

/** The absolute directory a slug's plans live in (handed to the agent). */
export function plansDirectory(slug: string): string {
	return plansDir(slug);
}

/**
 * `## Steps` checklist progress (`- [ ] step` lines under a `## Steps` heading).
 *
 * Returns undefined when the plan has no such section: a made-up 0/0 would read
 * as "a plan with no progress" when the truth is "this plan has no checklist".
 */
export function planSteps(body: string): { done: number; total: number } | undefined {
	const heading = /^##\s+Steps\s*$/m.exec(body);
	if (!heading) return undefined;
	const rest = body.slice(heading.index + heading[0].length);
	const nextHeading = /^##\s+/m.exec(rest);
	const section = nextHeading ? rest.slice(0, nextHeading.index) : rest;
	let done = 0;
	let total = 0;
	for (const line of section.split(/\r?\n/)) {
		const box = /^\s*[-*]\s+\[([ xX])\]\s+\S/.exec(line);
		if (!box) continue;
		total += 1;
		if (box[1] !== " ") done += 1;
	}
	return total > 0 ? { done, total } : undefined;
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

export async function listNotes(slug: string): Promise<KnowledgeNote[]> {
	const dir = notesDir(slug);
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

export async function createNote(slug: string, body: string): Promise<KnowledgeNote> {
	if (!body.trim()) throw new Error("blank note body");
	if (body.length > NOTE_BODY_MAX) throw new Error(`note body exceeds ${NOTE_BODY_MAX} characters`);
	const dir = notesDir(slug);
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

export async function getNote(slug: string, id: string): Promise<KnowledgeNote | null> {
	if (!isValidKnowledgeId(id)) return null;
	try {
		const body = await fs.readFile(path.join(notesDir(slug), `${id}.md`), "utf8");
		return { id, body, createdAt: id.slice(0, 15), updatedAt: id.slice(0, 15) };
	} catch {
		return null;
	}
}

export async function updateNote(slug: string, id: string, body: string, expected?: string): Promise<void> {
	if (!isValidKnowledgeId(id)) throw new Error("invalid note id");
	if (!body.trim()) throw new Error("blank note body");
	if (body.length > NOTE_BODY_MAX) throw new Error(`note body exceeds ${NOTE_BODY_MAX} characters`);
	const file = path.join(notesDir(slug), `${id}.md`);
	// `expected` is the text the caller read: a concurrent edit (usually the user
	// typing in the panel) must surface as a conflict instead of being lost.
	if (expected !== undefined) {
		const current = await fs.readFile(file, "utf8").catch(() => null);
		if (current === null) throw new Error(`no note with id ${id}`);
		if (current !== expected) throw new KnowledgeConflictError("note", id);
	}
	await fs.writeFile(file, body, "utf8");
}

export async function deleteNote(slug: string, id: string): Promise<boolean> {
	if (!isValidKnowledgeId(id)) throw new Error("invalid note id");
	try {
		await fs.unlink(path.join(notesDir(slug), `${id}.md`));
		return true;
	} catch {
		return false;
	}
}

/* ── todos ─────────────────────────────────────────────────────────── */

/** Todos for one project. A missing file is an empty list, not an error. */
export async function listTodos(slug: string): Promise<KnowledgeTodo[]> {
	const file = todosFile(slug);
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

async function writeTodos(slug: string, todos: KnowledgeTodo[]): Promise<void> {
	const file = todosFile(slug);
	await fs.mkdir(path.dirname(file), { recursive: true });
	// Write-then-rename: a crash must not truncate the only copy.
	const tmp = `${file}.tmp-${process.pid}`;
	await fs.writeFile(tmp, JSON.stringify(todos, null, 2), "utf8");
	await fs.rename(tmp, file);
}

export async function createTodo(slug: string, text: string): Promise<KnowledgeTodo> {
	const trimmed = text.trim();
	if (!trimmed) throw new Error("blank todo text");
	if (trimmed.length > TODO_TEXT_MAX) throw new Error(`todo text exceeds ${TODO_TEXT_MAX} characters`);
	const todos = await listTodos(slug);
	const todo: KnowledgeTodo = {
		id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
		text: trimmed,
		done: false,
		createdAt: Date.now(),
	};
	todos.push(todo);
	await writeTodos(slug, todos);
	return todo;
}

/**
 * Update a todo. `text` and `done` are independent: the panel toggles
 * completion without resending the label, and the tool may send only `done`.
 */
export async function updateTodo(
	slug: string,
	id: string,
	patch: { text?: string; done?: boolean },
): Promise<KnowledgeTodo | null> {
	const todos = await listTodos(slug);
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
	await writeTodos(slug, todos);
	return next;
}

export async function deleteTodo(slug: string, id: string): Promise<boolean> {
	const todos = await listTodos(slug);
	const next = todos.filter(t => t.id !== id);
	if (next.length === todos.length) return false;
	await writeTodos(slug, next);
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
export async function replaceTodos(slug: string, todos: KnowledgeTodo[]): Promise<KnowledgeTodo[]> {
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
	await writeTodos(slug, clean);
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
	slug: string,
	legacy: Array<{ id?: unknown; text?: unknown; done?: unknown; createdAt?: unknown }>,
): Promise<{ imported: number; skipped: number }> {
	const existing = await listTodos(slug);
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
	if (imported > 0) await writeTodos(slug, existing);
	return { imported, skipped };
}

/* ── plans ─────────────────────────────────────────────────────────── */

export async function listPlans(slug: string): Promise<KnowledgePlan[]> {
	const dir = plansDir(slug);
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
		let steps: { done: number; total: number } | undefined;
		try {
			const body = await fs.readFile(path.join(dir, f), "utf8");
			const heading = /^#\s+(.+)$/m.exec(body);
			if (heading) title = heading[1]!.trim();
			steps = planSteps(body);
		} catch {
			// keep the fallback title
		}
		try {
			const st = await fs.stat(path.join(dir, f));
			if (createdAt.length < 14) createdAt = st.mtime.toISOString().slice(0, 10);
		} catch {
			// keep the filename date
		}
		// The path is what lets the model use its own file tools on the plan.
		out.push({ id, title, createdAt, path: path.join(dir, f), steps });
	}
	return out.reverse();
}

export async function getPlan(slug: string, id: string): Promise<KnowledgePlan | null> {
	if (!isValidKnowledgeId(id)) throw new Error("invalid plan id");
	const file = path.join(plansDir(slug), `${id}.md`);
	try {
		const body = await fs.readFile(file, "utf8");
		const heading = /^#\s+(.+)$/m.exec(body);
		return {
			id,
			title: heading ? heading[1]!.trim() : id,
			createdAt: id.slice(0, 15),
			body,
			path: file,
			steps: planSteps(body),
		};
	} catch {
		return null;
	}
}

/**
 * Create a plan from a markdown body, or replace one by id.
 *
 * The body IS the document and conventionally opens with a `# title` line (the
 * list derives the title from it, so no separate title argument can disagree
 * with the file). `expected` guards a replacement — see {@link updateNote}.
 */
export async function savePlan(slug: string, body: string, id?: string, expected?: string): Promise<KnowledgePlan> {
	if (!body.trim()) throw new Error("blank plan body");
	if (body.length > PLAN_BODY_MAX) throw new Error(`plan body exceeds ${PLAN_BODY_MAX} characters`);
	const dir = plansDir(slug);
	await fs.mkdir(dir, { recursive: true });
	let planId = id;
	if (planId !== undefined && !isValidKnowledgeId(planId)) throw new Error("invalid plan id");
	if (expected !== undefined) {
		// A create has nothing to compare against; refusing beats letting the
		// caller believe a conflict check ran.
		if (planId === undefined) throw new Error("expected requires an id: pass the id of the plan being replaced");
		const current = await fs.readFile(path.join(dir, `${planId}.md`), "utf8").catch(() => null);
		if (current === null) throw new Error(`no plan with id ${planId}`);
		if (current !== expected) throw new KnowledgeConflictError("plan", planId);
	}
	if (planId === undefined) {
		const heading = /^#\s+(.+)$/m.exec(body);
		// The id's readable tail comes from the title; the timestamp keeps it
		// unique and sortable.
		const titleSlug =
			(heading?.[1] ?? "plan")
				.toLowerCase()
				.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
				.replace(/^-+|-+$/g, "")
				.slice(0, 40) || "plan";
		planId = `${stamp()}-${titleSlug}`;
	}
	await fs.writeFile(path.join(dir, `${planId}.md`), body, "utf8");
	const heading = /^#\s+(.+)$/m.exec(body);
	return { id: planId, title: heading ? heading[1]!.trim() : planId, createdAt: planId.slice(0, 15), body };
}

export async function deletePlan(slug: string, id: string): Promise<boolean> {
	if (!isValidKnowledgeId(id)) throw new Error("invalid plan id");
	try {
		await fs.unlink(path.join(plansDir(slug), `${id}.md`));
		return true;
	} catch {
		return false;
	}
}

/* ── snapshot ──────────────────────────────────────────────────────── */

/** Everything at once — the panel's initial load and the tool's `list`. */
export async function readKnowledge(slug: string): Promise<KnowledgeSnapshot> {
	const [notes, todos, plans] = await Promise.all([listNotes(slug), listTodos(slug), listPlans(slug)]);
	return { notes, todos, plans };
}
