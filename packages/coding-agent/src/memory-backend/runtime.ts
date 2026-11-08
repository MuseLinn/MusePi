import type { AgentSession } from "../session/agent-session";
import { resolveMemoryBackend } from "./resolve";
import type {
	MemoryBackendId,
	MemoryBackendOperationContext,
	MemoryBackendSaveInput,
	MemoryBackendSearchOptions,
	MemoryRuntimeContext,
} from "./types";
export function createMemoryRuntimeContext(context: MemoryBackendOperationContext): MemoryRuntimeContext {
	const settings = context.session?.settings;
	return {
		async backend() {
			if (!settings) return "off";
			return (await resolveMemoryBackend(settings)).id;
		},
		async status() {
			if (!settings) {
				return {
					backend: "off" as const,
					active: false,
					writable: false,
					searchable: false,
					message: "No active agent session.",
				};
			}
			const backend = await resolveMemoryBackend(settings);
			return backend.status
				? await backend.status(context)
				: {
						backend: backend.id,
						active: backend.id !== "off",
						writable: false,
						searchable: false,
						message: "This memory backend does not expose structured status.",
					};
		},
		async search(query: string, options?: MemoryBackendSearchOptions) {
			if (!settings) return unavailableSearch("off", query, "No active agent session.");
			const backend = await resolveMemoryBackend(settings);
			return backend.search
				? await backend.search(context, query, options)
				: unavailableSearch(backend.id, query, `Memory search is not available for the ${backend.id} backend.`);
		},
		async save(input: string | MemoryBackendSaveInput) {
			if (!settings) return unavailableSave("off", "No active agent session.");
			const backend = await resolveMemoryBackend(settings);
			const normalized = typeof input === "string" ? { content: input } : input;
			return backend.save
				? await backend.save(context, normalized)
				: unavailableSave(backend.id, `Memory save is not available for the ${backend.id} backend.`);
		},
		async clear() {
			if (!settings) return;
			const backend = await resolveMemoryBackend(settings);
			await backend.clear(context.agentDir, context.cwd, context.session);
		},
		async enqueue() {
			if (!settings) return;
			const backend = await resolveMemoryBackend(settings);
			await backend.enqueue(context.agentDir, context.cwd, context.session);
		},
		async view() {
			if (!settings) return undefined;
			const backend = await resolveMemoryBackend(settings);
			return backend.buildDeveloperInstructions(context.agentDir, context.cwd, settings, context.session);
		},
		async stats() {
			if (!settings) return undefined;
			const backend = await resolveMemoryBackend(settings);
			return backend.stats?.(context.agentDir, context.cwd, context.session);
		},
		async diagnose() {
			if (!settings) return undefined;
			const backend = await resolveMemoryBackend(settings);
			return backend.diagnose?.(context.agentDir, context.cwd, context.session);
		},
	};
}

export function createSessionMemoryRuntimeContext(
	session: AgentSession,
	agentDir: string,
	cwd: string,
): MemoryRuntimeContext {
	return createMemoryRuntimeContext({ agentDir, cwd, session });
}

function unavailableSearch(backend: MemoryBackendId, query: string, message: string) {
	return { backend, query, count: 0, items: [], message };
}

function unavailableSave(backend: MemoryBackendId, message: string) {
	return { backend, stored: 0, message };
}
