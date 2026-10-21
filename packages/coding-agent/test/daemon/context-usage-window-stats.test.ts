/**
 * Contract test: `session.contextUsage` carries the visible-window timing
 * fold (`windowStats`) alongside the durable token projection.
 *
 * Failure mode defended: the composer stats row's activity pill reads ONLY
 * `windowStats` from this RPC — if the field is dropped from the response
 * (or folds the wrong entry family), the pill silently degrades to hidden
 * while the usage pill keeps working, which reads as "stats row half gone".
 *
 * The fold math itself is covered by packages/wire/test/window-stats.test.ts;
 * here we only pin the wire shape: eight numeric fields, zeros for an empty
 * window, token figures untouched on the outer object.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { startDaemon } from "../../src/daemon/server";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

let isolatedDir: string;

beforeAll(async () => {
	isolatedDir = await isolateAgentDirForTest("daemon-ctx-usage-ws-");
}, 30_000);

afterAll(async () => {
	await restoreAgentDirForTest(isolatedDir);
}, 30_000);

describe("session.contextUsage windowStats", () => {
	test("a live session's contextUsage response includes an eight-field windowStats fold", async () => {
		const daemon = await startDaemon({
			socketPath: path.join(os.tmpdir(), `daemon-ctx-ws-${crypto.randomUUID()}.sock`),
			wsPort: 0,
		});
		try {
			const ws = new WebSocket(`ws://127.0.0.1:${daemon.wsPort}`);
			await new Promise(r => ws.addEventListener("open", r, { once: true }));
			let nextId = 1;
			const rpc = (method: string, params: unknown): Promise<any> =>
				new Promise(resolve => {
					ws.addEventListener("message", ev => resolve(JSON.parse((ev as MessageEvent).data as string)), {
						once: true,
					});
					ws.send(JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }));
				});

			const created = (await rpc("session.create", {})) as { result?: { sessionId?: string } };
			const sessionId = created.result?.sessionId;
			expect(sessionId).toBeTruthy();

			const res = (await rpc("session.contextUsage", { sessionId })) as {
				result?: Record<string, unknown> | null;
				error?: unknown;
			};
			expect(res.error).toBeUndefined();
			const result = res.result;
			// A fresh session must at least answer with the stats row payload:
			// the plugin hides the whole row on a null response, so a
			// regression to "null for empty sessions" reads as "row gone".
			expect(result).not.toBeNull();
			const windowStats = result?.windowStats as Record<string, unknown> | undefined;
			expect(windowStats).toBeDefined();
			for (const field of ["turns", "steps", "llmMs", "toolMs", "ttftMs", "ttftSteps", "decodeMs", "decodeTokens"]) {
				expect(windowStats?.[field], `windowStats.${field}`).toBe(0);
			}
			// Durable token projection stays on the outer object — the fold
			// must not swallow or duplicate it.
			expect(typeof result?.tokens).toBe("number");
			expect(typeof result?.contextWindow).toBe("number");
			ws.close();
		} finally {
			await daemon.close();
		}
	}, 60_000);
});
