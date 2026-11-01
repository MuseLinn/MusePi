import type * as Monaco from "monaco-editor";
import { createMonacoWorker } from "./monaco-workers";

let monacoPromise: Promise<typeof Monaco> | null = null;

/** Load Monaco once for every editor surface and install the shared workers. */
export function loadMonaco(): Promise<typeof Monaco> {
	if (monacoPromise) return monacoPromise;
	globalThis.MonacoEnvironment = {
		...globalThis.MonacoEnvironment,
		getWorker: createMonacoWorker,
	};
	monacoPromise = import("monaco-editor").then(monaco => {
		// Completion, navigation, and rename requests use the daemon LSP only.
		// Monaco's built-in TypeScript providers would otherwise duplicate them.
		for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
			defaults.setModeConfiguration({
				...defaults.modeConfiguration,
				completionItems: false,
				definitions: false,
				references: false,
				rename: false,
			});
		}
		return monaco;
	});
	return monacoPromise;
}

/** Follow MusePi's theme attribute without creating separate theme state. */
export function observeMonacoTheme(monaco: typeof Monaco): MutationObserver {
	const root = document.documentElement;
	const applyTheme = (): void => {
		monaco.editor.setTheme(root.dataset.theme === "light" ? "vs" : "vs-dark");
	};
	applyTheme();
	const observer = new MutationObserver(applyTheme);
	observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
	return observer;
}
