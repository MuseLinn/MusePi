#!/usr/bin/env bun
/**
 * Test fixture: a minimal streamable-HTTP MCP server whose liveness is driven
 * by a control file, so a test can model "server restarted" / "laptop woke up"
 * without touching process lifecycle.
 *
 * `$OMP_TEST_HTTP_CONTROL` points at a file. While it contains "up" the server
 * answers initialize/tools/list; while it does not, it returns 503 for every
 * request, which is what an `http`/`sse` transport surfaces as a connection
 * loss. `$OMP_TEST_HTTP_READY` is written with the bound port once listening so
 * the parent can connect without guessing.
 *
 * Used by mcp-quiet-reconnect.test.ts (oh-my-pi #11803).
 */
import * as fs from "node:fs";

const controlPath = Bun.env.OMP_TEST_HTTP_CONTROL;
const readyPath = Bun.env.OMP_TEST_HTTP_READY;
if (!controlPath || !readyPath) {
	console.error("OMP_TEST_HTTP_CONTROL and OMP_TEST_HTTP_READY are required");
	process.exit(2);
}

const isUp = (): boolean => {
	try {
		return fs.readFileSync(controlPath, "utf8").trim() === "up";
	} catch {
		return false;
	}
};

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json",
			// Streamable HTTP: the server may reply with a plain JSON body.
			"mcp-session-id": "fixture-session",
		},
	});
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		if (!isUp()) return new Response("server down", { status: 503 });

		let message: { id?: number | string; method?: string };
		try {
			message = (await request.json()) as { id?: number | string; method?: string };
		} catch {
			return new Response("bad request", { status: 400 });
		}

		// Notifications carry no id and expect no body.
		if (message.id === undefined) return new Response(null, { status: 202 });

		switch (message.method) {
			case "initialize":
				return json({
					jsonrpc: "2.0",
					id: message.id,
					result: {
						protocolVersion: "2025-03-26",
						capabilities: { tools: {} },
						serverInfo: { name: "flaky-http", version: "1.0.0" },
					},
				});
			case "tools/list":
				return json({
					jsonrpc: "2.0",
					id: message.id,
					result: {
						tools: [
							{
								name: "ping_tool",
								description: "Fixture tool",
								inputSchema: { type: "object", properties: {} },
							},
						],
					},
				});
			default:
				return json({
					jsonrpc: "2.0",
					id: message.id,
					result: {},
				});
		}
	},
});

fs.writeFileSync(readyPath, String(server.port));
