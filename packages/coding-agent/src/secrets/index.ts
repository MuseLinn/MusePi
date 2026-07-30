import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { regexHasUnresolvableShortMatchFallback, type SecretEntry, sanitizeSecretFriendlyName } from "./obfuscator";
import { compileSecretRegex } from "./regex";

const PLACEHOLDER_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const cachedPlaceholderKeys = new Map<string, string>();

/**
 * Per-install secret key for the placeholder digest. Persisted under the agent
 * config directory and never sent to a provider, so model-visible placeholders
 * cannot be reversed by dictionary-hashing candidate secrets. Stable across
 * sessions so persisted transcripts deobfuscate consistently. Defaults to
 * `getAgentDir()` — the same directory `createAgentSession()` passes as
 * `agentDir` — so a caller relying on the default reads/writes the identical
 * key file live sessions use, per `~/.omp/agent/secret-placeholder.key` in
 * docs/secrets.md.
 */
export async function getSecretPlaceholderKey(keyDir: string = getAgentDir()): Promise<string> {
	const keyPath = path.join(keyDir, "secret-placeholder.key");
	const cached = cachedPlaceholderKeys.get(keyPath);
	if (cached !== undefined) return cached;

	const existing = await readPlaceholderKeyFile(keyPath, false);
	if (existing !== undefined) {
		cachedPlaceholderKeys.set(keyPath, existing);
		return existing;
	}

	const generated = crypto.randomBytes(32).toString("base64url");
	await fs.mkdir(keyDir, { recursive: true });
	try {
		await fs.writeFile(keyPath, generated, { flag: "wx", mode: 0o600 });
		cachedPlaceholderKeys.set(keyPath, generated);
		return generated;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		// Another process won the create race but may still be mid-write: `wx`
		// creates the file empty before the bytes land. Wait for non-empty content
		// instead of caching an empty key (which would be a known, dictionaryable
		// key and would not match tokens other processes persist with the real key).
		const winner = await readPlaceholderKeyFile(keyPath, true);
		if (winner === undefined) {
			throw new Error(`secret placeholder key at ${keyPath} exists but is empty or unreadable`);
		}
		cachedPlaceholderKeys.set(keyPath, winner);
		return winner;
	}
}

/** Return an existing placeholder key for redaction without creating a new key file. */
export async function getExistingSecretPlaceholderKey(keyDir: string = getAgentDir()): Promise<string | undefined> {
	const keyPath = path.join(keyDir, "secret-placeholder.key");
	const cached = cachedPlaceholderKeys.get(keyPath);
	if (cached !== undefined) return cached;
	// Redaction-only: this key is loaded solely to redact an existing key file from
	// provider-visible tool output, never to mint placeholders. A truncated/corrupt
	// or unreadable key must NOT block startup for replace-only/no-secret sessions —
	// an invalid key is not a usable HMAC anyway, and a tool reading the same file
	// gets the same bytes, so there is nothing sensitive to redact.
	let existing: string | undefined;
	try {
		existing = await readPlaceholderKeyFile(keyPath, true);
	} catch {
		return undefined;
	}
	if (existing !== undefined) cachedPlaceholderKeys.set(keyPath, existing);
	return existing;
}

/** Read and validate the key file, optionally retrying briefly until a valid key lands. */
async function readPlaceholderKeyFile(keyPath: string, retry: boolean): Promise<string | undefined> {
	const attempts = retry ? 50 : 1;
	let invalidValue: string | undefined;
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (attempt > 0) await Bun.sleep(10);
		try {
			const value = (await Bun.file(keyPath).text()).trim();
			if (PLACEHOLDER_KEY_RE.test(value)) return value;
			if (value.length > 0) invalidValue = value;
		} catch (err) {
			if (isEnoent(err)) return undefined;
			throw err;
		}
	}
	if (invalidValue !== undefined) {
		throw new Error(`secret placeholder key at ${keyPath} is invalid`);
	}
	return undefined;
}

type RawSecretEntry = Omit<SecretEntry, "friendlyName"> & { friendlyName?: unknown };

export {
	deobfuscateSessionContext,
	deobfuscateToolArguments,
	obfuscateMessages,
	obfuscateProviderContext,
	type SecretEntry,
	SecretObfuscator,
	secretEntriesNeedPlaceholderKey,
	secretEntryNeedsPlaceholderKey,
} from "./obfuscator";

/**
 * Load secrets from project-local and global secrets.yml files.
 * Project-local entries override global entries with matching content.
 */
export async function loadSecrets(cwd: string, agentDir: string): Promise<SecretEntry[]> {
	const projectPath = path.join(cwd, ".omp", "secrets.yml");
	const globalPath = path.join(agentDir, "secrets.yml");

	const globalEntries = await loadSecretsFile(globalPath);
	const projectEntries = await loadSecretsFile(projectPath);

	if (globalEntries.length === 0) return projectEntries;
	if (projectEntries.length === 0) return globalEntries;

	// Merge: project overrides global by content match
	const projectContents = new Set(projectEntries.map(e => e.content));
	const merged = [...globalEntries.filter(e => !projectContents.has(e.content)), ...projectEntries];
	return merged;
}

/** Minimum env var value length to consider as a secret. */
const MIN_ENV_VALUE_LENGTH = 8;

/** Env var name patterns that indicate secret values. */
const SECRET_ENV_PATTERNS = /(?:KEY|SECRET|TOKEN|PASSWORD|PASS|AUTH|CREDENTIAL|PRIVATE|OAUTH)(?:_|$)/i;

/** Collect environment variable values that look like secrets. */
export function collectEnvSecrets(): SecretEntry[] {
	const entries: SecretEntry[] = [];
	const seen = new Set<string>();
	for (const [name, value] of Object.entries(process.env)) {
		if (!value || value.length < MIN_ENV_VALUE_LENGTH) continue;
		if (!SECRET_ENV_PATTERNS.test(name)) continue;
		if (seen.has(value)) continue;
		seen.add(value);
		entries.push({ type: "plain", content: value, mode: "obfuscate" });
	}
	return entries;
}

async function loadSecretsFile(filePath: string): Promise<SecretEntry[]> {
	try {
		const text = await Bun.file(filePath).text();
		const raw = YAML.parse(text);
		if (!Array.isArray(raw)) {
			logger.warn("secrets.yml must be a YAML array", { path: filePath });
			return [];
		}
		const entries: SecretEntry[] = [];
		for (let i = 0; i < raw.length; i++) {
			const entry = raw[i];
			if (!validateEntry(entry, filePath, i)) continue;
			const friendlyName = loadFriendlyName(entry, filePath, i);
			entries.push({
				type: entry.type,
				content: entry.content,
				mode: entry.mode ?? "obfuscate",
				replacement: entry.replacement,
				flags: entry.flags,
				friendlyName,
			});
		}
		return entries;
	} catch (err) {
		if (isEnoent(err)) return [];
		logger.warn("Failed to load secrets.yml", { path: filePath, error: String(err) });
		return [];
	}
}

// Validates the friendlyName but returns it UNSANITIZED: `SecretObfuscator`'s
// own `#createPlaceholder` sanitizes it again and, critically, needs the raw
// string for `#friendlyNameCollidesWithSecret`'s regex-collision check — a
// case-sensitive/punctuated regex pattern (e.g. `tok_[a-z0-9]+`) only matches
// the label as it was actually written, not an already-uppercased,
// separator-stripped rendering of it. Pre-sanitizing here would silently
// defeat that check for every `secrets.yml`-loaded entry.
function loadFriendlyName(entry: RawSecretEntry, filePath: string, index: number): string | undefined {
	if (entry.friendlyName === undefined) return undefined;
	if (typeof entry.friendlyName !== "string") {
		logger.warn(`secrets.yml[${index}]: friendlyName must be a string`, { path: filePath });
		return undefined;
	}
	if (sanitizeSecretFriendlyName(entry.friendlyName) === undefined) {
		logger.warn(`secrets.yml[${index}]: friendlyName must contain at least one letter or digit`, { path: filePath });
		return undefined;
	}
	return entry.friendlyName;
}

function validateEntry(entry: unknown, filePath: string, index: number): entry is RawSecretEntry {
	if (entry === null || typeof entry !== "object") {
		logger.warn(`secrets.yml[${index}]: entry must be an object`, { path: filePath });
		return false;
	}
	const e = entry as Record<string, unknown>;
	if (e.type !== "plain" && e.type !== "regex") {
		logger.warn(`secrets.yml[${index}]: type must be "plain" or "regex"`, { path: filePath });
		return false;
	}
	if (typeof e.content !== "string" || e.content.length === 0) {
		logger.warn(`secrets.yml[${index}]: content must be a non-empty string`, { path: filePath });
		return false;
	}
	if (e.mode !== undefined && e.mode !== "obfuscate" && e.mode !== "replace") {
		logger.warn(`secrets.yml[${index}]: mode must be "obfuscate" or "replace"`, { path: filePath });
		return false;
	}
	if (e.replacement !== undefined && typeof e.replacement !== "string") {
		logger.warn(`secrets.yml[${index}]: replacement must be a string`, { path: filePath });
		return false;
	}
	if (e.flags !== undefined && typeof e.flags !== "string") {
		logger.warn(`secrets.yml[${index}]: flags must be a string`, { path: filePath });
		return false;
	}
	if (e.type === "regex") {
		let regex: RegExp;
		try {
			regex = compileSecretRegex(e.content as string, e.flags as string | undefined);
		} catch (error) {
			logger.warn(`secrets.yml[${index}]: invalid regex pattern`, {
				path: filePath,
				pattern: e.content,
				error: String(error),
			});
			return false;
		}
		const mode = (e.mode as "obfuscate" | "replace" | undefined) ?? "obfuscate";
		if (mode === "replace" && e.replacement === undefined && regexHasUnresolvableShortMatchFallback(regex)) {
			logger.warn(
				`secrets.yml[${index}]: regex matches every 1-2 character candidate with no custom replacement, so a match can never be redacted distinctly from itself`,
				{ path: filePath, pattern: e.content },
			);
			return false;
		}
	}
	return true;
}
