// ============================================================
// MusePi snapcompact — host seam for the deterministic compaction strategy.
//
// pi's compaction pipeline (manual session.compact() AND auto threshold /
// overflow recovery) offers a session_before_compact hook: when a handler
// returns { compaction }, the built-in LLM summarization is skipped. This
// module registers a native handler on the ExtensionRunner that answers
// with the deterministic snapcompact archive when — and only when —
// musepi.compaction.strategy = "snapcompact". With the default strategy
// the handler returns undefined and pi behavior is untouched.
//
// The archive state rides on CompactionEntry.details.snapcompact, so a
// later compaction unfolds it again (OMP's preserveData cycle, on pi's
// existing details persistence — no session-format change).
// ============================================================

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type SnapArchiveState,
	type SnapCompactionInput,
	type SnapContentBlock,
	type SnapMessage,
	snapCompact,
} from "@musepi/core";
import type {
	ExtensionRunner,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
} from "../../core/extensions/index.ts";
import { convertToLlm } from "../../core/messages.ts";
import type { CompactionEntry } from "../../core/session-manager.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";

/** Fraction of reserveTokens converted to the archive char budget (chars/4). */
const ARCHIVE_BUDGET_RATIO = 0.6;

// =============================================================================
// Message mapping (pi AgentMessage → engine SnapMessage)
// =============================================================================

function toSnapMessage(message: AgentMessage): SnapMessage | undefined {
	if (message.role === "user") {
		return {
			role: "user",
			content: typeof message.content === "string" ? message.content : mapBlocks(message.content),
		};
	}
	if (message.role === "assistant") {
		const blocks: SnapContentBlock[] = [];
		for (const block of message.content) {
			if (block.type === "text") blocks.push({ type: "text", text: block.text });
			else if (block.type === "thinking") blocks.push({ type: "thinking", thinking: block.thinking });
			else if (block.type === "toolCall") {
				blocks.push({
					type: "toolCall",
					id: block.id,
					name: block.name,
					arguments: (block.arguments ?? {}) as Record<string, unknown>,
				});
			}
		}
		return { role: "assistant", content: blocks };
	}
	if (message.role === "toolResult") {
		const text = message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("");
		return {
			role: "toolResult",
			content: text,
			toolCallId: message.toolCallId,
			isError: message.isError,
		};
	}
	return undefined;
}

function mapBlocks(content: Array<{ type: string; text?: string }>): SnapContentBlock[] {
	return content
		.filter(
			(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
		)
		.map((block) => ({ type: "text", text: block.text }));
}

// =============================================================================
// Previous archive recovery
// =============================================================================

interface SnapcompactDetails {
	snapcompact?: SnapArchiveState;
}

/** Latest snapcompact archive persisted on a previous compaction entry. */
export function findPreviousArchive(branchEntries: readonly unknown[]): SnapArchiveState | undefined {
	for (let i = branchEntries.length - 1; i >= 0; i--) {
		const entry = branchEntries[i] as { type?: string; details?: unknown };
		if (entry?.type !== "compaction") continue;
		const details = entry.details as SnapcompactDetails | undefined;
		const archive = details?.snapcompact;
		if (archive && typeof archive.text === "string" && typeof archive.truncatedChars === "number") {
			return archive;
		}
		return undefined; // latest compaction was not snapcompact — start fresh
	}
	return undefined;
}

// =============================================================================
// Handler
// =============================================================================

/** Exposed for tests: run the strategy-gated handler against a prepared event. */
export function handleMusepiSnapcompact(
	event: SessionBeforeCompactEvent,
	settingsManager: SettingsManager,
): SessionBeforeCompactResult | undefined {
	if (settingsManager.getMusepi().compaction.strategy !== "snapcompact") return undefined;

	const { preparation } = event;
	const llmMessages = convertToLlm([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]);
	const messages = llmMessages.map(toSnapMessage).filter((msg): msg is SnapMessage => msg !== undefined);

	const input: SnapCompactionInput = {
		messages,
		previousSummary: preparation.previousSummary,
		previousArchive: findPreviousArchive(event.branchEntries),
		fileOps: preparation.fileOps,
		archiveMaxChars: Math.max(8_000, Math.round(preparation.settings.reserveTokens * 4 * ARCHIVE_BUDGET_RATIO)),
	};
	const result = snapCompact(input);

	return {
		compaction: {
			summary: result.summary,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {
				readFiles: result.readFiles,
				modifiedFiles: result.modifiedFiles,
				snapcompact: result.archive,
			},
		},
	};
}

/**
 * Register the snapcompact session_before_compact handler on the runner.
 * Always registered (runtime gate inside the handler) so the strategy can
 * flip without a session restart. Idempotent per runner — AgentSession
 * re-arms on every runner (re)build.
 */
const armedRunners = new WeakSet<ExtensionRunner>();

export function initMusepiSnapcompact(settingsManager: SettingsManager, extensionRunner: ExtensionRunner): void {
	if (armedRunners.has(extensionRunner)) return;
	armedRunners.add(extensionRunner);
	extensionRunner.registerNativeHandler("session_before_compact", async (event: unknown) => {
		return handleMusepiSnapcompact(event as SessionBeforeCompactEvent, settingsManager);
	});
}

/** CompactionEntry.details shape written by this strategy (for readers). */
export function readSnapcompactArchive(entry: CompactionEntry): SnapArchiveState | undefined {
	const details = entry.details as SnapcompactDetails | undefined;
	return details?.snapcompact;
}
