// Mock MCP server for MusePi core tests.
// Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout (MCP stdio
// framing): initialize handshake, paginated tools/list, tools/call with
// echo/error/big-result behaviors, plus a ping server request check.
// stderr carries a boot line to verify tail capture.

const TOOLS = [
	{
		name: "echo",
		description: "Echo the input text back",
		inputSchema: {
			type: "object",
			properties: { text: { type: "string" } },
			required: ["text"],
		},
	},
	{
		name: "fail",
		description: "Always returns an error result",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "big",
		description: "Returns a large text payload",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "Weird Name!",
		description: "Tool whose name needs sanitization",
		inputSchema: { type: "object", properties: {} },
	},
];

process.stderr.write("mock-mcp-server boot\n");

let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += chunk.toString("utf-8");
	let newline = buffer.indexOf("\n");
	while (newline !== -1) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		newline = buffer.indexOf("\n");
		if (line.length === 0) continue;
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			continue;
		}
		handle(message);
	}
});

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(message) {
	// Notifications have no id — nothing to answer.
	if (message.id === undefined) return;
	const { id, method, params } = message;
	switch (method) {
		case "initialize":
			send({
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion: params?.protocolVersion ?? "2025-03-26",
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: "mock-mcp", version: "1.0.0" },
				},
			});
			return;
		case "tools/list": {
			const cursor = params?.cursor;
			// Two pages when no cursor: first two tools, then the rest.
			if (!cursor) {
				send({ jsonrpc: "2.0", id, result: { tools: TOOLS.slice(0, 2), nextCursor: "page2" } });
			} else {
				send({ jsonrpc: "2.0", id, result: { tools: TOOLS.slice(2) } });
			}
			return;
		}
		case "tools/call": {
			const { name, arguments: args } = params ?? {};
			if (name === "echo") {
				send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `echo:${args?.text ?? ""}` }] } });
				return;
			}
			if (name === "fail") {
				send({
					jsonrpc: "2.0",
					id,
					result: { content: [{ type: "text", text: "intentional failure" }], isError: true },
				});
				return;
			}
			if (name === "big") {
				send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "x".repeat(100_000) }] } });
				return;
			}
			if (name === "Weird Name!") {
				send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "weird-ok" }] } });
				return;
			}
			send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool: ${name}` } });
			return;
		}
		case "ping":
			send({ jsonrpc: "2.0", id, result: {} });
			return;
		default:
			send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
	}
}
