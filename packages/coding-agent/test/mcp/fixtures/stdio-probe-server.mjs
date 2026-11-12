/**
 * Minimal stdio MCP server for probe tests: answers `initialize` with tools
 * capability, lists one tool, and replies to anything else with an empty
 * result. Line-delimited JSON-RPC, which is what the stdio transport speaks.
 */
let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
	buffer += chunk;
	let newline = buffer.indexOf("\n");
	while (newline !== -1) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		if (line) handle(JSON.parse(line));
		newline = buffer.indexOf("\n");
	}
});

function send(payload) {
	process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function handle(message) {
	if (message.method === "initialize") {
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: {
				protocolVersion: message.params.protocolVersion,
				capabilities: { tools: {} },
				serverInfo: { name: "probe-fixture", version: "1.0.0" },
			},
		});
		return;
	}
	if (message.method === "tools/list") {
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: {
				tools: [{ name: "echo", description: "Echo the input", inputSchema: { type: "object" } }],
			},
		});
		return;
	}
	if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: {} });
}
