/**
 * Read the user's OpenSSH config, read-only.
 *
 * The parser lives in `src/lib/connection/ssh-config.ts` (pure, testable in
 * bun); this module only does what the renderer cannot: touch the filesystem.
 * It returns the documents in the order OpenSSH itself would read them, which
 * is what makes `Include` behave like the real thing — the included file's
 * text lands where the directive appeared, not at the end.
 *
 * Two rules keep a user's file from hurting them:
 *
 *  - **Nothing is written.** Not a temp file, not a normalisation pass.
 *  - **Nothing is fatal.** A missing `~/.ssh/config` is an empty catalog (the
 *    common case on a fresh machine); an unreadable or self-referential include
 *    is skipped, and the rest of the config still loads. A malformed config
 *    therefore means "no extra hosts", never "the connection manager is
 *    broken".
 *
 * `Include` is bounded by depth *and* by a visited set, because a file that
 * includes itself (directly or through a cycle) would otherwise recurse until
 * the process dies. Globs are supported the way ssh(1) supports them, in the
 * order the shell would expand them, so a `Include config.d/*` layout keeps
 * working.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MAX_INCLUDE_DEPTH = 5;
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_DOCUMENTS = 64;

function expandTilde(value, home) {
	if (value === "~") return home;
	if (value.startsWith("~/")) return path.join(home, value.slice(2));
	return value;
}

/** Directives of one line that matter to the reader (`Include` only). */
function includeDirectives(text) {
	const includes = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const comment = rawLine.indexOf("#");
		const body = (comment === -1 ? rawLine : rawLine.slice(0, comment)).trim();
		if (!body) continue;
		const match = /^include(?:\s+|=)\s*(.+)$/i.exec(body);
		if (!match) continue;
		for (const word of match[1].split(/\s+/)) {
			if (word) includes.push(word);
		}
	}
	return includes;
}

/**
 * Expand one `Include` pattern to existing file paths, in a stable order.
 *
 * A relative pattern is resolved against the *including* file's directory,
 * then against `~/.ssh` — the two places ssh(1) looks. `*` and `?` are
 * expanded by listing the parent directory, which is enough for the layouts
 * people actually use and avoids pulling in a glob dependency.
 */
function expandInclude(pattern, includingFile, home) {
	const sshDir = path.join(home, ".ssh");
	const candidates = [];
	for (const base of [path.dirname(includingFile), sshDir]) {
		const resolved = path.isAbsolute(pattern) ? pattern : path.resolve(base, expandTilde(pattern, home));
		if (resolved === includingFile) continue;
		if (!/[*?]/.test(resolved)) {
			if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) candidates.push(resolved);
			continue;
		}
		const dir = path.dirname(resolved);
		const patternName = path.basename(resolved);
		const matcher = new RegExp(
			`^${patternName
				.split("")
				.map(char => (char === "*" ? "[^/]*" : char === "?" ? "[^/]" : char.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
				.join("")}$`,
		);
		let names = [];
		try {
			names = fs.readdirSync(dir).sort();
		} catch {
			names = [];
		}
		for (const name of names) {
			if (!matcher.test(name)) continue;
			const full = path.join(dir, name);
			try {
				if (fs.statSync(full).isFile()) candidates.push(full);
			} catch {
				// vanished between readdir and stat
			}
		}
		if (candidates.length > 0) break;
	}
	return [...new Set(candidates)];
}

function readDocument(file) {
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile() || stat.size > MAX_DOCUMENT_BYTES) return null;
		return { path: file, text: fs.readFileSync(file, "utf8") };
	} catch {
		return null;
	}
}

/**
 * Read `~/.ssh/config` and everything it includes, in ssh(1)'s order.
 *
 * Returns `[]` — not an error — when the file is absent: that is a machine
 * with no ssh config, and the catalog is simply the MusePi one.
 */
function readSshConfig(options = {}) {
	const home = options.home ?? os.homedir();
	const mainFile = options.path ?? path.join(home, ".ssh", "config");
	const visited = new Set();
	const documents = [];

	const walk = (file, depth) => {
		if (depth > MAX_INCLUDE_DEPTH || documents.length >= MAX_DOCUMENTS) return;
		const resolved = path.resolve(file);
		if (visited.has(resolved)) return;
		visited.add(resolved);
		const document = readDocument(resolved);
		if (!document) return;
		documents.push(document);
		for (const pattern of includeDirectives(document.text)) {
			for (const included of expandInclude(pattern, resolved, home)) walk(included, depth + 1);
		}
	};

	walk(mainFile, 0);
	return documents;
}

module.exports = {
	MAX_INCLUDE_DEPTH,
	expandInclude,
	includeDirectives,
	readSshConfig,
};
