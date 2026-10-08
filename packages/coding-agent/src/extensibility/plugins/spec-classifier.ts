/**
 * Install spec classification for the plugin manager.
 *
 * Reads a spec string into the form the installer will hand to `bun install`,
 * before any package manager runs. Four forms exist: a registry package name
 * (optionally with a version or range), a git source, a tarball (local archive
 * or HTTP URL), and a local directory path. The distinction is load-bearing:
 * only registry and tarball specs carry a name bun can resolve from the spec
 * itself, a git spec resolves its name after install, and a local path is
 * resolved from the directory that follows the symlink.
 *
 * Local paths must be absolute. A relative path would resolve against the
 * plugins directory, not against whatever directory the person was standing in,
 * and a spec typed into a GUI text field has no meaningful working directory to
 * resolve against.
 *
 * The classifier never touches the filesystem; a path that does not exist still
 * classifies as `path` and fails later at install with the package manager's own
 * diagnostic.
 *
 * @module extensibility/plugins/spec-classifier
 */

import { isAbsolute } from "node:path";

/** One install spec read into its form and the parts an install needs. */
export type InstallSpecKind = "registry" | "git" | "tarball" | "path";

export type ParsedInstallSpec =
	| { readonly kind: "registry"; readonly spec: string; readonly name: string; readonly range?: string }
	| {
			readonly kind: "git";
			readonly spec: string;
			readonly repo: string;
			readonly ref?: string;
			readonly host: string;
	  }
	| {
			readonly kind: "tarball";
			readonly spec: string;
			/** Absolute archive path, for a `file:` tarball. */
			readonly path?: string;
			/** Host bun fetches an HTTP tarball from. */
			readonly host?: string;
	  }
	| { readonly kind: "path"; readonly spec: string; readonly path: string };

/** A spec no package manager would take; `reason` is what the reader sees. */
export class InvalidInstallSpecError extends Error {
	constructor(
		readonly spec: string,
		readonly reason: string,
	) {
		super(`plugin spec: ${reason}: ${spec}`);
		this.name = "InvalidInstallSpecError";
	}
}

function invalid(spec: string, reason: string): InvalidInstallSpecError {
	return new InvalidInstallSpecError(spec, reason);
}

/** Shorthand hosts pnpm and bun both expand for a git spec. */
const GIT_SHORTHAND_HOSTS: Readonly<Record<string, string>> = {
	github: "github.com",
	gitlab: "gitlab.com",
	bitbucket: "bitbucket.org",
	codeberg: "codeberg.org",
	srht: "git.sr.ht",
	sourcehut: "git.sr.ht",
	gist: "gist.github.com",
};

const GIT_SHORTHAND = /^(?:github|gitlab|bitbucket|codeberg|srht|sourcehut|gist):/i;
const GIT_URL = /^git(?:\+[a-z]+)?:\/\/|^git@[^:]+:/i;

/**
 * Whether an http(s) URL names a repository rather than a web page.
 *
 * The shape is a host, an owner, a repository, and then nothing this host would
 * mistake for anything else. A forge's own browse path is allowed after the
 * repository (`tree`, `blob`, `commit`, `releases`, `raw`, `archive`), because a
 * person pasting `…/owner/repo/tree/main` means the repository. Any other
 * trailing segment means the URL is a page: `https://example.com/docs/intro` has
 * exactly the segment count of a repository URL, so counting segments cannot
 * tell them apart, and reading it as a repository would start a clone that can
 * only fail.
 */
const FORGE_BROWSE_SEGMENT = /^(?:tree|blob|commits?|releases|raw|archive|src|branch|tags?)$/;

/**
 * Hosts whose `owner/repository` URLs are unambiguous.
 *
 * A three-segment URL is indistinguishable between `github.com/owner/repo` and
 * `example.com/docs/intro` — same shape, different meaning. Segment counting
 * cannot separate them, so a bare three-segment URL is only read as a
 * repository when the host is one whose URLs are repositories by construction. A
 * person with a repository on some other host can always say so unambiguously
 * with the `https://host/owner/repo.git` form, which carries its own marker.
 */
const REPOSITORY_HOSTS: ReadonlySet<string> = new Set([
	"github.com",
	"www.github.com",
	"gitlab.com",
	"bitbucket.org",
	"codeberg.org",
	"git.sr.ht",
	"gitee.com",
	"gitcode.com",
]);

function isHostedRepositoryUrl(spec: string): boolean {
	let rest = spec;
	const hash = rest.indexOf("#");
	if (hash !== -1) rest = rest.slice(0, hash);
	const schemeEnd = rest.indexOf("://");
	if (schemeEnd === -1) return false;
	const [host, ...segments] = rest
		.slice(schemeEnd + 3)
		.split("/")
		.filter(Boolean);
	// host / owner / repository, and nothing more.
	if (host === undefined || segments.length < 2) return false;
	const repository = segments[1] as string;
	// An explicit `.git` suffix is a repository marker on any host.
	if (repository.endsWith(".git")) return true;
	if (segments.length === 2) return REPOSITORY_HOSTS.has(host.toLowerCase());
	// A longer path is only a repository when every segment past the
	// repository name is the forge's own browse vocabulary.
	return segments.slice(2).every(segment => FORGE_BROWSE_SEGMENT.test(segment));
}

/** An archive bun can install from, on disk or over HTTP. */
const TARBALL_SPEC = /\.(?:tgz|tar\.gz|tar|zip)(?:#.*)?$/i;

/**
 * An npm package name: lowercase URL-safe segments, one optional scope, and no
 * leading dot or underscore. A leading `@` that is not a scope separator is the
 * version marker (`name@1.2.3`), not a scope.
 */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const PACKAGE_NAME_MAX_LENGTH = 214;

/** Strip a `file:`/`link:` prefix, returning the payload unchanged when absent. */
function stripFilePrefix(spec: string): string {
	return spec.replace(/^(?:file|link):/, "");
}

/** The host a git spec resolves to, from its shorthand, scp form, or URL. */
function gitHost(spec: string): string {
	const shorthand = /^([a-z]+):/i.exec(spec)?.[1]?.toLowerCase();
	if (shorthand !== undefined && Object.hasOwn(GIT_SHORTHAND_HOSTS, shorthand)) {
		return GIT_SHORTHAND_HOSTS[shorthand] as string;
	}
	const scp = /^git@([^:]+):/i.exec(spec)?.[1];
	if (scp !== undefined) return scp.toLowerCase();
	return new URL(spec.replace(/^git\+/i, "")).host;
}

/** Split a repository URL into its repo and optional ref, dropping a `.git` suffix. */
function splitRepoRef(url: string): { repo: string; ref?: string } {
	const hash = url.indexOf("#");
	if (hash === -1) return { repo: url };
	return { repo: url.slice(0, hash), ref: url.slice(hash + 1) || undefined };
}

/**
 * Read a plugin install spec into its form.
 *
 * @param raw - the spec as typed or pasted.
 * @returns the parsed spec.
 * @throws {InvalidInstallSpecError} for an empty spec, a relative path, a name
 * no registry would accept, or a URL that is neither a repository nor an archive.
 */
export function parseInstallSpec(raw: string): ParsedInstallSpec {
	const spec = raw.trim();
	if (spec === "") throw invalid(spec, "the plugin spec must not be empty");

	// A `file:`/`link:` prefix or an absolute path is a local source. It is
	// classified before the git and registry branches because a Windows path
	// (`C:\…`) and a repository URL can look alike to the shorthand patterns.
	const path = stripFilePrefix(spec);
	if (path !== spec || isAbsolute(path)) {
		if (!isAbsolute(path)) throw invalid(spec, "a local path must be absolute");
		return TARBALL_SPEC.test(path) ? { kind: "tarball", spec, path } : { kind: "path", spec, path };
	}
	if (/^\.{1,2}(?:[\\/]|$)/.test(spec)) throw invalid(spec, "a local path must be absolute");

	// An archive over HTTP. Checked before the repository-URL branch so a
	// `.tgz` download is never mistaken for a repository.
	if (/^https?:\/\//i.test(spec) && TARBALL_SPEC.test(spec)) {
		return { kind: "tarball", spec, host: new URL(spec).host };
	}

	const isGit = GIT_SHORTHAND.test(spec) || GIT_URL.test(spec) || isHostedRepositoryUrl(spec);
	if (isGit && !TARBALL_SPEC.test(spec)) {
		if (SHELL_METACHAR.test(spec)) throw invalid(spec, "invalid characters in plugin source");
		const host = gitHost(spec);
		const { repo, ref } = splitRepoRef(spec);
		return ref === undefined ? { kind: "git", spec, repo, host } : { kind: "git", spec, repo, ref, host };
	}

	if (/^https?:\/\//i.test(spec)) {
		throw invalid(spec, "a URL must point at a git repository or a tarball");
	}

	// `npm:<name>` — the package manager's own alias spelling, meaning "this
	// name, from the registry". Accepted because a person copying an install
	// command out of a README or another tool's output gets this form, and
	// rejecting it reports the package as malformed when it is not.
	//
	// `name` carries the bare package name because that is what the dependency
	// map is keyed by; the original spec is preserved so the install command
	// passes the alias through unchanged rather than rewriting it into a
	// different resolution.
	const aliased = /^npm:(?=\S)/i.exec(spec);
	const bare = aliased === null ? spec : spec.slice(aliased[0].length);

	const at = bare.indexOf("@", 1);
	const name = at === -1 ? bare : bare.slice(0, at);
	const range = at === -1 ? undefined : bare.slice(at + 1);
	if (name.length > PACKAGE_NAME_MAX_LENGTH || !PACKAGE_NAME.test(name)) {
		throw invalid(spec, "not a package name the registry accepts");
	}
	if (range === "") throw invalid(spec, "a version after @ must not be empty");
	return range === undefined ? { kind: "registry", spec, name } : { kind: "registry", spec, name, range };
}

/**
 * Characters that are never valid in a git spec. `Bun.spawn` does not invoke a
 * shell, so this is defense in depth for readers who assume a shell is involved;
 * the same denylist lives in the plugin manager for the specs it validates.
 */
const SHELL_METACHAR = /[;&|`$(){}<>\\\n\r\t]/;

/**
 * The spec to hand `bun install`, and whether bun resolves the package name from
 * the spec itself.
 *
 * A tarball or path spec keeps its `file:` prefix so bun records the source in
 * `plugins/package.json` as a link rather than as a registry version, which is
 * what makes a later uninstall and reinstall point back at the same directory.
 */
export function installSpecFor(parsed: ParsedInstallSpec): {
	installSpec: string;
	/** Whether the spec itself names the package, so no post-install diff is needed. */
	specNamesPackage: boolean;
} {
	switch (parsed.kind) {
		case "registry":
			return { installSpec: parsed.spec, specNamesPackage: true };
		case "git":
			return { installSpec: parsed.spec, specNamesPackage: false };
		case "tarball":
			return {
				installSpec: parsed.path !== undefined ? `file:${parsed.path}` : parsed.spec,
				specNamesPackage: false,
			};
		case "path":
			return { installSpec: `file:${parsed.path}`, specNamesPackage: false };
	}
}
