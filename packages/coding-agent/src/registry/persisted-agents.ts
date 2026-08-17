import * as fs from "node:fs";
import * as path from "node:path";
import { ADVISOR_TRANSCRIPT_FILENAME, isAdvisorTranscriptName } from "../advisor/transcript-recorder";
import { resolveExplicitModelRole } from "../config/model-resolver";
import { EPHEMERAL_MODEL_CHANGE_ROLE } from "../session/session-entries";
import { visitEntriesFromFileStream } from "../session/session-loader";
import { loadBundledAgents } from "../task/agents";
import { isReadOnlyAgent } from "../task/read-only-policy";
import { persistedVibeChildIds } from "../vibe/runtime";
import {
	type AgentHistorySummary,
	type AgentMetricsSummary,
	type AgentRegistry,
	getAgentTombstonePath,
	MAIN_AGENT_ID,
} from "./agent-registry";

/** Maximum prefix entries inspected for task metadata. */
const MAX_METADATA_LINES = 64;

interface PersistedAgentMetadata {
	activity?: string;
	createdAt?: number;
	lastActivity?: number;
	history?: AgentHistorySummary;
}

interface PersistedTranscript {
	id: string;
	sessionFile: string;
	createdAt?: number;
	lastActivity?: number;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function timestampOf(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

function summarizePersistedTask(task: string): string | undefined {
	const withoutPreamble = task.replace(/^Complete the assignment below,\s*thoroughly:\s*/i, "");
	const lines = withoutPreamble.split(/\r?\n/);
	const targetIndex = lines.findIndex(line => line.trim().toLowerCase() === "# target");
	const targetLines: string[] = [];
	if (targetIndex >= 0) {
		for (const line of lines.slice(targetIndex + 1)) {
			if (line.trimStart().startsWith("# ")) break;
			targetLines.push(line);
		}
	}
	const summary = (targetLines.length > 0 ? targetLines : lines).join(" ").replace(/\s+/g, " ").trim();
	return summary ? summary.slice(0, 1_000) : undefined;
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function inferBundledAgent(systemPrompt: string): { agent?: string; modelRole?: string; readOnly?: boolean } {
	const matches = loadBundledAgents().filter(agent => {
		const rolePrompt = agent.systemPrompt.trim();
		return rolePrompt.length > 0 && systemPrompt.includes(rolePrompt);
	});
	// `task` and `sonic` intentionally share a prompt body. Ambiguous historical
	// prompts stay unlabelled rather than inventing provenance.
	if (matches.length !== 1) return {};
	const [agent] = matches;
	return {
		agent: agent.name,
		modelRole: resolveExplicitModelRole(agent.model),
		readOnly: isReadOnlyAgent(agent),
	};
}

function usageTokens(usage: Record<string, unknown>): number {
	const computed = finiteNumber(usage.input) + finiteNumber(usage.output) + finiteNumber(usage.cacheWrite);
	return computed > 0 ? computed : finiteNumber(usage.totalTokens);
}

interface AssistantMetrics {
	tokens: number;
	tools: number;
	cost: number;
	contextTokens?: number;
	resolvedModel?: string;
}

function assistantMetrics(message: Record<string, unknown>): AssistantMetrics {
	const usage = recordOf(message.usage) ?? {};
	const cost = recordOf(usage.cost);
	const content = Array.isArray(message.content) ? message.content : [];
	const provider = typeof message.provider === "string" ? message.provider : undefined;
	const model = typeof message.model === "string" ? message.model : undefined;
	return {
		tokens: usageTokens(usage),
		tools: content.filter(part => recordOf(part)?.type === "toolCall").length,
		cost: finiteNumber(cost?.total),
		contextTokens: finiteNumber(usage.totalTokens) || undefined,
		resolvedModel: provider && model ? `${provider}/${model}` : undefined,
	};
}

async function readPersistedAgentHistory(
	transcript: PersistedTranscript,
	shouldContinue: () => boolean,
): Promise<AgentHistorySummary> {
	const parents = new Map<string, string | undefined>();
	const assistantById = new Map<string, AssistantMetrics>();
	const modelChangeById = new Map<string, { model: string; role?: string; resolvedModelIsFallback: boolean }>();
	let leafId: string | undefined;
	let leafTimestamp: number | undefined;
	try {
		await visitEntriesFromFileStream(
			transcript.sessionFile,
			entry => {
				const record = recordOf(entry);
				if (!record) return;
				const id = typeof record.id === "string" ? record.id : undefined;
				if (!id) return;
				const parentId = typeof record.parentId === "string" ? record.parentId : undefined;
				parents.set(id, parentId);
				leafId = id;
				const parsedTimestamp = timestampOf(record.timestamp);
				if (parsedTimestamp !== undefined) leafTimestamp = parsedTimestamp;
				if (record.type === "model_change" && typeof record.model === "string") {
					modelChangeById.set(id, {
						model: record.model,
						role: typeof record.role === "string" ? record.role : undefined,
						resolvedModelIsFallback: record.resolvedModelIsFallback === true,
					});
					return;
				}
				if (record.type !== "message") return;
				const message = recordOf(record.message);
				if (message?.role === "assistant") assistantById.set(id, assistantMetrics(message));
			},
			{ shouldContinue },
		);
	} catch {
		return {};
	}

	const metrics: AgentMetricsSummary = {
		tokens: 0,
		requests: 0,
		tools: 0,
		cost: 0,
		durationMs: Math.max(
			0,
			(leafTimestamp ?? transcript.lastActivity ?? transcript.createdAt ?? 0) -
				(transcript.createdAt ?? leafTimestamp ?? 0),
		),
		durationKind: "span",
	};
	let resolvedModel: string | undefined;
	let resolvedModelIsFallback: boolean | undefined;
	let modelRole: string | undefined;
	let contextTokens: number | undefined;
	let modelChangeFound = false;
	const visited = new Set<string>();
	for (let id = leafId; id && !visited.has(id); id = parents.get(id)) {
		visited.add(id);
		const modelChange = modelChangeById.get(id);
		if (modelChange && !modelChangeFound) {
			modelChangeFound = true;
			resolvedModel = modelChange.model;
			resolvedModelIsFallback = modelChange.resolvedModelIsFallback;
			if (modelChange.role && modelChange.role !== EPHEMERAL_MODEL_CHANGE_ROLE) {
				modelRole = modelChange.role;
			}
		}
		const assistant = assistantById.get(id);
		if (!assistant) continue;
		if (!modelChangeFound && resolvedModel === undefined && assistant.resolvedModel) {
			resolvedModel = assistant.resolvedModel;
		}
		metrics.requests++;
		metrics.tokens += assistant.tokens;
		metrics.tools += assistant.tools;
		metrics.cost += assistant.cost;
		contextTokens ??= assistant.contextTokens;
	}
	if (contextTokens !== undefined) metrics.contextTokens = contextTokens;
	return {
		...(metrics.requests > 0 ? { metrics } : {}),
		...(resolvedModel ? { resolvedModel, resolvedModelIsFallback } : {}),
		...(modelRole ? { modelRole } : {}),
	};
}

/**
 * Read only the small session prefix needed by the Hub. A subagent's first
 * `session_init` is written before its conversation, so this never walks a
 * multi-megabyte historical transcript just to populate one roster row.
 */
async function readPersistedAgentMetadata(sessionFile: string): Promise<PersistedAgentMetadata> {
	const stat = fs.promises.stat(sessionFile).catch(() => undefined);
	const artifactBase = sessionFile.slice(0, -".jsonl".length);
	const outputPath = `${artifactBase}.md`;
	const patchPath = `${artifactBase}.patch`;
	const artifactFiles = Promise.all([Bun.file(outputPath).exists(), Bun.file(patchPath).exists()]);
	let createdAt: number | undefined;
	let activity: string | undefined;
	let history: AgentHistorySummary = {};
	try {
		await visitEntriesFromFileStream(
			sessionFile,
			entry => {
				const record = recordOf(entry);
				if (!record) return;
				if (record.type === "session") {
					createdAt ??= timestampOf(record.timestamp);
					return;
				}
				if (record.type === "model_change") {
					if (typeof record.model === "string") history.resolvedModel = record.model;
					if (typeof record.role === "string" && record.role !== EPHEMERAL_MODEL_CHANGE_ROLE) {
						history.modelRole = record.role;
					}
					if (typeof record.resolvedModelIsFallback === "boolean") {
						history.resolvedModelIsFallback = record.resolvedModelIsFallback;
					}
					return;
				}
				if (record.type !== "session_init") return;
				createdAt ??= timestampOf(record.timestamp);
				if (typeof record.task === "string") activity = summarizePersistedTask(record.task);
				const inferred = typeof record.systemPrompt === "string" ? inferBundledAgent(record.systemPrompt) : {};
				history = {
					...history,
					...inferred,
					agent: typeof record.agent === "string" ? record.agent : inferred.agent,
					modelRole:
						typeof record.modelRole === "string" ? record.modelRole : (history.modelRole ?? inferred.modelRole),
					resolvedModel: typeof record.resolvedModel === "string" ? record.resolvedModel : history.resolvedModel,
					readOnly: typeof record.readOnly === "boolean" ? record.readOnly : inferred.readOnly,
				};
				return false;
			},
			{ maxRecords: MAX_METADATA_LINES },
		);
	} catch {
		// A readable transcript is still useful even when its optional metadata
		// prefix is malformed.
	}
	const [file, [hasOutput, hasPatch]] = await Promise.all([stat, artifactFiles]);
	return {
		activity,
		createdAt: createdAt ?? file?.birthtimeMs,
		lastActivity: file?.mtimeMs,
		history: {
			...history,
			...(hasOutput ? { outputPath } : {}),
			...(hasPatch ? { patchPath } : {}),
		},
	};
}

async function readPersistedVibeChildIds(sessionFile: string, shouldContinue: () => boolean): Promise<Set<string>> {
	const ids = new Set<string>();
	try {
		await visitEntriesFromFileStream(
			sessionFile,
			entry => {
				for (const id of persistedVibeChildIds([entry])) ids.add(id);
			},
			{ shouldContinue },
		);
		return ids;
	} catch {
		return new Set();
	}
}

/** Register persisted subagent and advisor transcripts as parked registry refs. */
export async function registerPersistedSubagents(
	registry: AgentRegistry,
	sessionFile: string | null | undefined,
	options: { shouldContinue?: () => boolean } = {},
): Promise<void> {
	if (!sessionFile?.endsWith(".jsonl")) return;
	const shouldContinue = options.shouldContinue ?? (() => true);
	if (!shouldContinue()) return;
	const vibeOwnedIds = await readPersistedVibeChildIds(sessionFile, shouldContinue);
	if (!shouldContinue()) return;
	const root = sessionFile.slice(0, -6);
	const transcripts: PersistedTranscript[] = [];
	await registerPersistedSubagentsFromDir(registry, root, undefined, vibeOwnedIds, transcripts, shouldContinue);
	if (!shouldContinue()) return;
	let nextTranscript = 0;
	const workers = Array.from({ length: Math.min(4, transcripts.length) }, async () => {
		for (;;) {
			if (!shouldContinue()) return;
			const index = nextTranscript++;
			const transcript = transcripts[index];
			if (!transcript) return;
			const history = await readPersistedAgentHistory(transcript, shouldContinue);
			if (!shouldContinue()) return;
			registry.setHistory(transcript.id, history, transcript.sessionFile);
		}
	});
	await Promise.all(workers);
}

async function registerPersistedSubagentsFromDir(
	registry: AgentRegistry,
	dir: string,
	parentId: string | undefined,
	vibeOwnedIds: ReadonlySet<string>,
	transcripts: PersistedTranscript[],
	shouldContinue: () => boolean,
): Promise<void> {
	if (!shouldContinue()) return;
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	if (!shouldContinue()) return;
	let entriesSinceYield = 0;
	for (const entry of entries) {
		if (!shouldContinue()) return;
		if (++entriesSinceYield >= 16) {
			entriesSinceYield = 0;
			await Bun.sleep(0);
		}
		if (!shouldContinue()) return;
		if (!entry.isFile() || !entry.name.endsWith(".jsonl") || entry.name.includes(".bak")) continue;
		const sessionFile = path.join(dir, entry.name);
		// The advisor transcript is observability-only: register it as a non-peer
		// `advisor` kind under its owning session so the Hub can show its read-only
		// transcript, but it never joins agent-facing rosters and is not revivable.
		if (isAdvisorTranscriptName(entry.name)) {
			const owner = parentId ?? MAIN_AGENT_ID;
			// `__advisor.jsonl` → the default advisor (no slug); `__advisor.<slug>.jsonl`
			// → a named advisor, keyed and labeled by its slug.
			const slug =
				entry.name === ADVISOR_TRANSCRIPT_FILENAME ? "" : entry.name.slice("__advisor.".length, -".jsonl".length);
			const advisorId = slug ? `${owner}/advisor:${slug}` : `${owner}/advisor`;
			const displayName = slug ? `advisor:${slug}` : "advisor";
			const existing = registry.get(advisorId);
			// Never clobber a non-advisor ref that happens to share this id (a freak
			// user task literally named `<owner>/advisor`): leave it, skip the advisor.
			if (existing && existing.kind !== "advisor") continue;
			if (existing?.sessionFile !== sessionFile) {
				const metadata = await readPersistedAgentMetadata(sessionFile);
				if (!shouldContinue()) return;
				// The id is reused across `/new`; refresh it to the current session's file.
				if (existing) registry.unregister(advisorId);
				registry.register({
					id: advisorId,
					displayName,
					kind: "advisor",
					parentId: owner,
					session: null,
					sessionFile,
					activity: metadata.activity,
					createdAt: metadata.createdAt,
					lastActivity: metadata.lastActivity,
					history: { ...metadata.history, readOnly: true },
					status: "parked",
				});
				transcripts.push({
					id: advisorId,
					sessionFile,
					createdAt: metadata.createdAt,
					lastActivity: metadata.lastActivity,
				});
			}
			continue;
		}
		const id = entry.name.slice(0, -6);
		if (vibeOwnedIds.has(id) && registry.get(id)?.sessionFile !== sessionFile) continue;
		let tombstoned = false;
		try {
			await fs.promises.access(getAgentTombstonePath(sessionFile));
			tombstoned = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
		}
		if (!shouldContinue()) return;
		if (!registry.get(id)) {
			const metadata = await readPersistedAgentMetadata(sessionFile);
			if (!shouldContinue()) return;
			registry.register({
				id,
				displayName: id,
				kind: "sub",
				parentId: parentId ?? MAIN_AGENT_ID,
				session: null,
				sessionFile,
				activity: metadata.activity,
				createdAt: metadata.createdAt,
				lastActivity: metadata.lastActivity,
				history: metadata.history,
				status: tombstoned ? "aborted" : "parked",
			});
			const ref = registry.get(id);
			transcripts.push({
				id,
				sessionFile,
				createdAt: ref?.createdAt,
				lastActivity: ref?.lastActivity,
			});
		}
		await registerPersistedSubagentsFromDir(
			registry,
			path.join(dir, id),
			id,
			vibeOwnedIds,
			transcripts,
			shouldContinue,
		);
	}
}
