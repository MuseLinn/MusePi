/**
 * `~/.ssh/config` recognition — the hosts a user already configured for
 * ssh(1), made visible beside the ones MusePi manages itself.
 *
 * Two catalogs exist for one question ("which ssh hosts can this machine
 * reach"): MusePi's managed `ssh.json` and the user's OpenSSH config. They were
 * separate surfaces, so a host the user had configured for ssh(1) was invisible
 * in both the instance form and the workspace wizard. This module is the one
 * parser and the one merge, so both surfaces read the same answer.
 *
 * Precedence is stated once ({@link mergeHostCatalog}): a MusePi entry wins on
 * a name collision, because that entry is the one carrying MusePi's own
 * settings (a key path, a compat flag) and silently replacing it with a
 * neighbouring `Host` block would change what `musepi ssh` connects to. The
 * ssh config fills everything else, including hosts MusePi never heard of.
 *
 * What is deliberately not modelled: wildcard and negated `Host` patterns
 * (`Host *.example.com`, `Host !bad`) never become rows — a row has to name one
 * destination a tunnel can dial. Their directives still contribute defaults
 * only when the block is a plain global block, which is how OpenSSH treats
 * directives before the first `Host`; a wildcard block's overrides are left to
 * ssh itself rather than guessed at.
 */

import type { ConnectionTarget } from "./targets";

/** One host as an OpenSSH config block describes it. */
export interface SshConfigHost {
	/** The `Host` alias the user types. */
	name: string;
	/** `HostName`, or the alias itself when the block omits it. */
	host: string;
	username?: string;
	port?: number;
	keyPath?: string;
	/** `ProxyJump` chain as written (`bastion`, `a,b`, `user@jump:22`). */
	proxyJump?: string;
}

/** One config document: a file and the text read from it. */
export interface SshConfigDocument {
	path: string;
	text: string;
}

/** Defaults a global block (directives before the first `Host`) supplies. */
interface GlobalDefaults {
	username?: string;
	port?: number;
	keyPath?: string;
}

/**
 * Split one directive line into keyword and value.
 *
 * OpenSSH accepts `Key value` and `Key=value`, with the keyword
 * case-insensitive. A `#` starts a comment anywhere, and an empty value is
 * not a directive.
 */
function splitDirective(line: string): { key: string; value: string } | null {
	const comment = line.indexOf("#");
	const body = (comment === -1 ? line : line.slice(0, comment)).trim();
	if (!body) return null;
	const equals = body.indexOf("=");
	const space = body.search(/\s/);
	const split = equals !== -1 && (space === -1 || equals < space) ? equals : space;
	if (split === -1) return { key: body.toLowerCase(), value: "" };
	const key = body.slice(0, split).trim().toLowerCase();
	// `Key = value` and `Key=value` are both legal; only the separator is
	// consumed, so a value that legitimately starts with `=` survives.
	let value = body.slice(split).trim();
	if (value.startsWith("=")) value = value.slice(1).trim();
	return { key, value };
}

/** Is this `Host` pattern one concrete destination rather than a matcher? */
function isConcretePattern(pattern: string): boolean {
	if (!pattern || pattern.startsWith("!")) return false;
	return !/[*?]/.test(pattern);
}

function parsePort(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const port = Number.parseInt(value, 10);
	return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

/**
 * Parse the concatenation of the documents in the order the reader expanded
 * them (the main file first, `Include`d files where their directive appeared).
 *
 * A directive that is not recognised is ignored rather than fatal: the file is
 * the user's, and a keyword this build does not model (`ForwardAgent`,
 * `ServerAliveInterval`) must not cost them the hosts around it.
 */
export function parseSshConfig(documents: readonly SshConfigDocument[]): SshConfigHost[] {
	const hosts: SshConfigHost[] = [];
	const seen = new Set<string>();
	const defaults: GlobalDefaults = {};
	let current: {
		names: string[];
		host?: string;
		username?: string;
		port?: number;
		keyPath?: string;
		proxyJump?: string;
	} | null = null;

	const flush = (): void => {
		if (!current) return;
		for (const name of current.names) {
			if (!isConcretePattern(name) || seen.has(name)) continue;
			seen.add(name);
			const host: SshConfigHost = {
				name,
				host: current.host ?? name,
			};
			const username = current.username ?? defaults.username;
			const port = current.port ?? defaults.port;
			const keyPath = current.keyPath ?? defaults.keyPath;
			if (username) host.username = username;
			if (port) host.port = port;
			if (keyPath) host.keyPath = keyPath;
			if (current.proxyJump) host.proxyJump = current.proxyJump;
			hosts.push(host);
		}
		current = null;
	};

	for (const document of documents) {
		for (const rawLine of document.text.split(/\r?\n/)) {
			const directive = splitDirective(rawLine);
			if (!directive) continue;
			const { key, value } = directive;
			if (key === "host") {
				flush();
				const names = value.split(/\s+/).filter(Boolean);
				current = names.length > 0 ? { names } : null;
				continue;
			}
			// Directives before the first `Host` are OpenSSH's global defaults.
			const target = current;
			switch (key) {
				case "hostname":
					if (target) target.host = value || undefined;
					break;
				case "user":
					if (target) target.username = value || undefined;
					else defaults.username = value || undefined;
					break;
				case "port":
					if (target) target.port = parsePort(value);
					else defaults.port = parsePort(value);
					break;
				case "identityfile":
					// Only the first key is carried: a target row has one key path,
					// and ssh itself still tries the rest when it dials the alias.
					if (target) target.keyPath ??= value || undefined;
					else defaults.keyPath ??= value || undefined;
					break;
				case "proxyjump":
					if (target) target.proxyJump = value || undefined;
					break;
				default:
					break;
			}
		}
	}
	flush();
	return hosts;
}

/** The daemon-port-shaped fields a catalog host shares with a target row. */
export interface HostCatalogEntry {
	name: string;
	host: string;
	username?: string;
	port?: number;
	keyPath?: string;
	proxyJump?: string;
	/** Which catalog the row came from; the merge never reorders on it. */
	source: "musepi" | "ssh-config";
}

/**
 * Merge the two catalogs into the one list both surfaces show.
 *
 * A MusePi (`ssh.json`) entry wins a name collision and keeps its own fields;
 * ssh-config hosts fill the remaining names in their file order. Duplicate
 * names are dropped so a row can never appear twice with different addresses.
 */
export function mergeHostCatalog(
	musepi: readonly SshConfigHost[],
	sshConfig: readonly SshConfigHost[],
): HostCatalogEntry[] {
	const entries: HostCatalogEntry[] = [];
	const seen = new Set<string>();
	for (const host of musepi) {
		if (seen.has(host.name)) continue;
		seen.add(host.name);
		entries.push({ ...host, source: "musepi" });
	}
	for (const host of sshConfig) {
		if (seen.has(host.name)) continue;
		seen.add(host.name);
		entries.push({ ...host, source: "ssh-config" });
	}
	return entries;
}

/** The `user@host` destination a tunnel dials for one catalog entry. */
export function hostDestination(entry: SshConfigHost): string {
	return entry.username ? `${entry.username}@${entry.host}` : entry.host;
}

/**
 * The catalog entry a stored target's `sshHost` names, if any.
 *
 * A target keeps the raw `user@host` the user typed, so an entry is matched
 * either by its alias or by the destination it resolves to — a row added from
 * the catalog before the catalog changed must still find its facts.
 */
export function catalogEntryFor(
	target: ConnectionTarget,
	catalog: readonly HostCatalogEntry[],
): HostCatalogEntry | null {
	if (!target.sshHost) return null;
	const destination = target.sshHost.trim();
	return (
		catalog.find(entry => entry.name === destination) ??
		catalog.find(entry => hostDestination(entry) === destination) ??
		catalog.find(entry => entry.host === destination) ??
		null
	);
}
