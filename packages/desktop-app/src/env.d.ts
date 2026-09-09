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
		/** Managed in-app browser (right-pane tool): WebContentsView tabs
		 *  owned by main; the browser tool drives the same views via the
		 *  loopback CDP bridge (`browser.gui` setting). */
		managedBrowserOpen(): Promise<ManagedBrowserState>;
		managedBrowserClose(): Promise<unknown>;
		managedBrowserGetState(): Promise<ManagedBrowserState>;
		managedBrowserSetLayout(layout: ManagedBrowserLayout): Promise<unknown>;
		managedBrowserNavigate(input: { url: string }): Promise<{ ok: boolean; url?: string; error?: string }>;
		managedBrowserGoBack(): Promise<unknown>;
		managedBrowserGoForward(): Promise<unknown>;
		managedBrowserReload(): Promise<unknown>;
		managedBrowserHardReload(): Promise<unknown>;
		managedBrowserClearData(mode: "cookies" | "all"): Promise<{ ok: boolean }>;
		managedBrowserOpenExternal(url: string): Promise<{ ok: boolean }>;
		managedBrowserPickElement(): Promise<{ selector: string | null; cancelled?: boolean }>;
		managedBrowserNewTab(): Promise<ManagedBrowserState>;
		managedBrowserSelectTab(tabId: string): Promise<ManagedBrowserState | null>;
		managedBrowserCloseTab(tabId: string): Promise<ManagedBrowserState | null>;
		managedBrowserStop(tabId?: string): Promise<ManagedBrowserState | null>;
		managedBrowserConfirmResult(input: { requestId: string; allow: boolean }): Promise<{ ok: boolean }>;
		onManagedBrowserState(cb: (state: ManagedBrowserState) => void): () => void;
		onManagedBrowserConfirm(cb: (input: ManagedBrowserConfirmRequest) => void): () => void;
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

interface ManagedBrowserTab {
	id: string;
	url: string;
	title: string;
	loading: boolean;
	openedByAgent: boolean;
	/** page-favicon-updated first URL; null until declared. */
	favicon: string | null;
	/** <meta name="theme-color"> (#rrggbb); null when absent/non-hex. */
	themeColor: string | null;
}

interface ManagedBrowserActivity {
	id: string;
	action: string;
	summary: string;
	domain: string | null;
	status: string;
	tabId: string;
}

interface ManagedBrowserState {
	port: number | null;
	activeTabId: string | null;
	tabs: ManagedBrowserTab[];
	canGoBack: boolean;
	canGoForward: boolean;
	activity: ManagedBrowserActivity | null;
	/** Set on the push that follows an agent-driven tab create (auto-open). */
	agentActivity?: boolean;
}

interface ManagedBrowserLayout {
	tabId?: string;
	bounds: { x: number; y: number; width: number; height: number };
	visible: boolean;
	revision: number;
}
