/** Vite resolves the ESM workers during development. Electron production uses
 * the prebuilt workers copied beside index.html: Bun leaves package-based
 * worker URLs untouched instead of emitting their dependency graphs. */
export function createMonacoWorker(_workerId: string, label: string): Worker {
	const packaged = window.location.protocol === "file:";
	if (label === "json") {
		if (packaged) return new Worker(new URL("monaco-workers/json.worker.js", window.location.href));
		return new Worker(
			new URL("../../node_modules/monaco-editor/esm/vs/language/json/json.worker.js", import.meta.url),
			{
				type: "module",
			},
		);
	}
	if (["css", "less", "scss"].includes(label)) {
		if (packaged) return new Worker(new URL("monaco-workers/css.worker.js", window.location.href));
		return new Worker(
			new URL("../../node_modules/monaco-editor/esm/vs/language/css/css.worker.js", import.meta.url),
			{
				type: "module",
			},
		);
	}
	if (["html", "handlebars", "razor"].includes(label)) {
		if (packaged) return new Worker(new URL("monaco-workers/html.worker.js", window.location.href));
		return new Worker(
			new URL("../../node_modules/monaco-editor/esm/vs/language/html/html.worker.js", import.meta.url),
			{
				type: "module",
			},
		);
	}
	if (["typescript", "javascript"].includes(label)) {
		if (packaged) return new Worker(new URL("monaco-workers/ts.worker.js", window.location.href));
		return new Worker(
			new URL("../../node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js", import.meta.url),
			{
				type: "module",
			},
		);
	}
	if (packaged) return new Worker(new URL("monaco-workers/editor.worker.js", window.location.href));
	return new Worker(new URL("../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url), {
		type: "module",
	});
}
