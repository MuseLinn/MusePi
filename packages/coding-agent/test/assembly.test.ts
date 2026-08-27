/**
 * Tests for the assembly layer: manifest parsing/validation, extension
 * load verification (managed fail-loud vs unmanaged soft), extension path
 * filtering, surface mapping, and terminal provider selection.
 *
 * Pure unit tests — no pi runtime, no model quota.
 */

import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { surfaceFromMode } from "@musepi/pi-coding-agent/assembly";
import { AssemblyManifestError, loadAssemblyManifest } from "@musepi/pi-coding-agent/assembly/manifest";
import type { AssemblyManifest } from "@musepi/pi-coding-agent/assembly/types";
import { filterExtensionPaths, verifyExtensionLoad } from "@musepi/pi-coding-agent/assembly/verify";
import { isTerminalProvider, resolveTerminalProvider } from "@musepi/pi-coding-agent/daemon/terminal-provider";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "assembly-test-"));
const home = path.join(tmp, "home");
fs.mkdirSync(home, { recursive: true });

afterAll(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

/** A manifest with a valid surface + seams for use in filter/verify tests. */
const baseManifest: AssemblyManifest = {
	surface: null,
	degradedOk: false,
	extensions: { include: [], exclude: [], patterns: [] },
	seams: {},
};

describe("manifest parsing", () => {
	it("returns null when no manifest exists", async () => {
		expect(await loadAssemblyManifest(tmp, home)).toBeNull();
	});

	it("parses a project manifest with seams", async () => {
		const projDir = path.join(tmp, "proj");
		fs.mkdirSync(path.join(projDir, ".musepi"), { recursive: true });
		fs.writeFileSync(
			path.join(projDir, ".musepi", "assembly.toml"),
			[
				"[assembly]",
				'surface = "tui"',
				"degraded_ok = true",
				"",
				"[extensions]",
				'include = ["my-ext", "other"]',
				'exclude = ["*debug*"]',
				"",
				"[seams.terminal]",
				'provider = "node-pty"',
				"",
				"[seams.compaction]",
				'method = "snapcompact"',
			].join("\n"),
		);
		const m = await loadAssemblyManifest(projDir, home);
		expect(m).not.toBeNull();
		expect(m!.surface).toBe("tui");
		expect(m!.degradedOk).toBe(true);
		expect(m!.extensions.include).toEqual(["my-ext", "other"]);
		expect(m!.seams.terminal?.provider).toBe("node-pty");
		expect(m!.seams.compaction?.method).toBe("snapcompact");
	});

	it("throws on unknown seam section", async () => {
		const badDir = path.join(tmp, "bad");
		fs.mkdirSync(path.join(badDir, ".musepi"), { recursive: true });
		fs.writeFileSync(path.join(badDir, ".musepi", "assembly.toml"), '[seams.nonexistent]\nfoo = "bar"\n');
		await expect(loadAssemblyManifest(badDir, home)).rejects.toBeInstanceOf(AssemblyManifestError);
	});

	it("throws on invalid terminal provider", async () => {
		const badDir = path.join(tmp, "bad2");
		fs.mkdirSync(path.join(badDir, ".musepi"), { recursive: true });
		fs.writeFileSync(path.join(badDir, ".musepi", "assembly.toml"), '[seams.terminal]\nprovider = "telnet"\n');
		await expect(loadAssemblyManifest(badDir, home)).rejects.toBeInstanceOf(AssemblyManifestError);
	});

	it("throws on invalid compaction method", async () => {
		const badDir = path.join(tmp, "bad3");
		fs.mkdirSync(path.join(badDir, ".musepi"), { recursive: true });
		fs.writeFileSync(path.join(badDir, ".musepi", "assembly.toml"), '[seams.compaction]\nmethod = "bogus"\n');
		await expect(loadAssemblyManifest(badDir, home)).rejects.toBeInstanceOf(AssemblyManifestError);
	});

	it("applies the global manifest when no project manifest exists", async () => {
		fs.mkdirSync(path.join(home, ".musepi"), { recursive: true });
		fs.writeFileSync(path.join(home, ".musepi", "assembly.toml"), '[assembly]\nsurface = "headless"\n');
		const m = await loadAssemblyManifest(path.join(tmp, "no-proj"), home);
		expect(m?.surface).toBe("headless");
	});
});

describe("extension load verification", () => {
	function fakeSettings(disabledExtensions: string[] = []) {
		return {
			get(key: string) {
				if (key === "disabledExtensions") return disabledExtensions;
				return undefined;
			},
		};
	}

	function fakeLoadResult(extensions: unknown[] = [], errors: Array<{ path: string; error: string }> = []) {
		return {
			extensions,
			errors,
			runtime: {},
		} as never as import("../src/extensibility/extensions/types.ts").LoadExtensionsResult;
	}

	it("no manifest: all errors are warnings, report ok", () => {
		const report = verifyExtensionLoad(
			fakeLoadResult([], [{ path: "/tmp/broken/index.ts", error: "boom" }]),
			null,
			"tui",
		);
		expect(report.ok).toBe(true);
		expect(report.fatalIssues).toHaveLength(0);
		expect(report.warnings).toHaveLength(1);
	});

	it("manifest: managed extension errors are fatal, unmanaged are warnings", () => {
		const manifest: AssemblyManifest = {
			...baseManifest,
			extensions: { include: ["broken"], exclude: [], patterns: [] },
		};
		const report = verifyExtensionLoad(
			fakeLoadResult(
				[],
				[
					{ path: "/tmp/broken/index.ts", error: "boom" }, // id = "broken"
					{ path: "/tmp/other/index.ts", error: "nope" }, // id = "other"
				],
			),
			manifest,
			"tui",
		);
		expect(report.ok).toBe(false);
		expect(report.fatalIssues).toHaveLength(1);
		expect(report.fatalIssues[0]!.id).toBe("broken");
		expect(report.warnings).toHaveLength(1);
		expect(report.warnings[0]!.id).toBe("other");
	});

	it("degraded_ok=true turns managed errors into warnings", () => {
		const manifest: AssemblyManifest = {
			...baseManifest,
			degradedOk: true,
			extensions: { include: ["broken"], exclude: [], patterns: [] },
		};
		const report = verifyExtensionLoad(
			fakeLoadResult([], [{ path: "/tmp/broken/index.ts", error: "boom" }]),
			manifest,
			"tui",
		);
		expect(report.ok).toBe(true);
		expect(report.fatalIssues).toHaveLength(0);
		expect(report.warnings).toHaveLength(1);
	});
});

describe("extension path filtering", () => {
	function fakeSettings(disabledExtensions: string[] = []) {
		return {
			get(key: string) {
				if (key === "disabledExtensions") return disabledExtensions;
				return undefined;
			},
		};
	}

	function fakeLoadResult(extensions: unknown[] = [], errors: Array<{ path: string; error: string }> = []) {
		return {
			extensions,
			errors,
			runtime: {},
		} as never as import("../src/extensibility/extensions/types.ts").LoadExtensionsResult;
	}

	const paths = ["/tmp/a/index.ts", "/tmp/b/index.ts", "/tmp/c/index.ts"];

	it("include whitelist keeps only listed ids", () => {
		const manifest: AssemblyManifest = {
			...baseManifest,
			extensions: { include: ["a"], exclude: [], patterns: [] },
		};
		const filtered = filterExtensionPaths(paths, manifest, fakeSettings() as never);
		expect(filtered).toHaveLength(1);
		expect(filtered[0]).toContain("/tmp/a/");
	});

	it("settings.disabledExtensions applies without a manifest", () => {
		const filtered = filterExtensionPaths(paths, null, fakeSettings(["b"]) as never);
		expect(filtered).toHaveLength(2);
		expect(filtered.some(p => p.includes("/tmp/b/"))).toBe(false);
	});

	it("exclude glob removes matching ids", () => {
		const manifest: AssemblyManifest = {
			...baseManifest,
			extensions: { include: [], exclude: ["*b*"], patterns: [] },
		};
		const filtered = filterExtensionPaths(paths, manifest, fakeSettings() as never);
		expect(filtered).toHaveLength(2);
		expect(filtered.some(p => p.includes("/tmp/b/"))).toBe(false);
	});
});

describe("surface mapping", () => {
	it("maps internal modes to surfaces", () => {
		expect(surfaceFromMode(undefined, true)).toBe("tui");
		expect(surfaceFromMode("rpc-ui", true)).toBe("daemon");
		expect(surfaceFromMode("rpc", false)).toBe("headless");
		expect(surfaceFromMode("acp", false)).toBe("headless");
	});
});

describe("terminal provider selection", () => {
	function fakeSettings(raw: string | undefined) {
		return { getRaw: () => raw } as never;
	}

	it("manifest wins over settings", () => {
		expect(resolveTerminalProvider(fakeSettings("bun-pty"), "node-pty")).toBe("node-pty");
	});
	it("settings raw applies when no manifest", () => {
		expect(resolveTerminalProvider(fakeSettings("bun-pty"), null)).toBe("bun-pty");
	});
	it("defaults to auto", () => {
		expect(resolveTerminalProvider(fakeSettings(undefined), null)).toBe("auto");
	});
	it("validates provider names", () => {
		expect(isTerminalProvider("node-pty")).toBe(true);
		expect(isTerminalProvider("telnet")).toBe(false);
	});
});
