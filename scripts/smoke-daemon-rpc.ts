/**
 * Headless daemon end-to-end smoke: system.ping → session.create →
 * session.list → session.snapshot → session.tree over WebSocket JSON-RPC.
 * Usage: bun scripts/smoke-daemon-rpc.ts <wsPort>
 * Exits 0 on success, 1 on any step failure. No LLM keys required —
 * creates a session and snapshots it without sending a turn.
 */
const port = Number(process.argv[2] ?? 17777);
const url = `ws://127.0.0.1:${port}`;
let seq = 0;

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string };
const pending = new Map<number, Pending>();

function rpc<T>(ws: WebSocket, method: string, params?: unknown): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const id = ++seq;
		pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method });
		ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
	});
}

function assert(cond: unknown, msg: string): void {
	if (!cond) throw new Error(`SMOKE ASSERT FAILED: ${msg}`);
	console.log(`  ✓ ${msg}`);
}

const ws = new WebSocket(url);
const timeout = setTimeout(() => {
	console.error("SMOKE TIMEOUT after 45s");
	process.exit(1);
}, 45_000);

ws.onmessage = ev => {
	const msg = JSON.parse(String(ev.data));
	if (msg.id !== undefined && pending.has(msg.id)) {
		const p = pending.get(msg.id)!;
		pending.delete(msg.id);
		if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
		else p.resolve(msg.result);
	}
};

ws.onerror = ev => {
	console.error("WS error", ev);
	process.exit(1);
};

ws.onopen = async () => {
	try {
		console.log(`[1] system.ping → ${url}`);
		const pong = await rpc<Record<string, unknown>>(ws, "system.ping");
		assert(pong && typeof pong === "object", `pong received (${JSON.stringify(pong).slice(0, 80)})`);

		console.log("[2] session.create (no model turn)");
		const created = await rpc<{ sessionId?: string; id?: string }>(ws, "session.create", {
			cwd: process.cwd(),
			title: "smoke-e2e",
		});
		const sessionId = created.sessionId ?? created.id;
		assert(sessionId, `session created: ${sessionId}`);

		console.log("[3] session.list contains new session");
		const list = await rpc<Array<{ id: string; title?: string }>>(ws, "session.list");
		assert(Array.isArray(list), `list returned ${list.length} sessions`);
		assert(
			list.some(s => s.id === sessionId),
			"new session present in list",
		);

		console.log("[4] session.snapshot");
		// sessionSnapshot shape: { entries: [...], state: {...}, tail } — a fresh
		// session legitimately has empty entries; presence of the keys is the check.
		const snap = await rpc<{ entries?: unknown[]; state?: unknown; tail?: unknown }>(ws, "session.snapshot", {
			sessionId,
		});
		assert(snap && typeof snap === "object" && Array.isArray(snap.entries), "snapshot shape ok (entries array)");

		console.log("[5] session.tree");
		const tree = await rpc<unknown>(ws, "session.tree", { sessionId });
		assert(tree !== undefined && tree !== null, "tree returned");

		console.log("[6] session.close (cleanup)");
		try {
			await rpc(ws, "session.close", { sessionId });
			console.log("  ✓ closed");
		} catch (e) {
			console.log(`  (close best-effort: ${(e as Error).message})`);
		}

		console.log("\nSMOKE PASS — daemon end-to-end RPC healthy");
		clearTimeout(timeout);
		process.exit(0);
	} catch (err) {
		console.error("\nSMOKE FAIL:", (err as Error).message);
		clearTimeout(timeout);
		process.exit(1);
	}
};
