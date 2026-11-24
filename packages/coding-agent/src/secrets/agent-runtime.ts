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

import * as path from "node:path";
import { logger } from "@musepi/pi-utils";
import {
	agentSecretEnvName,
	getAgentSecretStore,
	type SecretEntryView,
	type SecretScope,
	secretScopeIncludes,
} from "./agent-store";
import { secretForms } from "./forms";
import type { SecretEntry, SecretObfuscator } from "./obfuscator";

/** A live obfuscator per session, weakly held so a disposed session is collectable. */
const obfuscators = new Map<string, Set<WeakRef<SecretObfuscator>>>();

/** Names already touched in this process (one metadata write per name). */
const touched = new Map<string, Set<string>>();

function agentKey(agentDir: string): string {
	return path.resolve(agentDir);
}

/** Stored agent secrets as constructor entries for a session obfuscator. */
export async function loadAgentSecretEntries(agentDir: string): Promise<SecretEntry[]> {
	try {
		const values = await getAgentSecretStore(agentDir).values();
		return values.flatMap(({ name, value }) =>
			secretForms(value).map(form => ({
				type: "plain" as const,
				content: form,
				mode: "obfuscate" as const,
				friendlyName: name,
			})),
		);
	} catch (error) {
		// A failed load is a degraded security control, not a normal empty store.
		// Startup must continue, but the failure has to be observable.
		logger.warn("Agent secrets could not be loaded into the session obfuscator", {
			agentDir: agentKey(agentDir),
			error: error instanceof Error ? error.message : String(error),
		});
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
		for (const form of secretForms(value)) obfuscator.addSecret(form, name);
	}
}

/** Child-process environment for a bash call: `MUSEPI_SECRET_<NAME>` → value. */
export interface AgentSecretSnapshot {
	/** Only values that reached the child environment. */
	env: Record<string, string>;
	/** Synchronous scrubber for this call's output paths. */
	redact(text: string): string;
}

/** Matches the reversible plain-secret floor: below it a value is only matched
 *  where it stands alone, so a short PIN never redacts part of a word. */
const WHOLE_VALUE_SECRET_LEN = 8;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * One-pass output scrubber. A `[secret:NAME]` label already in the text is kept
 * verbatim, so a short value that spells part of a name cannot nest markers on a
 * second pass, and values shorter than the reversible floor match only when no
 * letter or digit sits on either side.
 */
function buildSecretRedactor(entries: ReadonlyArray<{ name: string; value: string }>): (text: string) => string {
	const pairs = entries
		.filter(({ value }) => value.length > 0)
		.flatMap(({ name, value }) => {
			const marker = `[secret:${name}]`;
			const short = value.length < WHOLE_VALUE_SECRET_LEN;
			return secretForms(value).map(form => ({ value: form, marker, short }));
		})
		.sort((a, b) => b.value.length - a.value.length);
	if (pairs.length === 0) return text => text;
	const byValue = new Map<string, string>();
	for (const pair of pairs) if (!byValue.has(pair.value)) byValue.set(pair.value, pair.marker);
	const alternatives = pairs.map(pair => {
		const escaped = escapeRegExp(pair.value);
		return pair.short ? `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])` : escaped;
	});
	const pattern = new RegExp(`(\\[secret:[A-Z][A-Z0-9_]{0,63}\\])|${alternatives.join("|")}`, "gu");
	return text =>
		text.length === 0
			? text
			: text.replace(pattern, (match: string, label: string | undefined) => label ?? byValue.get(match) ?? match);
}

/**
 * Read the stored values once per bash call: the env map plus a synchronous
 * redactor. The synchronous part matters because output streaming callbacks
 * cannot await a store read on every chunk.
 */
export async function agentSecretSnapshot(
	agentDir: string,
	cwd: string,
	options: { command?: string; referencedOnly?: boolean } = {},
): Promise<AgentSecretSnapshot> {
	const store = getAgentSecretStore(agentDir);
	const values = await store.values();
	const key = agentKey(agentDir);
	let touchedNames = touched.get(key);
	if (!touchedNames) {
		touchedNames = new Set();
		touched.set(key, touchedNames);
	}
	const env: Record<string, string> = {};
	// The scope filter is the single seam that decides which entries this session
	// may use. A `file` entry is redacted but never exported: its consumer reads
	// the private path, so it must not also sit in every child's environment.
	const sorted = values
		.filter(({ scope }) => scopeMatches(scope, cwd))
		.sort((a, b) => b.value.length - a.value.length);
	const referenced = new Set<string>();
	if (options.referencedOnly === true && options.command !== undefined) {
		for (const match of options.command.matchAll(/MUSEPI_SECRET_([A-Z][A-Z0-9_]{0,63})/gu)) {
			referenced.add(match[1]!);
		}
	}
	for (const { name, value, delivery } of sorted) {
		if (delivery !== "env") continue;
		// Narrowed injection: a name the command does not mention never enters the
		// child environment. The redactor below still covers every stored value.
		if (options.referencedOnly === true && !referenced.has(name)) continue;
		env[agentSecretEnvName(name)] = value;
		// lastUsedAt is best-effort: a metadata failure must not break the command.
		void store.touch(name, touchedNames).catch(() => {});
	}
	return {
		env,
		redact: buildSecretRedactor(sorted),
	};
}

/** Names that are available right now (decryptable), for `list_secrets`. */
export async function listAvailableAgentSecrets(
	agentDir: string,
	cwd?: string,
): Promise<Array<{ entry: SecretEntryView; available: boolean; usable: boolean }>> {
	const store = getAgentSecretStore(agentDir);
	const entries = await store.list();
	const out: Array<{ entry: SecretEntryView; available: boolean; usable: boolean }> = [];
	for (const entry of entries) {
		const available = await store.available(entry.name);
		const usable = available && (cwd === undefined || secretScopeIncludes(entry.scope, cwd));
		out.push({ entry, available, usable });
	}
	return out;
}

/** Scope filter: every entry is injected in a session whose workspace it covers. */
export function scopeMatches(scope: SecretScope, cwd: string): boolean {
	return secretScopeIncludes(scope, cwd);
}
