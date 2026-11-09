import type { ExtensionAPI } from "../../extensibility/extensions/types";
import contextNotesDescription from "../../prompts/tools/context-notes.md" with { type: "text" };
import contextNotesTextDescription from "../../prompts/tools/context-notes-text.md" with { type: "text" };
import newContextDescription from "../../prompts/tools/new-context.md" with { type: "text" };
import {
	CONTEXT_NOTES_ENTRY_TYPE,
	type ContextNotesEntry,
	getContextNotes,
	MAX_CONTEXT_NOTES_BYTES,
	renderContextNotes,
} from "../../session/context-notes";
import { createCustomMessage } from "../../session/messages";

export const name = "musepi-context-notes";
export const inject = [] as const;
export const provide = [] as const;

/**
 * Experimental notes-backed context windows. The tools are plugin-owned so a
 * profile can drop the component without touching the built-in tool slate; the
 * maintenance loop only needs the active tool names to detect `new_context`.
 */
export function apply(pi: ExtensionAPI): void {
	const enabled = ({ settings }: { settings: { get(key: string): unknown } }) =>
		settings.get("compaction.experimentalContextManagement") === true;

	pi.on("context", (event, ctx) => {
		const notes = getContextNotes(ctx.sessionManager.getBranch());
		const rendered = renderContextNotes(ctx.sessionManager.getBranch());
		if (!notes || rendered.length === 0) return;
		const source = ctx.sessionManager.getEntry(notes.entryId);
		return {
			messages: [
				createCustomMessage(
					CONTEXT_NOTES_ENTRY_TYPE,
					rendered,
					false,
					undefined,
					source?.timestamp ?? new Date().toISOString(),
				),
				...event.messages,
			],
		};
	});

	pi.registerTool({
		name: "context_notes",
		label: "Context Notes",
		description: contextNotesDescription,
		parameters: pi.arktype({
			"text?": pi
				.arktype("string")
				.describe(contextNotesTextDescription.replace("{{maxBytes}}", String(MAX_CONTEXT_NOTES_BYTES))),
		}),
		// An omitted `text` means read; strict-mode providers would force `""`.
		strict: false,
		loadMode: "essential",
		approval: "write",
		enabled,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const manager = ctx.sessionManager;
			const input = params as { text?: string };
			if (signal?.aborted) throw new Error("Context notes request aborted.");
			if (input.text !== undefined && typeof input.text !== "string") {
				throw new Error("context_notes text must be a string.");
			}
			if (input.text === undefined) {
				const notes = getContextNotes(manager.getBranch());
				return {
					content: [{ type: "text", text: notes?.text ?? "No context notes are stored for this session branch." }],
					details: { entryId: notes?.entryId, text: notes?.text ?? "" },
				};
			}
			const bytes = Buffer.byteLength(input.text, "utf8");
			if (bytes > MAX_CONTEXT_NOTES_BYTES) {
				throw new Error(
					`Context notes are ${bytes} bytes; the limit is ${MAX_CONTEXT_NOTES_BYTES} UTF-8 bytes. Shorten the notebook and use history://current/full to recover raw detail.`,
				);
			}
			await ctx.ensureSessionOnDisk?.();
			if (signal?.aborted) throw new Error("Context notes request aborted.");
			const data: ContextNotesEntry = { version: 1, text: input.text };
			const entryId = ctx.appendCustomEntry?.(CONTEXT_NOTES_ENTRY_TYPE, data);
			await ctx.flushSession?.();
			return {
				content: [{ type: "text", text: "Context notes saved." }],
				details: { entryId, text: input.text, bytes },
			};
		},
	});

	pi.on("context", (event, ctx) => {
		const notes = getContextNotes(ctx.sessionManager.getBranch());
		const rendered = renderContextNotes(ctx.sessionManager.getBranch());
		if (!notes || rendered.length === 0) return;
		const source = ctx.sessionManager.getEntry(notes.entryId);
		return {
			messages: [
				createCustomMessage(
					CONTEXT_NOTES_ENTRY_TYPE,
					rendered,
					false,
					undefined,
					source?.timestamp ?? new Date().toISOString(),
				),
				...event.messages,
			],
		};
	});

	pi.registerTool({
		name: "new_context",
		label: "New Context",
		description: newContextDescription,
		parameters: pi.arktype({}),
		strict: true,
		loadMode: "essential",
		approval: "write",
		enabled,
		async execute(_toolCallId, _params, signal) {
			if (signal?.aborted) throw new Error("New context request aborted.");
			return {
				content: [{ type: "text", text: "New context window requested." }],
				details: { requested: true },
			};
		},
	});
}
