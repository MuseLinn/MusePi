declare module "*.css";
declare module "*?url";

/** Electron shell bridge (electron/preload.cjs → contextBridge). */
interface Window {
	electronAPI?: {
		probeDaemonPort(): Promise<number | null>;
		startDaemon(port: number): Promise<number>;
		restartDaemon(port: number): Promise<number>;
		openDirectory(): Promise<string | null>;
		/** Relocate the app data root; resolves { ok:true, root } | { ok:false, error }. */
		dataRootApply(
			picked: string,
		): Promise<{ ok: true; root: string } | { ok: false; error: string }>;
		copyText(text: string): Promise<void>;
		openWith(app: string, path: string): Promise<boolean>;
		openExternal(url: string): Promise<void>;
	};
}
