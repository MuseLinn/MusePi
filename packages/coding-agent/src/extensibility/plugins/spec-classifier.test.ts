import { describe, expect, it } from "bun:test";
import { InvalidInstallSpecError, installSpecFor, parseInstallSpec } from "./spec-classifier";

/**
 * The classifier decides which branch of the install runs, and each branch has a
 * different way of finding the installed package's name. These cases pin the
 * branch selection and the two failure modes that would otherwise reach the
 * package manager: a spec that is not a package name at all, and a local path
 * that cannot be resolved.
 */
describe("parseInstallSpec", () => {
	it("reads a bare package name as a registry spec whose own text names the package", () => {
		const parsed = parseInstallSpec("my-plugin");
		expect(parsed).toEqual({ kind: "registry", spec: "my-plugin", name: "my-plugin" });
		// The install takes the name from the spec instead of diffing package.json,
		// which is the only reason this distinction exists.
		expect(installSpecFor(parsed).specNamesPackage).toBe(true);
	});

	it("separates a scoped package's name from its version", () => {
		const parsed = parseInstallSpec("@scope/plugin@1.2.3");
		expect(parsed).toEqual({
			kind: "registry",
			spec: "@scope/plugin@1.2.3",
			name: "@scope/plugin",
			range: "1.2.3",
		});
	});

	it("reads a git shorthand as a git spec carrying its host and ref", () => {
		const parsed = parseInstallSpec("github:owner/repo#v1.2.0");
		expect(parsed).toEqual({
			kind: "git",
			spec: "github:owner/repo#v1.2.0",
			repo: "github:owner/repo",
			ref: "v1.2.0",
			host: "github.com",
		});
		// A git spec names no package, so the name can only come from the
		// post-install dependency diff.
		expect(installSpecFor(parsed).specNamesPackage).toBe(false);
	});

	it("classifies a Windows absolute directory as a local path, not a registry name", () => {
		// A drive letter is what makes this worth pinning: `C:` matches the
		// shorthand pattern, so an earlier check would call it a git source.
		const parsed = parseInstallSpec("C:\\Users\\me\\plugins\\mine");
		expect(parsed).toEqual({
			kind: "path",
			spec: "C:\\Users\\me\\plugins\\mine",
			path: "C:\\Users\\me\\plugins\\mine",
		});
		expect(installSpecFor(parsed).installSpec).toBe("file:C:\\Users\\me\\plugins\\mine");
	});

	it("classifies a local archive as a tarball and keeps the file: prefix for the install", () => {
		const parsed = parseInstallSpec("/home/me/pkg.tgz");
		expect(parsed.kind).toBe("tarball");
		// The `file:` prefix is what makes bun record a link rather than a
		// registry version, so a later uninstall and reinstall point at the
		// same archive.
		expect(installSpecFor(parsed).installSpec).toBe("file:/home/me/pkg.tgz");
	});

	it("classifies an https archive as a tarball, not a repository", () => {
		const parsed = parseInstallSpec("https://example.com/pkg-1.0.0.tgz");
		expect(parsed).toEqual({
			kind: "tarball",
			spec: "https://example.com/pkg-1.0.0.tgz",
			host: "example.com",
		});
		// A remote tarball is fetched by the package manager itself, so the spec
		// passes through untouched.
		expect(installSpecFor(parsed).installSpec).toBe("https://example.com/pkg-1.0.0.tgz");
	});

	it("refuses a relative path rather than resolving it against the plugins directory", () => {
		// The person typing a spec has no working directory in a GUI field, so a
		// relative path would silently point somewhere they did not mean.
		expect(() => parseInstallSpec("./pkg")).toThrow(InvalidInstallSpecError);
		expect(() => parseInstallSpec("../pkg")).toThrow(/must be absolute/);
	});

	it("refuses an https URL that is neither a repository nor an archive", () => {
		expect(() => parseInstallSpec("https://example.com/some/page")).toThrow(/git repository or a tarball/);
	});

	it("reads a three-segment URL on a known forge host as a repository", () => {
		// The same three segments as the refused URL above; the host is what
		// separates a repository from a web page.
		const parsed = parseInstallSpec("https://github.com/owner/repo");
		expect(parsed.kind).toBe("git");
		if (parsed.kind !== "git") throw new Error("expected a git spec");
		expect(parsed.host).toBe("github.com");
	});

	it("reads an explicitly marked repository on an unknown host", () => {
		// A host outside the known list can still say so: the `.git` suffix is
		// the marker, and refusing it would lock out self-hosted forges.
		const parsed = parseInstallSpec("https://git.example.internal/team/tool.git");
		expect(parsed.kind).toBe("git");
		if (parsed.kind !== "git") throw new Error("expected a git spec");
		expect(parsed.repo).toBe("https://git.example.internal/team/tool.git");
	});

	it("refuses a spec that is not a package name", () => {
		expect(() => parseInstallSpec("Not A Package")).toThrow(/registry accepts/);
		expect(() => parseInstallSpec("")).toThrow(/must not be empty/);
	});

	it("refuses a shell metacharacter in a git spec", () => {
		expect(() => parseInstallSpec("github:owner/repo;rm -rf /")).toThrow(/invalid characters/);
	});
});
