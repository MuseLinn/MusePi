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
});
type KnowledgeParams = typeof knowledgeSchema.infer;

/** What the GUI renders for a knowledge tool call. */
export interface KnowledgeToolDetails {
	action: string;
	kind?: "note" | "todo" | "plan";
	/** Item the call created or changed, when there is exactly one. */
	id?: string;
	/** Todo state after the call (the panel's checkbox follows it). */
	todo?: { id: string; text: string; done: boolean };
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
		const cwd = this.#session.cwd;
		const action = params.action;
		const kind = params.kind;
		const id = params.id;

		if (action === "list") {
			// One answer for the whole project: listing per kind would cost three
			// round-trips before the agent knows what exists, and the panel shows
			// all three together anyway.
			const [notes, todos, plans] = await Promise.all([listNotes(cwd), listTodos(cwd), listPlans(cwd)]);
			const lines: string[] = [];
			lines.push(`## notes (${notes.length})`);
			for (const n of notes) lines.push(`- ${describeItem({ id: n.id, body: n.body })}`);
			lines.push(`## todos (${todos.length})`);
			for (const todo of todos) lines.push(`- ${describeItem(todo)}`);
			lines.push(`## plans (${plans.length})`);
			for (const p of plans) lines.push(`- ${p.id} "${p.title}"`);
			return { content: [{ type: "text", text: lines.join("\n") }], details: { action } };
		}

		if (action === "show") {
			if (kind !== "plan") throw new Error("show requires kind=plan");
			if (!id) throw new Error("show requires id");
			const plan = await getPlan(cwd, id);
			if (!plan) throw new Error(`no plan with id ${id}`);
			// The body is what the user is being shown; returning it also lets the
			// panel open the plan without a second RPC.
			return {
				content: [{ type: "text", text: plan.body ?? "" }],
				details: { action, kind, id: plan.id },
			};
		}

		if (action === "delete") {
			if (!kind) throw new Error("delete requires kind");
			if (!id) throw new Error("delete requires id");
			if (!isValidKnowledgeId(id)) throw new Error("invalid id");
			const removed =
				kind === "note"
					? await deleteNote(cwd, id)
					: kind === "todo"
						? await deleteTodo(cwd, id)
						: await deletePlan(cwd, id);
			if (!removed) throw new Error(`no ${kind} with id ${id}`);
			return { content: [{ type: "text", text: `deleted ${kind} ${id}` }], details: { action, kind, id } };
		}

		// save
		if (!kind) throw new Error("save requires kind");

		if (kind === "note") {
			const body = params.body ?? "";
			if (id !== undefined) {
				await updateNote(cwd, id, body);
				return { content: [{ type: "text", text: `updated note ${id}` }], details: { action, kind, id } };
			}
			const note = await createNote(cwd, body);
			return {
				content: [{ type: "text", text: `created note ${note.id}` }],
				details: { action, kind, id: note.id },
			};
		}

		if (kind === "todo") {
			// Send `done` alone to tick it — the panel does the same, and requiring
			// the label again would make the model retype it (and drift).
			if (id !== undefined) {
				const updated = await updateTodo(cwd, id, { text: params.text, done: params.done });
				if (!updated) throw new Error(`no todo with id ${id}`);
				return {
					content: [
						{ type: "text", text: `updated todo ${updated.id} [${updated.done ? "x" : " "}] ${updated.text}` },
					],
					details: {
						action,
						kind,
						id: updated.id,
						todo: { id: updated.id, text: updated.text, done: updated.done },
					},
				};
			}
			if (!params.text) throw new Error("save a todo requires text");
			const todo = await createTodo(cwd, params.text);
			return {
				content: [{ type: "text", text: `created todo ${todo.id}: ${todo.text}` }],
				details: { action, kind, id: todo.id, todo: { id: todo.id, text: todo.text, done: todo.done } },
			};
		}

		// plan — the body IS the document; its `# title` line is the title.
		const plan = await savePlan(cwd, params.body ?? "", id);
		return {
			content: [{ type: "text", text: `${id ? "updated" : "created"} plan ${plan.id} "${plan.title}"` }],
			details: { action, kind: "plan", id: plan.id },
		};
	}
}
