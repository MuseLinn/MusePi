/**
 * The Electron compat shell loads the served renderer with `?shell=1` — the
 * page then reserves the 48px titlebar region (frame overlay). Absent in a
 * plain browser (no OS window controls to avoid). The exact value `1` is the
 * contract: the shell must send it and the renderer must match it squarely.
 */
export function isCompatShell(): boolean {
	return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("shell") === "1";
}
