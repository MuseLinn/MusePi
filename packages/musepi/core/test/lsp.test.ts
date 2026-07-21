// MusePi core — LSP 模块测试。
// 覆盖：协议 framing、ledger 去重、deferred 协调器（staleness/drain）、
// format 助手、server 检测与配置合并、client 生命周期（懒启动/复用/
// init 失败退避/idle 回收）——集成部分用 fixtures/mock-lsp-server.mjs
// 假 server 走真实 stdio JSON-RPC。
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	DeferredDiagnosticsCoordinator,
	DiagnosticsLedger,
	dedupeFormattedDiagnostics,
	encodeLspMessage,
	extractHoverText,
	fileToUri,
	formatDiagnostic,
	formatDocumentSymbols,
	getServersForFile,
	hasRootMarkers,
	LspMessageFramer,
	LspRegistry,
	mergeServerOverrides,
	normalizeLspUriKey,
	renderDeferredDiagnostics,
	resolveCommand,
	resolveLspServers,
	severityToString,
	sortDiagnostics,
	summarizeDiagnosticMessages,
	uriToFile,
	which,
} from "../src/lsp/index.ts";

const FIXTURE_SERVER = fileURLToPath(new URL("./fixtures/mock-lsp-server.mjs", import.meta.url));

function tmpdir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "musepi-lsp-test-"));
}

function mockServer(fileTypes: string[] = [".mock"]) {
	return {
		name: "mock-ls",
		command: "node-mock-ls",
		resolvedCommand: process.execPath,
		args: [FIXTURE_SERVER],
		fileTypes,
		rootMarkers: [],
		source: "override" as const,
	};
}

// =============================================================================
// protocol
// =============================================================================

describe("protocol framing", () => {
	it("round-trips a message through encode + framer", () => {
		const framer = new LspMessageFramer();
		framer.push(encodeLspMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { a: "中" } }));
		const messages = framer.drain();
		assert.equal(messages.length, 1);
		assert.deepEqual(JSON.parse(messages[0]!), { jsonrpc: "2.0", id: 1, method: "initialize", params: { a: "中" } });
	});

	it("handles split chunks and multiple messages", () => {
		const framer = new LspMessageFramer();
		const buf = Buffer.concat([
			encodeLspMessage({ jsonrpc: "2.0", id: 1, result: {} }),
			encodeLspMessage({ jsonrpc: "2.0", id: 2, result: {} }),
		]);
		framer.push(buf.subarray(0, 10));
		assert.equal(framer.drain().length, 0);
		framer.push(buf.subarray(10));
		assert.equal(framer.drain().length, 2);
	});

	it("resyncs past junk header blocks", () => {
		const framer = new LspMessageFramer();
		// A junk block terminated by \r\n\r\n with no Content-Length is dropped;
		// the well-formed frame behind it still parses.
		framer.push(Buffer.from("junk without length\r\n\r\n"));
		framer.push(encodeLspMessage({ jsonrpc: "2.0", id: 1, result: 42 }));
		const bad: string[] = [];
		const messages = framer.drain((h) => bad.push(h));
		assert.equal(messages.length, 1);
		assert.equal(JSON.parse(messages[0]!).result, 42);
		assert.ok(bad.length > 0);
	});
});

// =============================================================================
// ledger + format
// =============================================================================

describe("diagnostics ledger", () => {
	it("passes everything through on first sight, dedupes repeats", () => {
		const ledger = new DiagnosticsLedger();
		const batch = ["a.ts:1:1 [error] boom (100)", "a.ts:2:1 [warning] meh"];
		const first = ledger.reduce("/p/a.ts", batch);
		assert.equal(first.messages.length, 2);
		assert.equal(first.errored, true);
		const second = ledger.reduce("/p/a.ts", batch);
		assert.equal(second.messages.length, 0);
	});

	it("treats location changes as the same identity", () => {
		const ledger = new DiagnosticsLedger();
		ledger.reduce("/p/a.ts", ["a.ts:1:1 [error] boom"]);
		const moved = ledger.reduce("/p/a.ts", ["a.ts:5:3 [error] boom"]);
		assert.equal(moved.messages.length, 0);
	});

	it("reports fresh messages alongside known ones and resets on clean", () => {
		const ledger = new DiagnosticsLedger();
		ledger.reduce("/p/a.ts", ["a.ts:1:1 [error] boom"]);
		const mixed = ledger.reduce("/p/a.ts", ["a.ts:1:1 [error] boom", "a.ts:9:1 [error] new one"]);
		assert.deepEqual(mixed.messages, ["a.ts:9:1 [error] new one"]);
		ledger.reduce("/p/a.ts", []); // file went clean
		const again = ledger.reduce("/p/a.ts", ["a.ts:1:1 [error] boom"]);
		assert.equal(again.messages.length, 1);
	});
});

describe("format helpers", () => {
	it("sortDiagnostics orders by severity then position", () => {
		const sorted = sortDiagnostics([
			{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, severity: 2, message: "w" },
			{ range: { start: { line: 3, character: 0 }, end: { line: 3, character: 1 } }, severity: 1, message: "e2" },
			{ range: { start: { line: 0, character: 5 }, end: { line: 0, character: 6 } }, severity: 1, message: "e1" },
		]);
		assert.deepEqual(
			sorted.map((d) => d.message),
			["e1", "e2", "w"],
		);
	});

	it("formatDiagnostic renders path:line:col [severity] [source] msg (code)", () => {
		const line = formatDiagnostic(
			{
				range: { start: { line: 11, character: 4 }, end: { line: 11, character: 5 } },
				severity: 1,
				source: "ts",
				code: 2304,
				message: "Cannot find name 'x'.",
			},
			"src/a.ts",
		);
		assert.equal(line, "src/a.ts:12:5 [error] [ts] Cannot find name 'x'. (2304)");
		assert.equal(severityToString(2), "warning");
	});

	it("summarize counts by severity bracket", () => {
		const { summary, errored } = summarizeDiagnosticMessages(["f:1:1 [error] a", "f:2:1 [warning] b", "f:3:1 [hint] c"]);
		assert.equal(summary, "1 error(s), 1 warning(s), 1 hint(s)");
		assert.equal(errored, true);
		assert.deepEqual(dedupeFormattedDiagnostics(["x", "x", "y"]), ["x", "y"]);
	});

	it("extractHoverText handles markdown, arrays and marked strings", () => {
		assert.equal(extractHoverText({ contents: { kind: "markdown", value: "**t**" } }), "**t**");
		assert.equal(extractHoverText({ contents: ["a", { language: "ts", value: "b" }] }), "a\n\nb");
		assert.equal(extractHoverText(null), "");
	});

	it("formatDocumentSymbols nests children", () => {
		const lines = formatDocumentSymbols([
			{
				name: "outer",
				kind: 12,
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
				selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
				children: [
					{
						name: "inner",
						kind: 13,
						range: { start: { line: 1, character: 2 }, end: { line: 1, character: 3 } },
						selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 3 } },
					},
				],
			},
		]);
		assert.deepEqual(lines, ["Function outer (line 1)", "  Variable inner (line 2)"]);
	});

	it("uri round-trip", () => {
		const uri = fileToUri("/tmp/some file.ts");
		assert.equal(uriToFile(uri), path.resolve("/tmp/some file.ts"));
	});

	it("normalizeLspUriKey canonicalizes server-published URIs", () => {
		// typescript-language-server lowercases the drive letter and encodes the
		// colon; lookups with our as-sent URI must still hit.
		const ours = fileToUri("C:\\Users\\x\\project\\a.ts");
		const published = "file:///c%3A/Users/x/project/a.ts";
		assert.equal(normalizeLspUriKey(ours), normalizeLspUriKey(published));
		assert.equal(normalizeLspUriKey("file:///home/x/a.ts"), "file:///home/x/a.ts");
	});
});

// =============================================================================
// deferred coordinator
// =============================================================================

describe("deferred coordinator", () => {
	it("drains fresh entries and drops stale ones", () => {
		const coordinator = new DeferredDiagnosticsCoordinator();
		const v1 = coordinator.bumpVersion("/p/a.ts");
		coordinator.offer({ path: "a.ts", messages: ["a.ts:1:1 [error] x"], summary: "1 error(s)", errored: true }, "/p/a.ts", v1);
		coordinator.bumpVersion("/p/a.ts"); // newer mutation → entry stale
		assert.equal(coordinator.drain().length, 0);
	});

	it("keeps entries whose version is current", () => {
		const coordinator = new DeferredDiagnosticsCoordinator();
		const v1 = coordinator.bumpVersion("/p/a.ts");
		coordinator.offer({ path: "a.ts", messages: ["m"], summary: "1 error(s)", errored: true }, "/p/a.ts", v1);
		const drained = coordinator.drain();
		assert.equal(drained.length, 1);
		assert.equal(drained[0]!.isStale(), false);
		assert.equal(coordinator.pendingCount, 0);
	});

	it("renders entries grouped per file", () => {
		const text = renderDeferredDiagnostics([
			{ path: "a.ts", messages: ["a.ts:1:1 [error] x"], summary: "1 error(s)", errored: true, isStale: () => false },
		]);
		assert.ok(text.includes("a.ts (1 error(s)):"));
		assert.ok(text.includes("a.ts:1:1 [error] x"));
	});
});

// =============================================================================
// config: markers, binary resolution, merge
// =============================================================================

describe("server detection", () => {
	it("hasRootMarkers matches plain names and globs", () => {
		const dir = tmpdir();
		fs.writeFileSync(path.join(dir, "package.json"), "{}");
		fs.writeFileSync(path.join(dir, "app.csproj"), "<x/>");
		assert.equal(hasRootMarkers(dir, ["package.json"]), true);
		assert.equal(hasRootMarkers(dir, ["tsconfig.json"]), false);
		assert.equal(hasRootMarkers(dir, ["*.csproj"]), true);
	});

	it("resolveCommand prefers node_modules/.bin over $PATH", () => {
		const dir = tmpdir();
		fs.writeFileSync(path.join(dir, "package.json"), "{}");
		const binDir = path.join(dir, "node_modules", ".bin");
		fs.mkdirSync(binDir, { recursive: true });
		const exe = path.join(binDir, process.platform === "win32" ? "mock-ls.cmd" : "mock-ls");
		fs.writeFileSync(exe, process.platform === "win32" ? "@echo off" : "#!/bin/sh\n");
		if (process.platform !== "win32") fs.chmodSync(exe, 0o755);
		const resolved = resolveCommand("mock-ls", dir);
		assert.equal(resolved, exe);
	});

	it("on Windows, which() skips extensionless POSIX shims", () => {
		if (process.platform !== "win32") return;
		const dir = tmpdir();
		// npm writes an extensionless POSIX shim next to the .cmd launcher;
		// only the .cmd is spawnable on Windows.
		fs.writeFileSync(path.join(dir, "shim-ls"), "#!/bin/sh\n");
		fs.writeFileSync(path.join(dir, "shim-ls.cmd"), "@echo off\n");
		const resolved = which("shim-ls", { PATH: dir });
		assert.equal(resolved, path.join(dir, "shim-ls.cmd"));
	});

	it("mergeServerOverrides merges fields and honors disabled", () => {
		const merged = mergeServerOverrides({
			"typescript-language-server": { disabled: true },
			"my-ls": { command: "my-ls", args: ["--stdio"], fileTypes: [".my"], rootMarkers: ["my.json"] },
		});
		assert.equal(merged["typescript-language-server"]!.disabled, true);
		assert.deepEqual(merged["my-ls"]!.args, ["--stdio"]);
	});

	it("resolveLspServers requires markers ∩ binary, marks override source", () => {
		const dir = tmpdir();
		fs.writeFileSync(path.join(dir, "my.json"), "{}");
		const resolved = resolveLspServers(dir, {
			"my-ls": { command: process.execPath, fileTypes: [".my"], rootMarkers: ["my.json"] },
			"other-ls": { command: "definitely-not-installed-xyz", fileTypes: [".o"], rootMarkers: ["my.json"] },
			"no-markers-ls": { command: process.execPath, fileTypes: [".n"], rootMarkers: ["nope.json"] },
		});
		assert.ok(resolved["my-ls"]);
		assert.equal(resolved["my-ls"]!.source, "override");
		assert.equal(resolved["other-ls"], undefined);
		assert.equal(resolved["no-markers-ls"], undefined);
	});

	it("getServersForFile sorts non-linters first and tolerates dotless fileTypes", () => {
		const dir = tmpdir();
		fs.writeFileSync(path.join(dir, "my.json"), "{}");
		const servers = resolveLspServers(dir, {
			"lint-ls": { command: process.execPath, fileTypes: ["my"], rootMarkers: ["my.json"], isLinter: true },
			"type-ls": { command: process.execPath, fileTypes: [".my"], rootMarkers: ["my.json"] },
		});
		const ordered = getServersForFile(servers, path.join(dir, "a.my"));
		assert.equal(ordered.length, 2);
		assert.equal(ordered[0]!.name, "type-ls");
	});
});

// =============================================================================
// client lifecycle (integration with the mock server)
// =============================================================================

describe("client registry", () => {
	it("spawns lazily on first use and reuses the client", async () => {
		const dir = tmpdir();
		const registry = new LspRegistry();
		assert.equal(registry.size, 0); // nothing spawned yet
		const client = await registry.getOrCreate(mockServer(), dir);
		assert.equal(registry.size, 1);
		assert.equal(client.status, "ready");
		const again = await registry.getOrCreate(mockServer(), dir);
		assert.equal(again, client);
		assert.equal(registry.size, 1);
		assert.deepEqual(registry.activeClients().map((c) => c.serverName), ["mock-ls"]);
		await registry.shutdownAll();
		assert.equal(registry.size, 0);
	});

	it("pushes diagnostics after didOpen and didChange (version-aware wait)", async () => {
		const dir = tmpdir();
		const file = path.join(dir, "a.mock");
		fs.writeFileSync(file, "const x = 1; // ERROR\n");
		const registry = new LspRegistry();
		const client = await registry.getOrCreate(mockServer(), dir);
		await client.ensureFileOpen(file);
		const uri = fileToUri(file);
		const first = await client.waitForDiagnostics(uri, { timeoutMs: 3000, minDocumentVersion: 1 });
		assert.equal(first.length, 1);
		assert.equal(first[0]!.severity, 1);

		// Mutation: content without ERROR → server publishes an empty batch.
		fs.writeFileSync(file, "const x = 1;\n");
		const version = await client.refreshFile(file);
		const cleared = await client.waitForDiagnostics(uri, { timeoutMs: 3000, minDocumentVersion: version ?? 2 });
		assert.equal(cleared.length, 0);
		await registry.shutdownAll();
	});

	it("answers definition/hover/references/documentSymbol requests", async () => {
		const dir = tmpdir();
		const file = path.join(dir, "a.mock");
		fs.writeFileSync(file, "hello\n");
		const registry = new LspRegistry();
		const client = await registry.getOrCreate(mockServer(), dir);
		await client.ensureFileOpen(file);
		const uri = fileToUri(file);

		const definition = (await client.request("textDocument/definition", {
			textDocument: { uri },
			position: { line: 0, character: 0 },
		})) as { uri: string };
		assert.equal(definition.uri, uri);

		const hover = (await client.request("textDocument/hover", {
			textDocument: { uri },
			position: { line: 0, character: 0 },
		})) as { contents: { value: string } };
		assert.equal(hover.contents.value, "**mock** hover text");

		const references = (await client.request("textDocument/references", {
			textDocument: { uri },
			position: { line: 0, character: 0 },
			context: { includeDeclaration: true },
		})) as unknown[];
		assert.equal(references.length, 2);

		const symbols = (await client.request("textDocument/documentSymbol", {
			textDocument: { uri },
		})) as Array<{ name: string }>;
		assert.equal(symbols[0]!.name, "mockFunction");
		await registry.shutdownAll();
	});

	it("negative-caches init failures (fails fast on the second call)", async () => {
		const dir = tmpdir();
		const registry = new LspRegistry();
		const broken = { ...mockServer(), resolvedCommand: "definitely-not-a-real-binary-musepi-xyz" };
		await assert.rejects(() => registry.getOrCreate(broken, dir));
		const started = Date.now();
		await assert.rejects(() => registry.getOrCreate(broken, dir));
		assert.ok(Date.now() - started < 1000, "second call should fail fast from the negative cache");
		await registry.shutdownAll();
	});

	it("reaps clients idle past the timeout", async () => {
		const dir = tmpdir();
		const registry = new LspRegistry();
		registry.setIdleTimeout(50);
		const client = await registry.getOrCreate(mockServer(), dir);
		client.lastActivity = Date.now() - 10_000;
		const reaped = await registry.reapIdle();
		assert.equal(reaped.length, 1);
		assert.equal(registry.size, 0);
		await registry.shutdownAll();
	});
});
