// Mock LSP server over stdio (plain node, no deps) for MusePi LSP tests.
//
// Protocol surface:
// - initialize → capabilities (sync/definition/references/hover/documentSymbol)
// - didOpen/didChange → publishDiagnostics 30ms later, echoing the document
//   version; content-driven: lines containing ERROR produce an error
//   diagnostic, WARN a warning (so tests control the diagnostics stream by
//   editing the fixture file).
// - definition/references/hover/documentSymbol → fixed deterministic results.
// - shutdown → result null; exit → process.exit(0).

let buffer = Buffer.alloc(0);
const openDocs = new Map();

function send(message) {
	const body = Buffer.from(JSON.stringify(message), "utf-8");
	process.stdout.write(`Content-Length: ${body.length}\r\n\r\n${body.toString("utf-8")}`);
}

function diagnosticsFor(text) {
	const diagnostics = [];
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.includes("ERROR")) {
			diagnostics.push({
				range: { start: { line: i, character: 0 }, end: { line: i, character: Math.max(1, line.length) } },
				severity: 1,
				source: "mock-ls",
				code: 1001,
				message: "mock error diagnostic",
			});
		} else if (line.includes("WARN")) {
			diagnostics.push({
				range: { start: { line: i, character: 0 }, end: { line: i, character: Math.max(1, line.length) } },
				severity: 2,
				source: "mock-ls",
				message: "mock warning diagnostic",
			});
		}
	}
	return diagnostics;
}

function publish(uri) {
	const doc = openDocs.get(uri);
	if (!doc) return;
	setTimeout(() => {
		send({
			jsonrpc: "2.0",
			method: "textDocument/publishDiagnostics",
			params: { uri, version: doc.version, diagnostics: diagnosticsFor(doc.text) },
		});
	}, 30);
}

const MOCK_RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } };

function handle(message) {
	if (message.method && message.id !== undefined) {
		switch (message.method) {
			case "initialize":
				return send({
					jsonrpc: "2.0",
					id: message.id,
					result: {
						capabilities: {
							textDocumentSync: 1,
							definitionProvider: true,
							referencesProvider: true,
							hoverProvider: true,
							documentSymbolProvider: true,
						},
					},
				});
			case "shutdown":
				return send({ jsonrpc: "2.0", id: message.id, result: null });
			case "textDocument/definition":
				return send({
					jsonrpc: "2.0",
					id: message.id,
					result: { uri: message.params.textDocument.uri, range: MOCK_RANGE },
				});
			case "textDocument/references":
				return send({
					jsonrpc: "2.0",
					id: message.id,
					result: [
						{ uri: message.params.textDocument.uri, range: MOCK_RANGE },
						{
							uri: message.params.textDocument.uri,
							range: { start: { line: 3, character: 2 }, end: { line: 3, character: 8 } },
						},
					],
				});
			case "textDocument/hover":
				return send({
					jsonrpc: "2.0",
					id: message.id,
					result: { contents: { kind: "markdown", value: "**mock** hover text" } },
				});
			case "textDocument/documentSymbol":
				return send({
					jsonrpc: "2.0",
					id: message.id,
					result: [
						{
							name: "mockFunction",
							kind: 12,
							range: MOCK_RANGE,
							selectionRange: MOCK_RANGE,
							children: [
								{ name: "inner", kind: 13, range: MOCK_RANGE, selectionRange: MOCK_RANGE },
							],
						},
					],
				});
			default:
				return send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown method" } });
		}
	}
	if (message.method === "textDocument/didOpen") {
		const doc = message.params.textDocument;
		openDocs.set(doc.uri, { text: doc.text, version: doc.version });
		publish(doc.uri);
		return;
	}
	if (message.method === "textDocument/didChange") {
		const uri = message.params.textDocument.uri;
		const text = message.params.contentChanges[0].text;
		openDocs.set(uri, { text, version: message.params.textDocument.version });
		publish(uri);
		return;
	}
	if (message.method === "exit") {
		process.exit(0);
	}
}

process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const headerEnd = buffer.indexOf("\r\n\r\n");
		if (headerEnd === -1) break;
		const header = buffer.subarray(0, headerEnd).toString("utf-8");
		const match = /Content-Length: (\d+)/i.exec(header);
		if (!match) {
			buffer = buffer.subarray(headerEnd + 4);
			continue;
		}
		const length = Number(match[1]);
		if (buffer.length < headerEnd + 4 + length) break;
		const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf-8");
		buffer = buffer.subarray(headerEnd + 4 + length);
		handle(JSON.parse(body));
	}
});
