/**
 * Desktop bridge access — the single typed entry point for Electron-only
 * capabilities from desktop-web (which also runs in a plain browser against
 * the daemon; there `window.electronAPI` is absent and every capability is
 * a no-op).
 *
 * All members are optional to mirror the preload's shape; consumers check
 * presence before calling. Kept deliberately small: only capabilities the
 * renderer actually consumes belong here (a full platform surface lives in
 * the Electron main/preload layer, not in this web bundle).
 */
export interface ElectronBridge {
	/** Read a local image file as a data URL (desktop only). */
	readFileDataUrl?(filePath: string): Promise<{ dataUrl?: string; error?: string }>;
	/** Open a local path with a specific app, e.g. "textedit" (desktop only). */
	openWith?(app: string, path: string): Promise<boolean>;
	/** Tap the macOS Taptic Engine (desktop only). */
	haptic?(p?: number): Promise<unknown>;
}

/** Type-safe access to the Electron bridge; `null` in plain browsers. */
export function electronBridge(): ElectronBridge | null {
	return (window as unknown as { electronAPI?: ElectronBridge }).electronAPI ?? null;
}
