"use strict";

// Syntax-highlight worker (child_process.fork from main.cjs). The renderer
// is sandboxed and the main process used to run tree-sitter synchronously
// per IPC call — a large code block froze the whole main event loop (all
// windows, all IPC). Here the same native highlighter runs in a dedicated
// process; the main loop only forwards messages over the Node IPC channel
// (process.on("message") / process.send — deliberately NOT Electron's
// utilityProcess port, which proved unreliable across Electron versions).
process.on("message", async msg => {
	if (!msg || typeof msg.id !== "number") return;
	try {
		const mod = await import("@musepi/pi-natives");
		// colors must be undefined, not null: the native expects an
		// object (old main-process path always had undefined here).
		const result = mod.highlightCode(msg.code, msg.lang ?? null, msg.colors ?? undefined);
		process.send({ id: msg.id, result });
	} catch (err) {
		process.send({ id: msg.id, result: null, error: String((err && err.message) || err) });
	}
});
