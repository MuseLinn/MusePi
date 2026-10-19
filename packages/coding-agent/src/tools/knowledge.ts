/**
 * `knowledge` tool — read and write the project's knowledge: notes, todos and
 * plans. One tool with a `kind` discriminator, mirroring the panel's three
 * sections, because they are one concept ("things this project remembers") and
 * a model that has to pick between three separate tools drops one of them.
 *
 * Before this tool the agent had no access at all: notes and plans were
 * daemon-only RPC, and todos lived in the GUI's localStorage — invisible to a
 * session with no window (scheduled tasks, dispatched subagents). See
 * `../knowledge/store.ts` for the storage contract.
 */
import { type } from "@musepi/musepi-type";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@musepi/pi-agent-core";
import type { ToolExample } from "@musepi/pi-ai";
import {
	createNote,
	createTodo,
	deleteNote,
	deletePlan,
	deleteTodo,
	getPlan,
	isValidKnowledgeId,
	listNotes,
	listPlans,
	listTodos,
	projectSlug,
	resolveProject,
	savePlan,
	updateNote,
	updateTodo,
} from "../knowledge/store";
import knowledgeDescription from "../prompts/tools/knowledge.md" with { type: "text" };
import type { ToolSession } from "../sdk";

const KnowledgeKind = type('"note" | "todo" | "plan"').describe("which kind of knowledge");

const knowledgeSchema = type({
	action: type('"list" | "save" | "delete" | "show"').describe("operation to apply"),
	"kind?": KnowledgeKind,
	"id?": type("string").describe("item id (required for delete/show and for replacing a note or plan)"),
	"body?": type("string").describe("note text, or the whole markdown document for a plan (starts with a # title)"),
	"text?": type("string").describe("todo text (save a todo)"),
	"done?": type("boolean").describe("todo completion state"),
	// Project addressing. `directory` is an absolute workspace path;
	// `projectId` is the slug `list` reports. One or the other; both is
	// refused because they can disagree.
	"directory?": type("string").describe(
		"absolute path of the project to address (defaults to this session's workspace)",
	),
	"projectId?": type("string").describe("project id as reported by list (alternative to directory)"),
	// Optimistic concurrency: the exact text previously read, so a concurrent
	// edit fails instead of being overwritten.
	"expected?": type("string").describe(
		"the note or plan text you last read; required to safely replace a long-lived document",
	),
});
type KnowledgeParams = typeof knowledgeSchema.infer;

/** What the GUI renders for a knowledge tool call. */
export interface KnowledgeToolDetails {
	action: string;
	kind?: "note" | "todo" | "plan";
	/** Project the call addressed. */
	projectId?: string;
	/** Item the call created or changed, when there is exactly one. */
	id?: string;
	/** Todo state after the call (the panel's checkbox follows it). */
	todo?: { id: string; text: string; done: boolean };
	/** Set by `show`: the plan the panel should open in front of the user. */
	showPlan?: { id: string; title: string; directory: string };
}

function describeItem(item: { id: string; title?: string; text?: string; done?: boolean; body?: string }): string {
	if (item.text !== undefined) return `${item.id} [${item.done ? "x" : " "}] ${item.text}`;
	if (item.body !== undefined) {
		const preview = item.body.replace(/\s+/g, " ").trim().slice(0, 80);
		return `${item.id} "${item.title ?? ""}" — ${preview}`;
	}
	return `${item.id} "${item.title ?? ""}"`;
}

export class KnowledgeTool implements AgentTool<typeof knowledgeSchema, KnowledgeToolDetails> {
	readonly name = "knowledge";
	readonly label = "Knowledge";
	readonly strict = true;
	readonly approval = "read" as const;
	readonly description = knowledgeDescription;
	readonly parameters = knowledgeSchema;
	readonly examples: readonly ToolExample<KnowledgeParams>[] = [
		{ caption: "List the project's notes, todos and plans", call: { action: "list" } },
		{ caption: "Add a todo", call: { action: "save", kind: "todo", text: "Ship the release notes" } },
		{ caption: "Tick a todo", call: { action: "save", kind: "todo", id: "t1abc", done: true } },
		{ caption: "Save a note", call: { action: "save", kind: "note", body: "The daemon owns sessions." } },
		{
			caption: "Save a plan",
			call: { action: "save", kind: "plan", body: "# Release plan\n\n1. freeze\n2. tag" },
		},
	];

	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	async execute(
		_toolCallId: string,
		params: KnowledgeParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<KnowledgeToolDetails>,
	): Promise<AgentToolResult<KnowledgeToolDetails>> {
		const action = params.action;
		const kind = params.kind;
		const id = params.id;
		// Which project this call addresses. `directory` (absolute path) or
		// `projectId` (the slug `list` reported) — one or the other, defaulting
		// to the calling session's workspace. The slug is the identity everything
		// below keys on.
		const projectId = resolveProject(params, this.#session.cwd);
		const directory = params.directory?.trim()
			? params.directory.trim()
			: projectId === projectSlug(this.#session.cwd)
				? this.#session.cwd
				: // Addressing another project by id alone: its files are keyed by the
					// slug, so no filesystem path is needed to read or write them.
					this.#session.cwd;
		const cwd = directory;

		if (action === "list") {
			// One answer for the whole project: listing per kind would cost three
			// round-trips before the agent knows what exists, and the panel shows
			// all three together anyway.
			const [notes, todos, plans] = await Promise.all([
				listNotes(projectId),
				listTodos(projectId),
				listPlans(projectId),
			]);
			const lines: string[] = [];
			lines.push(`project ${projectId}`);
			lines.push(`## notes (${notes.length})`);
			for (const n of notes) lines.push(`- ${describeItem({ id: n.id, body: n.body })}`);
			lines.push(`## todos (${todos.length})`);
			for (const todo of todos) lines.push(`- ${describeItem(todo)}`);
			lines.push(`## plans (${plans.length})`);
			// Plans report their PATH, not their text: a plan is a markdown file,
			// so reading or patching one is the agent's own file tools' job (and a
			// long document never lands in a tool result).
			for (const p of plans) {
				const steps = p.steps ? ` (${p.steps.done}/${p.steps.total} steps)` : "";
				lines.push(`- ${p.id} "${p.title}"${steps} — ${p.path ?? p.id}`);
			}
			return { content: [{ type: "text", text: lines.join("\n") }], details: { action, projectId } };
		}

		if (action === "show") {
			if (kind !== "plan") throw new Error("show requires kind=plan");
			if (!id) throw new Error("show requires id");
			const plan = await getPlan(projectId, id);
			if (!plan) throw new Error(`no plan with id ${id}`);
			// `show` puts the plan in FRONT OF THE USER, where they can read it —
			// the details carry what the panel needs to open it. The text is also
			// returned so a caller without a window still gets the content.
			return {
				content: [{ type: "text", text: plan.body ?? "" }],
				details: {
					action,
					kind,
					id: plan.id,
					projectId,
					showPlan: { id: plan.id, title: plan.title, directory },
				},
			};
		}

		if (action === "delete") {
			if (!kind) throw new Error("delete requires kind");
			if (!id) throw new Error("delete requires id");
			if (!isValidKnowledgeId(id)) throw new Error("invalid id");
			const removed =
				kind === "note"
					? await deleteNote(projectId, id)
					: kind === "todo"
						? await deleteTodo(projectId, id)
						: await deletePlan(projectId, id);
			if (!removed) throw new Error(`no ${kind} with id ${id}`);
			return {
				content: [{ type: "text", text: `deleted ${kind} ${id}` }],
				details: { action, kind, id, projectId },
			};
		}

		// save
		if (!kind) throw new Error("save requires kind");
		const expected = params.expected;
		// `expected` compares a replacement against text the caller read. A create
		// has nothing to compare against, and silently ignoring it would let the
		// agent believe a conflict check ran.
		if (expected !== undefined) {
			if (id === undefined)
				throw new Error("expected requires an id: pass the id you are replacing, or leave expected out to create");
			if (kind === "todo")
				throw new Error("expected applies to notes and plans; a todo save changes only the fields it names");
		}

		if (kind === "note") {
			const body = params.body ?? "";
			if (id !== undefined) {
				await updateNote(projectId, id, body, expected);
				return {
					content: [{ type: "text", text: `updated note ${id}` }],
					details: { action, kind, id, projectId },
				};
			}
			const note = await createNote(projectId, body);
			return {
				content: [{ type: "text", text: `created note ${note.id}` }],
				details: { action, kind, id: note.id, projectId },
			};
		}

		if (kind === "todo") {
			// Send `done` alone to tick it — the panel does the same, and requiring
			// the label again would make the model retype it (and drift).
			if (id !== undefined) {
				const updated = await updateTodo(projectId, id, { text: params.text, done: params.done });
				if (!updated) throw new Error(`no todo with id ${id}`);
				return {
					content: [
						{ type: "text", text: `updated todo ${updated.id} [${updated.done ? "x" : " "}] ${updated.text}` },
					],
					details: {
						action,
						kind,
						id: updated.id,
						projectId,
						todo: { id: updated.id, text: updated.text, done: updated.done },
					},
				};
			}
			if (!params.text) throw new Error("save a todo requires text");
			const todo = await createTodo(projectId, params.text);
			return {
				content: [{ type: "text", text: `created todo ${todo.id}: ${todo.text}` }],
				details: { action, kind, id: todo.id, projectId, todo: { id: todo.id, text: todo.text, done: todo.done } },
			};
		}

		// plan — the body IS the document; its `# title` line is the title.
		const body = params.body ?? "";
		// A plan conventionally opens with `# title`; refusing early is clearer
		// than storing a document whose title the list has to invent.
		if (!/^\s*#\s+\S/.test(body)) throw new Error("A plan starts with a # title line");
		const plan = await savePlan(projectId, body, id, expected);
		// The path and the steps counters are what the model needs to keep
		// working on the document with its own file tools.
		const steps = plan.steps ? ` (${plan.steps.done}/${plan.steps.total} steps)` : "";
		return {
			content: [
				{
					type: "text",
					text: `${id ? "updated" : "created"} plan ${plan.id} "${plan.title}"${steps} — ${plan.path ?? plan.id}`,
				},
			],
			details: { action, kind: "plan", id: plan.id, projectId },
		};
	}
}
