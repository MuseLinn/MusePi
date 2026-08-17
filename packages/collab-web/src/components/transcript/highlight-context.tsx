import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { CodeHighlightFn } from "./highlight";

/**
 * The desktop GUI mounts a provider whose function highlights code blocks via
 * Electron IPC → tree-sitter natives. Browser guests render plain blocks
 * (no provider). Consumers treat the function as optional and must not
 * require synchronous results.
 */
const CodeHighlightContext = createContext<CodeHighlightFn | null>(null);

export function CodeHighlightProvider({
	highlight,
	children,
}: {
	highlight: CodeHighlightFn | null;
	children: ReactNode;
}): ReactNode {
	const value = useMemo(() => highlight, [highlight]);
	return <CodeHighlightContext.Provider value={value}>{children}</CodeHighlightContext.Provider>;
}

export function useCodeHighlight(): CodeHighlightFn | null {
	return useContext(CodeHighlightContext);
}
