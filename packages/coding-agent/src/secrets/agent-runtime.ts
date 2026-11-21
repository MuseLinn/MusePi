/**
 * Agent secret runtime bridge.
 *
 * Three seams live here, all keyed by the resolved agent dir:
 * - session start: stored secrets become plain obfuscator entries, so provider
 *   requests never carry them even before `request_secret` is called;
 * - save: a newly stored value is registered into every live session's
 *   obfuscator immediately (`SecretObfuscator.addSecret`);
 * - bash: the child environment receives `MUSEPI_SECRET_<NAME>`, the process
 *   environment never does, and tool output is scrubbed to `[secret:NAME]`.
 *
 * P0 scope is `"all"` for every entry; a future workspace/bot union filters
 * here rather than in callers.
 */

import { agentSecretEnvName, getAgentSecretStore, type SecretEntryView, type SecretScope } from "./agent-store";
import type { SecretEntry, SecretObfuscator } from "./obfuscator";

/** A live obfuscator per session, weakly held so a disposed session is collectable. */
const obfuscators = new Map<string, Set<WeakRef<SecretObfuscator>>>();

/** Session-scoped grants for `secret-request` kind "allow". */
const granted = new Map<string, Set<string>>();

/** Names already touched in this process (one metadata write per name). */
const touched = new Map<string, Set<string>>();

function agentKey(agentDir: string): string {
	return agentDir;
}

function sessionKey(agentDir: string, sessionId: string | null | undefined): string {
	return `${agentDir}\0${sessionId ?? "<no-session>"}`;
}

/** Stored agent secrets as constructor entries for a session obfuscator. */
export async function loadAgentSecretEntries(agentDir: string): Promise<SecretEntry[]> {
	try {
		const values = await getAgentSecretStore(agentDir).values();
		return values.map(({ name, value }) => ({
			type: "plain" as const,
			content: value,
			mode: "obfuscate" as const,
			friendlyName: name,
		}));
	} catch {
		// An unreadable store must not block session startup; the tools and bash
		// injection degrade to "no available secret" and the user sees the form.
		return [];
	}
}

/** Keep the session obfuscator reachable for mid-session saves. */
export function registerAgentSecretObfuscator(agentDir: string, obfuscator: SecretObfuscator): void {
	const key = agentKey(agentDir);
	let set = obfuscators.get(key);
	if (!set) {
		set = new Set();
		obfuscators.set(key, set);
	}
	set.add(new WeakRef(obfuscator));
}

function liveObfuscators(agentDir: string): SecretObfuscator[] {
	const set = obfuscators.get(agentKey(agentDir));
	if (!set) return [];
	const live: SecretObfuscator[] = [];
	for (const ref of set) {
		const obfuscator = ref.deref();
		if (obfuscator) live.push(obfuscator);
		else set.delete(ref);
	}
	if (set.size === 0) obfuscators.delete(agentKey(agentDir));
	return live;
}

/** Register a just-saved value into every live session for this agent dir. */
export function notifyAgentSecretSaved(agentDir: string, name: string, value: string): void {
	for (const obfuscator of liveObfuscators(agentDir)) {
		obfuscator.addSecret(value, name);
	}
}

/** Record a session-level allow for an already-stored value. */
export function grantAgentSecret(agentDir: string, sessionId: string | null | undefined, name: string): void {
	const key = sessionKey(agentDir, sessionId);
	let set = granted.get(key);
	if (!set) {
		set = new Set();
		granted.set(key, set);
	}
	set.add(name);
}

export function isAgentSecretGranted(agentDir: string, sessionId: string | null | undefined, name: string): boolean {
	return granted.get(sessionKey(agentDir, sessionId))?.has(name) === true;
}

/** Drop grants when a session goes away (best effort; process memory only). */
export function forgetAgentSecretSession(agentDir: string, sessionId: string | null | undefined): void {
	granted.delete(sessionKey(agentDir, sessionId));
}

/** Child-process environment for a bash call: `MUSEPI_SECRET_<NAME>` → value. */
export interface AgentSecretSnapshot {
	/** Only values that reached the child environment. */
	env: Record<string, string>;
	/** Synchronous scrubber for this call's output paths. */
	redact(text: string): string;
}

/**
 * Read the stored values once per bash call: the env map plus a synchronous
 * redactor. The synchronous part matters because output streaming callbacks
 * cannot await a store read on every chunk.
 */
export async function agentSecretSnapshot(agentDir: string): Promise<AgentSecretSnapshot> {
	const store = getAgentSecretStore(agentDir);
	const values = await store.values();
	let touchedNames = touched.get(agentDir);
	if (!touchedNames) {
		touchedNames = new Set();
		touched.set(agentDir, touchedNames);
	}
	const env: Record<string, string> = {};
	const sorted = [...values].sort((a, b) => b.value.length - a.value.length);
	for (const { name, value } of sorted) {
		env[agentSecretEnvName(name)] = value;
		// lastUsedAt is best-effort: a metadata failure must not break the command.
		void store.touch(name, touchedNames).catch(() => {});
	}
	return {
		env,
		redact(text: string): string {
			if (text.length === 0) return text;
			let output = text;
			for (const { name, value } of sorted) {
				if (value.length === 0) continue;
				output = output.split(value).join(`[secret:${name}]`);
			}
			return output;
		},
	};
}

export async function agentSecretEnv(agentDir: string): Promise<Record<string, string>> {
	return (await agentSecretSnapshot(agentDir)).env;
}

/** Scrub stored values from bash output before it becomes a tool result. */
export async function redactAgentSecretText(agentDir: string, text: string): Promise<string> {
	if (text.length === 0) return text;
	try {
		return await getAgentSecretStore(agentDir).redact(text);
	} catch {
		return text;
	}
}

/** Names that are available right now (decryptable), for `list_secrets`. */
export async function listAvailableAgentSecrets(
	agentDir: string,
): Promise<Array<{ entry: SecretEntryView; available: boolean }>> {
	const store = getAgentSecretStore(agentDir);
	const entries = await store.list();
	const out: Array<{ entry: SecretEntryView; available: boolean }> = [];
	for (const entry of entries) {
		out.push({ entry, available: await store.available(entry.name) });
	}
	return out;
}

/** P0 filter seam: every stored entry is injected in every session. */
export function scopeMatches(scope: SecretScope, _cwd: string): boolean {
	return scope === "all";
}
