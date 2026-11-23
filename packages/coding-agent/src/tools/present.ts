import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@musepi/musepi-type";
import type { AgentTool, AgentToolResult } from "@musepi/pi-agent-core";
import presentDescription from "../prompts/tools/present.md" with { type: "text" };
import type { ToolSession } from "./contract";

const presentFileSchema = type({
	path: type("string").describe(
		"Path of an existing regular file. Relative paths resolve against the session working directory.",
	),
	description: type("string").describe("Brief description for the user.").optional(),
});

export const presentSchema = type({
	files: presentFileSchema
		.array()
		.atLeastLength(1)
		.describe("Final deliverables to present; usually the 1-2 most important files, at most 8."),
});

export interface PresentedFile {
	/** Absolute path, so later directory changes cannot redirect it. */
	path: string;
	description?: string;
}

export interface PresentToolDetails {
	files: PresentedFile[];
	/** Durable session entry recording the declaration, when one was written. */
	entryId?: string;
}

/** Custom-entry type of the durable presented-files declaration. */
export const PRESENTED_DELIVERABLES_TYPE = "deliverables/presented";

/**
 * Declare existing files as final deliverables.
 *
 * The tool records paths instead of copying contents; the host shows them only
 * after the turn ends. Every path is checked as a regular file before it is
 * recorded, so a missing or directory path fails the call instead of handing
 * the user a dead link. A successful call also journals the declaration as a
 * `deliverables/presented` custom entry, so a resumed or replayed transcript
 * still shows the turn's deliveries.
 */
export class PresentTool implements AgentTool<typeof presentSchema, PresentToolDetails> {
	readonly name = "present";
	readonly approval = "read" as const;
	readonly label = "Present";
	readonly summary = "Declare existing files as final deliverables";
	readonly description = presentDescription.trim();
	readonly parameters = presentSchema;
	readonly loadMode = "essential";

	constructor(
		private readonly session: ToolSession,
		private readonly maxFiles = 8,
	) {}

	async execute(
		_toolCallId: string,
		params: typeof presentSchema.infer,
		_signal?: AbortSignal,
		_onUpdate?: unknown,
		_ctx?: unknown,
	): Promise<AgentToolResult<PresentToolDetails>> {
		const files = params.files ?? [];
		if (files.length === 0 || files.length > this.maxFiles) {
			throw new Error(`present accepts 1-${this.maxFiles} files`);
		}
		const presented: PresentedFile[] = [];
		for (const file of files) {
			const raw = typeof file.path === "string" ? file.path.trim() : "";
			if (raw === "") throw new Error("present: file path must not be empty");
			const resolved = path.resolve(this.session.cwd, raw);
			const stat = await fs.stat(resolved).catch(() => null);
			if (stat === null) throw new Error(`present: file not found: ${raw}`);
			if (!stat.isFile()) throw new Error(`present: not a regular file: ${raw}`);
			presented.push({
				path: resolved,
				...(typeof file.description === "string" && file.description.trim() !== ""
					? { description: file.description.trim() }
					: {}),
			});
		}
		const entryId = await this.#journal(presented);
		return {
			content: [{ type: "text", text: presented.map(file => `Presented ${file.path}`).join("\n") }],
			details: { files: presented, ...(entryId === undefined ? {} : { entryId }) },
		};
	}

	/** Journal the declaration; a session without a manager still presents files. */
	async #journal(files: PresentedFile[]): Promise<string | undefined> {
		const manager = this.session.sessionManager;
		if (!manager) return undefined;
		await manager.ensureOnDisk();
		const entryId = manager.appendCustomEntry(PRESENTED_DELIVERABLES_TYPE, { files });
		await manager.flush();
		return entryId;
	}
}
