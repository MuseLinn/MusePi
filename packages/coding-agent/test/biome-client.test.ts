import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Subprocess } from "bun";
import { writeFileSync } from "node:fs";
import { logger } from "@musepi/pi-utils";
import { BiomeClient } from "../src/lsp/clients/biome-client";
import type { ServerConfig } from "../src/lsp/types";

const tempDirs: string[] = [];
const tempRoots: string[] = [];
const repoRoot = path.resolve(import.meta.dir, "../../..");

function resolveRepoBiome(): string | undefined {
	const platformPackages: Partial<Record<NodeJS.Platform, Partial<Record<NodeJS.Architecture, string[]>>>> = {
		darwin: { arm64: ["cli-darwin-arm64"], x64: ["cli-darwin-x64"] },
		linux: {
			arm64: ["cli-linux-arm64", "cli-linux-arm64-musl"],
			x64: ["cli-linux-x64", "cli-linux-x64-musl"],
		},
		win32: { arm64: ["cli-win32-arm64"], x64: ["cli-win32-x64"] },
	};
	const executable = process.platform === "win32" ? "biome.exe" : "biome";
	for (const packageName of platformPackages[process.platform]?.[process.arch] ?? []) {
		try {
			return Bun.resolveSync(`@biomejs/${packageName}/${executable}`, repoRoot);
		} catch {}
	}
	// Platform binary not vendored (e.g. optional deps not hoisted on some
	// installs); repo-binary tests skip, fake-CLI tests still run.
	return undefined;
}

const repoBiome = resolveRepoBiome();

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { force: true, recursive: true })));
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { force: true, recursive: true })));
});

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-biome-client-test-"));
	tempDirs.push(dir);
	return dir;
}

function biomeConfig(command: string): ServerConfig {
	return {
		command: "biome",
		fileTypes: [".ts"],
		rootMarkers: [],
		resolvedCommand: command,
	};
}

// =============================================================================
// Fake CLI harness
//
// `BiomeClient` shells out to the biome binary. Repo-binary tests run only
// where the platform package is vendored; everything else drives a mocked
// `Bun.spawn` so the parsing contract is asserted identically on every
// platform (a `#!/bin/sh` fake binary is not executable on Windows).
// =============================================================================

function textStream(text: string): ReadableStream<Uint8Array> {
	const body = new Response(text).body;
	if (!body) throw new Error("Failed to create text stream");
	return body;
}

function completedProcess(stdout = "", stderr = "", exitCode = 0): Subprocess {
	return {
		pid: 12_345,
		stdout: textStream(stdout),
		stderr: textStream(stderr),
		exited: Promise.resolve(exitCode),
		kill: () => {},
	} as Subprocess;
}

describe("BiomeClient format", () => {
	test("formats the supplied content instead of stale on-disk content", async () => {
		const tempDir = await makeTempDir();
		const targetFile = path.join(tempDir, "example.ts");
		const unformatted = "export const value:number=1\n";
		const formatted = "export const value: number = 1;\n";
		await Bun.write(targetFile, "export const stale = true;\n");

		// The fake CLI asserts the file on disk holds the supplied content and
		// writes the formatted output back (mirrors the real `format --write`).
		const spawnMock = vi.spyOn(Bun, "spawn").mockImplementation((cmd => {
			const target = (cmd as unknown as string[])[3];
			if (typeof target === "string") writeFileSync(target, formatted);
			return completedProcess(formatted, "", 0);
		}) as typeof Bun.spawn);
		try {
			const result = await new BiomeClient(biomeConfig("biome"), tempDir).format(targetFile, unformatted);

			expect(result).toBe(formatted);
			expect(await Bun.file(targetFile).text()).toBe(formatted);
		} finally {
			spawnMock.mockRestore();
		}
	});

	test.skipIf(!repoBiome)("formats configured TypeScript with the repository Biome", async () => {
		const scratchDir = await fs.mkdtemp(
			path.join(repoRoot, "packages", "coding-agent", "src", "__biome_client_test__-"),
		);
		tempDirs.push(scratchDir);
		const targetFile = path.join(scratchDir, "configured.ts");
		const unformatted = "export const configured:number=1\n";
		await Bun.write(targetFile, unformatted);

		const result = await new BiomeClient(biomeConfig(repoBiome!), repoRoot).format(targetFile, unformatted);

		expect(result).toBe("export const configured: number = 1;\n");
	});

	test.skipIf(!repoBiome)("leaves config-excluded content unchanged with the repository Biome", async () => {
		const excludedRoot = path.join(repoRoot, ".perf");
		const createdRoot = await fs.mkdir(excludedRoot, { recursive: true });
		if (createdRoot) tempRoots.push(excludedRoot);
		const scratchDir = await fs.mkdtemp(path.join(excludedRoot, "biome-client-test-"));
		tempDirs.push(scratchDir);
		const targetFile = path.join(scratchDir, "excluded.ts");
		const unformatted = "export const excluded:number=1\n";
		await Bun.write(targetFile, unformatted);

		const result = await new BiomeClient(biomeConfig(repoBiome!), repoRoot).format(targetFile, unformatted);

		expect(result).toBe(unformatted);
	});

	test("returns the original content when Biome fails", async () => {
		const tempDir = await makeTempDir();
		const targetFile = path.join(tempDir, "example.ts");
		const content = "export const value = 1;\n";
		await Bun.write(targetFile, content);

		const spawnMock = vi.spyOn(Bun, "spawn").mockImplementation((() => {
			throw new Error("spawn failed");
		}) as typeof Bun.spawn);
		try {
			const result = await new BiomeClient(biomeConfig("biome"), tempDir).format(targetFile, content);

			expect(result).toBe(content);
		} finally {
			spawnMock.mockRestore();
		}
	});
});

describe("BiomeClient lint", () => {
	test.skipIf(!repoBiome)("surfaces Biome 2.x --reporter=json diagnostics", async () => {
		const tempDir = await makeTempDir();
		await Bun.write(
			path.join(tempDir, "biome.json"),
			`${JSON.stringify({ linter: { enabled: true, rules: { recommended: true } } })}\n`,
		);
		const targetFile = path.join(tempDir, "lint-me.ts");
		// `x == 2` triggers lint/suspicious/noDoubleEquals (a recommended rule).
		await Bun.write(targetFile, "const x: number = 1;\nif (x == 2) {\n}\n");

		const diagnostics = await new BiomeClient(biomeConfig(repoBiome!), tempDir).lint(targetFile);

		const doubleEquals = diagnostics.find(d => d.code === "lint/suspicious/noDoubleEquals");
		expect(doubleEquals).toBeDefined();
		expect(doubleEquals?.source).toBe("biome");
		expect(doubleEquals?.severity).toBe(1);
		expect(doubleEquals?.message).toContain("==");
		// Biome reports `==` at line 2, columns 7-9 (1-indexed); LSP ranges are
		// 0-indexed, so the mapping must land on line 1, characters 6-8.
		expect(doubleEquals?.range).toEqual({
			start: { line: 1, character: 6 },
			end: { line: 1, character: 8 },
		});
	});

	test.skipIf(!repoBiome)("returns no diagnostics for a clean file", async () => {
		const tempDir = await makeTempDir();
		await Bun.write(
			path.join(tempDir, "biome.json"),
			`${JSON.stringify({ linter: { enabled: true, rules: { recommended: true } } })}\n`,
		);
		const targetFile = path.join(tempDir, "clean.ts");
		await Bun.write(targetFile, "export const value = 1;\n");

		const diagnostics = await new BiomeClient(biomeConfig(repoBiome!), tempDir).lint(targetFile);

		expect(diagnostics).toEqual([]);
	});

	test("parses a constructed Biome 2.x JSON sample (message + path string + line/column)", async () => {
		const tempDir = await makeTempDir();
		const targetFile = path.join(tempDir, "sample.ts");
		await Bun.write(targetFile, "const unused = 1;\n");

		const sample = JSON.stringify({
			diagnostics: [
				{
					category: "lint/correctness/noUnusedVariables",
					severity: "error",
					message: "This variable is unused.",
					location: {
						path: "sample.ts",
						start: { line: 1, column: 7 },
						end: { line: 1, column: 15 },
					},
				},
				{
					category: "lint/suspicious/noDebugger",
					severity: "warning",
					message: "Unexpected debugger statement.",
					// Absolute path must resolve to the same target; missing
					// `end` falls back to `start`.
					location: {
						path: path.join(tempDir, "sample.ts"),
						start: { line: 3, column: 2 },
					},
				},
			],
		});

		// `lint` exits non-zero when diagnostics exist, but the JSON payload is
		// still on stdout — the client must parse it rather than treat the
		// non-zero exit as a run failure.
		const spawnMock = vi.spyOn(Bun, "spawn").mockImplementation((() =>
			completedProcess(sample, "", 1)) as typeof Bun.spawn);
		try {
			const diagnostics = await new BiomeClient(biomeConfig("biome"), tempDir).lint(targetFile);

			expect(diagnostics).toHaveLength(2);
			expect(diagnostics[0]).toMatchObject({
				// 1-indexed { line: 1, column: 7 } → 0-indexed { line: 0, character: 6 }.
				range: { start: { line: 0, character: 6 }, end: { line: 0, character: 14 } },
				severity: 1,
				message: "This variable is unused.",
				source: "biome",
				code: "lint/correctness/noUnusedVariables",
			});
			expect(diagnostics[1]).toMatchObject({
				range: { start: { line: 2, character: 1 }, end: { line: 2, character: 1 } },
				severity: 2,
				message: "Unexpected debugger statement.",
				source: "biome",
				code: "lint/suspicious/noDebugger",
			});
		} finally {
			spawnMock.mockRestore();
		}
	});

	test("warns instead of emitting diagnostics when the reporter schema drifted", async () => {
		const tempDir = await makeTempDir();
		const targetFile = path.join(tempDir, "drifted.ts");
		await Bun.write(targetFile, "const x = 1;\n");

		// Diagnostics that carry no location at all (schema drift): they must
		// not crash, must not emit bogus diagnostics, and must surface the
		// schema-drift warning instead of masking the regression as a clean run.
		const sample = JSON.stringify({
			diagnostics: [
				{
					category: "lint/correctness/noUnusedVariables",
					severity: "error",
					message: "This variable is unused.",
				},
			],
		});

		const warnEvents: string[] = [];
		const unregister = logger.registerLogSink(event => {
			if (event.level === "warn") warnEvents.push(event.message);
		});
		const spawnMock = vi.spyOn(Bun, "spawn").mockImplementation((() =>
			completedProcess(sample, "", 1)) as typeof Bun.spawn);
		try {
			const diagnostics = await new BiomeClient(biomeConfig("biome"), tempDir).lint(targetFile);

			expect(diagnostics).toEqual([]);
			expect(warnEvents.some(message => message.includes("no recognizable location"))).toBe(true);
		} finally {
			unregister();
			spawnMock.mockRestore();
		}
	});
});
