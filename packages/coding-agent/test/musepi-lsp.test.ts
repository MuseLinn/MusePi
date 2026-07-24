// MusePi LSP — host seam tests (musepi/lsp/native.ts).
// Real end-to-end through @musepi/core: the mock LSP server fixture (plain
// node script) speaks actual stdio JSON-RPC, so these tests cover the tool
// surface, lazy spawn, deferred post-mutation diagnostics, staleness, and
// the file-mutation-queue listener seam.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DeferredDiagnosticsCoordinator, LspRegistry, type ResolvedLspServer } from "@musepi/core";
import { afterEach, describe, expect, test } from "vitest";
import { addFileMutationListener, withFileMutationQueue } from "../src/core/tools/file-mutation-queue.ts";
import {
	initMusepiLspForTest,
	musepiLspToolDef,
	notifyMusepiLspFileMutated,
	transformMusepiLspContext,
} from "../src/musepi/lsp/native.ts";

const FIXTURE_SERVER = fileURLToPath(new URL("../../musepi/core/test/fixtures/mock-lsp-server.mjs", import.meta.url));

const TEST_TIMEOUT = 30_000;

interface TestContext {
	dir: string;
	file: string;
	registry: LspRegistry;
	coordinator: DeferredDiagnosticsCoordinator;
}

function setup(): TestContext {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-lsp-host-"));
	const file = path.join(dir, "a.mocks");
	fs.writeFileSync(file, "const x = 1; // ERROR\nconst y = 2;\n");
	const registry = new LspRegistry();
	const coordinator = new DeferredDiagnosticsCoordinator();
	const server: ResolvedLspServer = {
		name: "mock-ls",
		command: "node-mock-ls",
		resolvedCommand: process.execPath,
		args: [FIXTURE_SERVER],
		fileTypes: [".mocks"],
		rootMarkers: [],
		source: "override",
	};
	initMusepiLspForTest({
		enabled: true,
		cwd: dir,
		servers: { "mock-ls": server },
		registry,
		coordinator,
		detachMutationListener: null,
	});
	return { dir, file, registry, coordinator };
}

const contexts: TestContext[] = [];
function ctx(): TestContext {
	const c = setup();
	contexts.push(c);
	return c;
}

afterEach(async () => {
	const pending = contexts.splice(0).map((c) => c.registry.shutdownAll());
	await Promise.allSettled(pending);
});

async function execute(params: Record<string, unknown>): Promise<string> {
	const result = await musepiLspToolDef.execute("tc1", params, undefined, undefined, undefined as never);
	const content = result.content[0];
	return content.type === "text" ? content.text : "";
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("waitFor timed out");
}

describe("lsp tool", () => {
	test(
		"status reports detected-not-started servers before any spawn",
		async () => {
			ctx();
			const text = await execute({ action: "status" });
			expect(text).toContain("Detected, not started");
			expect(text).toContain("mock-ls");
			expect(text).toContain("Idle timeout");
		},
		TEST_TIMEOUT,
	);

	test(
		"disabled gate answers politely without spawning",
		async () => {
			const c = ctx();
			initMusepiLspForTest({
				enabled: false,
				cwd: c.dir,
				servers: {},
				registry: c.registry,
				coordinator: c.coordinator,
				detachMutationListener: null,
			});
			const text = await execute({ action: "diagnostics", path: c.file });
			expect(text).toContain("disabled");
			expect(c.registry.size).toBe(0);
		},
		TEST_TIMEOUT,
	);

	test(
		"diagnostics lazily spawns the server and returns sorted issues",
		async () => {
			const c = ctx();
			expect(c.registry.size).toBe(0); // lazy: nothing spawned by init
			const text = await execute({ action: "diagnostics", path: c.file });
			expect(c.registry.size).toBe(1); // spawned on first use
			expect(text).toContain("a.mocks:1:1 [error] [mock-ls] mock error diagnostic (1001)");
			expect(text).toContain("1 error(s)");
			const status = await execute({ action: "status" });
			expect(status).toContain("Active language servers");
			expect(status).toContain("ready");
		},
		TEST_TIMEOUT,
	);

	test(
		"definition / hover / references / symbols format their results",
		async () => {
			const c = ctx();
			const definition = await execute({ action: "definition", path: c.file, line: 1, column: 1 });
			expect(definition).toContain("a.mocks:1:1");

			const references = await execute({ action: "references", path: c.file, line: 1, column: 1 });
			expect(references).toContain("2 references location(s)");
			expect(references).toContain("a.mocks:4:3");

			const hover = await execute({ action: "hover", path: c.file, line: 1, column: 1 });
			expect(hover).toContain("**mock** hover text");

			const symbols = await execute({ action: "symbols", path: c.file });
			expect(symbols).toContain("Function mockFunction");
			expect(symbols).toContain("Variable inner");
		},
		TEST_TIMEOUT,
	);

	test(
		"graceful degradation: no server for the file type",
		async () => {
			const c = ctx();
			const other = path.join(c.dir, "b.xyz");
			fs.writeFileSync(other, "whatever\n");
			const text = await execute({ action: "diagnostics", path: other });
			expect(text).toContain("No LSP server available");
			expect(c.registry.size).toBe(0); // nothing spawned
		},
		TEST_TIMEOUT,
	);
});

describe("deferred post-mutation diagnostics", () => {
	test(
		"inline window: warm-server diagnostics are ready right after the mutation hook resolves",
		async () => {
			const c = ctx();
			await execute({ action: "diagnostics", path: c.file }); // warm the server
			// Drain anything the warm-up put into the ledger's seen set is
			// unnecessary — the ledger dedupe is per-identity and this batch
			// was never offered. Fresh content produces a fresh identity.
			fs.writeFileSync(c.file, "const x = 1; // ERROR\nconst w = 2; // WARN\n");
			await notifyMusepiLspFileMutated(c.file);
			expect(c.coordinator.pendingCount).toBe(1); // offered inside the inline window
			const injected = transformMusepiLspContext([]);
			expect(injected).toHaveLength(1);
		},
		TEST_TIMEOUT,
	);

	test(
		"mutation triggers an async fetch that the transformer injects",
		async () => {
			const c = ctx();
			notifyMusepiLspFileMutated(c.file);
			let injected: unknown[] = [];
			await waitFor(() => {
				injected = transformMusepiLspContext([]);
				return injected.length > 0;
			});
			const message = injected[0] as { role: string; content: Array<{ text: string }> };
			expect(message.role).toBe("user");
			expect(message.content[0]!.text).toContain("mock error diagnostic");
			expect(message.content[0]!.text).toContain("a.mocks");
			// Drained: a second transform appends nothing.
			expect(transformMusepiLspContext([])).toHaveLength(0);
		},
		TEST_TIMEOUT,
	);

	test(
		"a newer mutation makes a fetched-but-undrained entry stale",
		async () => {
			const c = ctx();
			notifyMusepiLspFileMutated(c.file);
			await waitFor(() => c.coordinator.pendingCount > 0);
			// Newer mutation before the drain → the pending entry is stale.
			notifyMusepiLspFileMutated(c.file);
			// The v2 fetch sees identical diagnostics → ledger dedupes → no new offer.
			await new Promise((resolve) => setTimeout(resolve, 3000));
			expect(transformMusepiLspContext([])).toHaveLength(0);
		},
		TEST_TIMEOUT,
	);

	test(
		"ledger suppresses a repeated identical batch",
		async () => {
			const c = ctx();
			notifyMusepiLspFileMutated(c.file);
			await waitFor(() => {
				return transformMusepiLspContext([]).length > 0;
			});
			// Same file mutated again with the same diagnostics → nothing fresh.
			notifyMusepiLspFileMutated(c.file);
			await new Promise((resolve) => setTimeout(resolve, 3000));
			expect(transformMusepiLspContext([])).toHaveLength(0);
		},
		TEST_TIMEOUT,
	);
});

describe("file-mutation-queue listener seam", () => {
	test("listeners fire after successful mutation with the mutated path", async () => {
		const c = ctx();
		const seen: string[] = [];
		const detach = addFileMutationListener((filePath) => {
			seen.push(filePath);
		});
		await withFileMutationQueue(c.file, async () => {
			fs.writeFileSync(c.file, "const z = 3;\n");
		});
		detach();
		expect(seen).toEqual([c.file]);
		// Detached listener no longer fires.
		await withFileMutationQueue(c.file, async () => {
			fs.writeFileSync(c.file, "const z = 4;\n");
		});
		expect(seen).toEqual([c.file]);
	});
});
