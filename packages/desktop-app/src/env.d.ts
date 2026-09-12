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
		dataRootApply(picked: string): Promise<{ ok: true; root: string } | { ok: false; error: string }>;
		copyText(text: string): Promise<void>;
		openWith(app: string, path: string): Promise<boolean>;
		openExternal(url: string): Promise<void>;
		/** Computer-use overlay glow: ring the displays while the agent
		 *  drives the desktop (`computer` tool running). */
		computerGlow(on: boolean): Promise<unknown>;
		/** Computer-use overlay target: highlight one desktop input action
		 *  (window/element frame + action point) on the glow overlay. */
		glowTarget(event: unknown): Promise<unknown>;
		/** Managed in-app browser (right-pane tool): the page is a DOM
		 *  `<webview>` owned by the renderer (so menus/tooltips/handles layer
		 *  normally); main keeps the persistent partition and the loopback CDP
		 *  bridge the agent drives via `browser.gui`. */
		managedBrowserGetState(): Promise<ManagedBrowserState>;
		/** Address-bar navigation: main normalizes the address and applies the
		 *  risk policy, then loads it in the target guest. */
		managedBrowserNavigate(input: { url: string }): Promise<{ ok: boolean; url?: string; error?: string }>;
		managedBrowserClearData(mode: "cookies" | "all"): Promise<{ ok: boolean }>;
		/** Interrupt the agent's in-flight operation on a tab (optional tabId). */
		managedBrowserStop(tabId?: string): Promise<unknown>;
		/** Device preset for a tab: "phone"/"tablet" set a device UA (plus
		 *  client hints and touch) so the SITE serves its mobile document;
		 *  "fit"/"desktop" clear the identity. `viewport` emulates the layout
		 *  size (the host is transform-scaled, so the element's own size never
		 *  reaches the guest); `reload` re-requests the page so it re-serves. */
		managedBrowserSetDevice(input: {
			tabId: string;
			preset: string;
			reload?: boolean;
			viewport?: { width: number; height: number };
		}): Promise<{ ok: boolean; error?: string }>;
		managedBrowserConfirmResult(input: { requestId: string; allow: boolean }): Promise<{ ok: boolean }>;
		/** Guest lifecycle → main: the CDP bridge binds `webContents.fromId`. */
		managedBrowserGuestReady(input: { tabId: string; webContentsId: number }): Promise<unknown>;
		managedBrowserGuestGone(tabId: string): Promise<unknown>;
		managedBrowserActiveTab(tabId: string): Promise<unknown>;
		managedBrowserVisibility(visible: boolean): Promise<unknown>;
		onManagedBrowserState(cb: (state: ManagedBrowserState) => void): () => void;
		onManagedBrowserConfirm(cb: (input: ManagedBrowserConfirmRequest) => void): () => void;
		/** Agent-created tab (CDP `Target.createTarget`): mount a `<webview>`. */
		onManagedBrowserCreateTab(cb: (input: { tabId: string; url: string }) => void): () => void;
		onManagedBrowserSelectTab(cb: (input: { tabId: string }) => void): () => void;
		onManagedBrowserCloseTab(cb: (input: { tabId: string }) => void): () => void;
		/** Main-process powerMonitor "resume" (system sleep/wake): fires reliably
		 *  on wake where renderer visibilitychange/online may not. The renderer
		 *  uses it to recover the daemon connection proactively. */
		onPowerResume(cb: () => void): () => void;
	};
}

interface ManagedBrowserConfirmRequest {
	requestId: string;
	url: string;
}

interface ManagedBrowserActivity {
	id: string;
	action: string;
	summary: string;
	domain: string | null;
	status: string;
	tabId: string;
}

/** Everything main still owns about the panel: the CDP port, the running agent
 *  operation, and whether that operation should surface the panel. */
interface ManagedBrowserState {
	port: number | null;
	activity: ManagedBrowserActivity | null;
	agentActivity?: boolean;
}
