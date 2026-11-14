/**
 * KnowledgeService — the right-panel project knowledge surface.
 *
 * Seam:
 * - Input: `notes.*`, `plans.*`, `todos.*` routes and the session cwd (the
 *   GUI passes its project cwd; the daemon cwd is only the fallback).
 * - Output: note/plan documents and todo rows. Every write lands under the
 *   agent dir keyed by a stable cwd hash — the user's project is never touched.
 * - Lifecycle: stateless. The note and todo stores are files under the agent
 *   dir; plans likewise, one markdown file per plan.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@musepi/pi-utils";
import {
	createTodo,
	deleteTodo,
	importLegacyTodos,
	type KnowledgeTodo,
	listTodos,
	projectSlug,
	replaceTodos,
	updateTodo,
} from "../../knowledge/store";
import type { DaemonSessionHost } from "../session-host";
import type { DaemonService } from "./types";

/** Stable per-project notes filename (cwd hash). Existing note directories
 *  are keyed by this exact digest — changing it orphans them. */
async function hashProjectPath(cwd: string): Promise<string> {
	return createHash("sha1").update(cwd).digest("hex").slice(0, 16);
}

export class KnowledgeService implements DaemonService {
	readonly key = "knowledge";
	readonly routes = {
		"notes.list": "notes",
		"notes.create": "noteCreate",
		"notes.update": "noteUpdate",
		"notes.delete": "noteDelete",
		"plans.list": "plans",
		"plans.get": "plan",
		"plans.save": "planSave",
		"plans.delete": "planDelete",
		"todos.list": "todos",
		"todos.create": "todoCreate",
		"todos.update": "todoUpdate",
		"todos.delete": "todoDelete",
		"todos.replace": "todoReplace",
		"todos.importLegacy": "todoImportLegacy",
	} as const;

	constructor(private readonly host: Pick<DaemonSessionHost, "cwd">) {}

	async notes(params: unknown): Promise<unknown> {
		// Project notes (right-panel 项目知识):
		// one markdown file per note under agentDir/notes/<cwdHash>/,
		// never touching the user's project. The legacy single-blob
		// note (<slug>.md) migrates into the per-project dir on first
		// list, then the old file is removed.
		const p = (params ?? {}) as { cwd?: string };
		const cwd = p.cwd?.trim() || this.host.cwd();
		const slug = await hashProjectPath(cwd);
		const dir = path.join(getAgentDir(), "notes", slug);
		// Legacy migration: old single-note file → first note.
		const legacy = path.join(getAgentDir(), "notes", `${slug}.md`);
		try {
			const legacyText = await fs.promises.readFile(legacy, "utf8");
			if (legacyText.trim()) {
				await fs.promises.mkdir(dir, { recursive: true });
				const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
				await fs.promises.writeFile(path.join(dir, `${stamp}-note.md`), legacyText, "utf8");
			}
			await fs.promises.rm(legacy, { force: true });
		} catch {
			// no legacy file
		}
		let files: string[] = [];
		try {
			files = (await fs.promises.readdir(dir)).filter(f => f.endsWith(".md"));
		} catch {
			// no notes yet
		}
		const notes = [];
		for (const f of files.sort()) {
			const id = f.slice(0, -3);
			let createdAt = f.slice(0, 15);
			let updatedAt = createdAt;
			try {
				const st = await fs.promises.stat(path.join(dir, f));
				updatedAt = st.mtime.toISOString().replace(/[:.]/g, "-").slice(0, 19);
				if (createdAt.length < 14) createdAt = st.mtime.toISOString().slice(0, 10);
			} catch {
				// keep filename date
			}
			const body = await fs.promises.readFile(path.join(dir, f), "utf8");
			notes.push({ id, body, createdAt, updatedAt });
		}
		return { notes: notes.reverse() };
	}

	async noteCreate(params: unknown): Promise<unknown> {
		// Create one note. A blank body is a rejected write, not a
		// delete.
		const p = (params ?? {}) as { cwd?: string; body?: string };
		const cwd = p.cwd?.trim() || this.host.cwd();
		const body = (p.body ?? "").trim();
		if (!body) return { error: "blank note body" };
		const slug = await hashProjectPath(cwd);
		const dir = path.join(getAgentDir(), "notes", slug);
		await fs.promises.mkdir(dir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const id = `${stamp}-note`;
		await fs.promises.writeFile(path.join(dir, `${id}.md`), body, "utf8");
		return { id, createdAt: stamp };
	}

	async noteUpdate(params: unknown): Promise<unknown> {
		const p = (params ?? {}) as { cwd?: string; id?: string; body?: string };
		const cwd = p.cwd?.trim() || this.host.cwd();
		if (!p.id || /[^a-zA-Z0-9-]/.test(p.id)) return { error: "invalid note id" };
		const body = p.body ?? "";
		if (!body.trim()) return { error: "blank note body" };
		const slug = await hashProjectPath(cwd);
		const file = path.join(getAgentDir(), "notes", slug, `${p.id}.md`);
		try {
			await fs.promises.writeFile(file, body, "utf8");
			return { ok: true };
		} catch {
			return { error: "note not found" };
		}
	}

	async noteDelete(params: unknown): Promise<unknown> {
		const p = (params ?? {}) as { cwd?: string; id?: string };
		const cwd = p.cwd?.trim() || this.host.cwd();
		if (!p.id || /[^a-zA-Z0-9-]/.test(p.id)) return { error: "invalid note id" };
		const slug = await hashProjectPath(cwd);
		try {
			await fs.promises.unlink(path.join(getAgentDir(), "notes", slug, `${p.id}.md`));
			return { ok: true };
		} catch {
			return { error: "note not found" };
		}
	}

	async plans(params: unknown): Promise<unknown> {
		// Saved plan files (right-panel 计划): one
		// markdown file per plan under agentDir/plans/<cwdHash>/, never
		// touching the user's project. Title = first `# heading` or the
		// slug; createdAt = filename `<ts>-<slug>.md` or file mtime.
		const p = (params ?? {}) as { cwd?: string };
		const cwd = p.cwd?.trim() || this.host.cwd();
		const slug = await hashProjectPath(cwd);
		const dir = path.join(getAgentDir(), "plans", slug);
		let files: string[] = [];
		try {
			files = (await fs.promises.readdir(dir)).filter(f => f.endsWith(".md"));
		} catch {
			// no plans yet
		}
		const plans = [];
		for (const f of files.sort()) {
			const id = f.slice(0, -3);
			let title = id.split("-").slice(1).join("-") || id;
			let createdAt = f.slice(0, 15);
			try {
				const head = await fs.promises.readFile(path.join(dir, f), "utf8");
				const heading = /^#\s+(.+)$/m.exec(head);
				if (heading) title = heading[1]!.trim();
			} catch {
				// keep fallback title
			}
			try {
				const st = await fs.promises.stat(path.join(dir, f));
				if (createdAt.length < 14) createdAt = st.mtime.toISOString().slice(0, 10);
			} catch {
				// keep filename date
			}
			plans.push({ id, title, createdAt });
		}
		return { plans: plans.reverse() };
	}

	async plan(params: unknown): Promise<unknown> {
		const p = (params ?? {}) as { cwd?: string; id?: string };
		const cwd = p.cwd?.trim() || this.host.cwd();
		const slug = await hashProjectPath(cwd);
		if (!p.id || /[^a-zA-Z0-9-]/.test(p.id)) return { error: "invalid plan id" };
		try {
			const body = await fs.promises.readFile(path.join(getAgentDir(), "plans", slug, `${p.id}.md`), "utf8");
			return { title: (/^#\s+(.+)$/m.exec(body)?.[1] ?? p.id).trim(), body };
		} catch {
			return { error: "plan not found" };
		}
	}

	async planSave(params: unknown): Promise<unknown> {
		// Save (or overwrite, when id is given) a plan file.
		const p = (params ?? {}) as { cwd?: string; id?: string; title?: string; body?: string };
		const cwd = p.cwd?.trim() || this.host.cwd();
		const slug = await hashProjectPath(cwd);
		const dir = path.join(getAgentDir(), "plans", slug);
		await fs.promises.mkdir(dir, { recursive: true });
		const title = (p.title ?? "").trim() || "untitled plan";
		const body = `${`# ${title}\n\n${p.body ?? ""}`.trim()}\n`;
		const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const id =
			p.id && !/[^a-zA-Z0-9-]/.test(p.id)
				? p.id
				: `${stamp}-${
						title
							.toLowerCase()
							.replace(/[^a-z0-9]+/g, "-")
							.replace(/^-+|-+$/g, "")
							.slice(0, 48) || "plan"
					}`;
		await fs.promises.writeFile(path.join(dir, `${id}.md`), body, "utf8");
		return { id, title, createdAt: stamp };
	}

	async planDelete(params: unknown): Promise<unknown> {
		const p = (params ?? {}) as { cwd?: string; id?: string };
		const cwd = p.cwd?.trim() || this.host.cwd();
		const slug = await hashProjectPath(cwd);
		if (!p.id || /[^a-zA-Z0-9-]/.test(p.id)) return { error: "invalid plan id" };
		try {
			await fs.promises.unlink(path.join(getAgentDir(), "plans", slug, `${p.id}.md`));
			return { ok: true };
		} catch {
			return { error: "plan not found" };
		}
	}

	async todos(params: unknown): Promise<unknown> {
		// Project todos (right-panel 项目知识 → 待办). They used to live in
		// the GUI's localStorage, which meant the AGENT could not read
		// them at all and a session with no window (a scheduled task, a
		// dispatched subagent) had nothing to read. The `knowledge` tool
		// and this RPC share one store.
		const p = (params ?? {}) as { cwd?: string };
		const cwd = p.cwd?.trim() || this.host.cwd();
		return { todos: await listTodos(projectSlug(cwd)) };
	}

	async todoCreate(params: unknown): Promise<unknown> {
		const p = (params ?? {}) as { cwd?: string; text?: string };
		const cwd = p.cwd?.trim() || this.host.cwd();
		try {
			return { ok: true, todo: await createTodo(projectSlug(cwd), p.text ?? "") };
		} catch (err) {
			return { error: err instanceof Error ? err.message : String(err) };
		}
	}

	async todoUpdate(params: unknown): Promise<unknown> {
		const p = (params ?? {}) as { cwd?: string; id?: string; text?: string; done?: boolean };
		const cwd = p.cwd?.trim() || this.host.cwd();
		if (!p.id) return { error: "invalid todo id" };
		try {
			const todo = await updateTodo(projectSlug(cwd), p.id, { text: p.text, done: p.done });
			return todo ? { ok: true, todo } : { error: "todo not found" };
		} catch (err) {
			return { error: err instanceof Error ? err.message : String(err) };
		}
	}

	async todoDelete(params: unknown): Promise<unknown> {
		const p = (params ?? {}) as { cwd?: string; id?: string };
		const cwd = p.cwd?.trim() || this.host.cwd();
		if (!p.id) return { error: "invalid todo id" };
		return (await deleteTodo(projectSlug(cwd), p.id)) ? { ok: true } : { error: "todo not found" };
	}

	async todoReplace(params: unknown): Promise<unknown> {
		// The panel's list is order-sensitive (new items land before the
		// first completed one, completing moves an item to the end), so it
		// writes the whole list rather than per-item deltas.
		const p = (params ?? {}) as { cwd?: string; todos?: Array<Partial<KnowledgeTodo>> };
		const cwd = p.cwd?.trim() || this.host.cwd();
		const todos = (p.todos ?? []).map(t => ({
			id: String(t.id ?? ""),
			text: String(t.text ?? ""),
			done: t.done === true,
			createdAt: Number.isFinite(Number(t.createdAt)) ? Number(t.createdAt) : Date.now(),
		}));
		try {
			return { ok: true, todos: await replaceTodos(projectSlug(cwd), todos) };
		} catch (err) {
			return { error: err instanceof Error ? err.message : String(err) };
		}
	}

	async todoImportLegacy(params: unknown): Promise<unknown> {
		// One-shot adoption of the GUI's old localStorage todos. Kept as a
		// separate RPC (not folded into create) so the migration is
		// idempotent and the panel only drops its keys after it succeeds —
		// a failed migration must leave the old data recoverable.
		const p = (params ?? {}) as {
			cwd?: string;
			todos?: Array<{ id?: unknown; text?: unknown; done?: unknown; createdAt?: unknown }>;
		};
		const cwd = p.cwd?.trim() || this.host.cwd();
		try {
			return { ok: true, ...(await importLegacyTodos(projectSlug(cwd), p.todos ?? [])) };
		} catch (err) {
			return { error: err instanceof Error ? err.message : String(err) };
		}
	}
}
