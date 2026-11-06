import "./happy-dom-shim";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { getLocaleSnapshot, setLocale, type TranslationKey, t } from "@musepi/client-core";
import type { AgentSnapshot } from "@musepi/pi-wire";
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { compileComponentModule } from "../../coding-agent/src/daemon/extension-artifact-compiler";
import { ChatView } from "../src/components/ChatView";
import { ContextPanel } from "../src/components/ContextPanel";
import {
	attachElement,
	closeTab,
	createTab,
	getHostState,
	type HostWebview,
	selectTab,
	setBrowserSession,
	unwireHost,
	wireHost,
} from "../src/lib/managed-browser-host";
import { EMPTY_PANEL_TAB_STATE, serializePanelTabs, upsertPanelTab } from "../src/lib/panel-tabs";
import type { RpcClient } from "../src/lib/rpc";
import { type GuiSessionState, GuiSessionStore } from "../src/lib/session-store";
import { agentTabDescriptor, SURFACES } from "../src/lib/surfaces/registry";
import { type UsePanelTabsResult, usePanelTabs } from "../src/lib/use-panel-tabs";

const originalLocale = getLocaleSnapshot();
const originalElectronAPI = window.electronAPI;
const OriginalResizeObserver = globalThis.ResizeObserver;
const roots: Root[] = [];
const hosts: HTMLElement[] = [];
const storageKeys: string[] = [];
const sessionStores: GuiSessionStore[] = [];
let stateListener: ((state: ManagedBrowserState) => void) | null = null;
let storageSequence = 0;

const rpc = {
	request: async () => null,
	addEventListener: () => () => {},
} as unknown as RpcClient;
const snap = {
	sessionId: "s1",
	entries: [],
	state: { cwd: "C:/workspace" },
	streaming: false,
	activeTools: new Map(),
	working: false,
	cursor: 0,
	agents: [],
	progress: new Map(),
	lifecycle: new Map(),
	unviewedCompleted: [],
	approvals: [],
	recap: null,
	roundDurations: new Map(),
} as unknown as GuiSessionState;
const extTabs = [
	{ slot: "panel.tab.browser", extensionId: "browser-ui", code: "", error: "test browser surface" },
	{ slot: "panel.tab.files", extensionId: "file-workspace", code: "", error: "test file surface" },
];

function electronApi(): Window["electronAPI"] {
	return {
		onManagedBrowserState: (listener: (state: ManagedBrowserState) => void) => {
			stateListener = listener;
			return () => {
				if (stateListener === listener) stateListener = null;
			};
		},
		onManagedBrowserConfirm: () => () => {},
		onManagedBrowserCreateTab: () => () => {},
		onManagedBrowserSelectTab: () => () => {},
		onManagedBrowserCloseTab: () => () => {},
		managedBrowserGetState: async () => ({ port: null, activity: null, busyTabIds: [] }),
		managedBrowserHostReady: async () => {},
		managedBrowserActiveTab: async () => {},
		managedBrowserVisibility: async () => {},
		managedBrowserGuestGone: async () => {},
		managedBrowserGuestReady: async () => {},
	} as unknown as Window["electronAPI"];
}

function seed(storageKey: string, split = false): void {
	let state = upsertPanelTab(EMPTY_PANEL_TAB_STATE, { surface: "notes", label: t("project knowledge") });
	state = { ...state, split };
	localStorage.setItem(storageKey, JSON.stringify(serializePanelTabs(state)));
}

interface PanelOptions {
	seedNotes?: boolean;
	split?: boolean;
	open?: boolean;
	sessionId?: string;
	browserOpenRequest?: { url: string; nonce: number } | null;
	onExpandPanel?: () => void;
	agents?: readonly AgentSnapshot[];
	progress?: GuiSessionState["progress"];
	rpc?: RpcClient;
	onOpenSession?: (id: string) => void;
	/** Pre-seed the panel with one agent tab (agent already gone from snap). */
	seedAgentTab?: { id: string; displayName: string; childSessionId?: string };
}

function mountPanel(options?: PanelOptions) {
	let currentOptions = options;
	const storageKey = `test-context-browser-${Date.now()}-${storageSequence++}`;
	storageKeys.push(storageKey);
	if (options?.seedNotes) seed(storageKey, options.split);
	if (options?.seedAgentTab) {
		const descriptor = agentTabDescriptor(options.seedAgentTab, options.seedAgentTab.childSessionId);
		const state = { ...upsertPanelTab(EMPTY_PANEL_TAB_STATE, descriptor), split: options.split ?? false };
		localStorage.setItem(storageKey, JSON.stringify(serializePanelTabs(state)));
	}
	const latest = { current: null as UsePanelTabsResult | null };
	const host = document.createElement("div");
	document.body.appendChild(host);
	hosts.push(host);
	const root = createRoot(host);
	roots.push(root);

	function Harness() {
		const panelTabs = usePanelTabs(storageKey);
		const current = useRef<UsePanelTabsResult | null>(null);
		current.current = panelTabs;
		latest.current = current.current;
		return (
			<ContextPanel
				snap={{
					...snap,
					sessionId: currentOptions?.sessionId ?? snap.sessionId,
					agents: currentOptions?.agents ?? snap.agents,
					progress: currentOptions?.progress ?? snap.progress,
				}}
				rpc={currentOptions?.rpc ?? rpc}
				open={currentOptions?.open ?? true}
				browserOpenRequest={currentOptions?.browserOpenRequest}
				onViewChange={() => {}}
				panelTabs={panelTabs}
				onExpandPanel={currentOptions?.onExpandPanel}
				agentId={null}
				onAgentSelect={() => {}}
				onOpenSession={currentOptions?.onOpenSession}
				extTabs={extTabs}
			/>
		);
	}

	const render = (nextOptions?: PanelOptions): void => {
		if (nextOptions) currentOptions = { ...currentOptions, ...nextOptions };
		act(() => root.render(<Harness />));
	};
	render();
	return { latest, render };
}

function click(element: Element): void {
	act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function openAddMenu(column = 0): void {
	const buttons = [
		...document.querySelectorAll<HTMLButtonElement>(`.gui-pane-tool[aria-label="${t("general.newTab")}"]`),
	];
	click(buttons[column]!);
}

function menuItem(label: string): HTMLButtonElement {
	return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button =>
		button.textContent?.includes(label),
	)!;
}

function panelTabByText(text: string): HTMLElement {
	const tab = [...document.querySelectorAll<HTMLElement>('.gui-surface-tab[role="tab"]')].find(candidate =>
		candidate.textContent?.includes(text),
	);
	if (!tab) throw new Error(`missing panel tab ${text}`);
	return tab;
}

function openTabMenu(id: string): void {
	const tab = panelTabByText(id);
	act(() => tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
}

function openManaged(id: string): void {
	act(() => void createTab(`https://${id}.test`, { tabId: id }).catch(() => {}));
}

function arrangeBrowserInSecondColumn(latest: { current: UsePanelTabsResult | null }): void {
	openManaged("managed-a");
	act(() => {
		latest.current?.moveToColumn("browser::managed-a", 1);
		latest.current?.activate("notes::");
	});
	expect(latest.current?.activeId).toBe("notes::");
	expect(latest.current?.tabs.find(tab => tab.id === "browser::managed-a")?.column).toBe(1);
}

function emitBrowserState(activity: ManagedBrowserActivity | null, busyTabIds: string[], agentActivity = false): void {
	act(() => stateListener?.({ port: 9230, activity, busyTabIds, agentActivity }));
}

beforeEach(() => {
	setLocale("en-US");
	stateListener = null;
	Object.defineProperty(window, "electronAPI", { configurable: true, writable: true, value: electronApi() });
	globalThis.ResizeObserver = class {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	};
	wireHost();
});

afterEach(() => {
	while (roots.length) act(() => roots.pop()?.unmount());
	while (hosts.length) hosts.pop()?.remove();
	while (sessionStores.length) sessionStores.pop()?.dispose();
	for (const tab of getHostState().tabs) {
		attachElement(tab.id, null);
		closeTab(tab.id, { notifyMain: false });
	}
	setBrowserSession(null);
	unwireHost();
	for (const key of storageKeys.splice(0)) localStorage.removeItem(key);
	Object.defineProperty(window, "electronAPI", { configurable: true, writable: true, value: originalElectronAPI });
	globalThis.ResizeObserver = OriginalResizeObserver;
	stateListener = null;
	vi.restoreAllMocks();
});

afterAll(() => setLocale(originalLocale));

describe("ContextPanel managed browser integration", () => {
	it("localizes every add-menu surface and opens browser content by managed id", () => {
		const { latest } = mountPanel();
		openAddMenu();
		const expected = SURFACES.filter(surface => surface.group === "primary" && surface.availability === "always").map(
			surface => t(surface.label as TranslationKey),
		);
		const labels = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map(button =>
			button.textContent?.trim(),
		);
		expect(labels).toEqual(expected);

		click(menuItem(t("browser")));
		const managed = getHostState().tabs[0]!;
		expect(latest.current?.tabs).toHaveLength(1);
		expect(latest.current?.tabs[0]).toMatchObject({
			id: `browser::${managed.id}`,
			surface: "browser",
			target: managed.id,
		});
		expect(latest.current?.tabs.some(tab => tab.id.includes("settings.browser"))).toBe(false);
	});

	it("projects host title, favicon, active tab and Agent activity without churn", () => {
		const { latest, render } = mountPanel({ seedNotes: true });
		act(() => void createTab("https://example.test", { tabId: "managed-a" }).catch(() => {}));
		expect(latest.current?.activeId).toBe("browser::managed-a");

		const element = document.createElement("div") as unknown as HostWebview;
		element.getWebContentsId = () => 41;
		element.getURL = () => "https://example.test";
		element.getTitle = () => "Example title";
		element.canGoBack = () => false;
		element.canGoForward = () => false;
		element.isLoading = () => false;
		act(() => attachElement("managed-a", element));
		act(() => {
			const title = new Event("page-title-updated") as Event & { title?: string };
			title.title = "Example title";
			element.dispatchEvent(title);
			const favicon = new Event("page-favicon-updated") as Event & { favicons?: string[] };
			favicon.favicons = ["https://example.test/favicon.png"];
			element.dispatchEvent(favicon);
		});
		expect(latest.current?.tabs.find(tab => tab.id === "browser::managed-a")?.label).toBe("Example title");

		emitBrowserState(
			{
				id: "op-a",
				action: "read",
				summary: "Reading",
				domain: "example.test",
				status: "dispatched",
				tabId: "managed-a",
				at: 1,
			},
			["managed-a"],
		);
		expect(document.querySelector('.gui-surface-tab img[src="https://example.test/favicon.png"]')).not.toBeNull();
		expect(document.querySelector(".gui-surface-tab-agent")).not.toBeNull();

		act(() => void createTab("https://second.test", { tabId: "managed-b" }).catch(() => {}));
		act(() => selectTab("managed-a"));
		expect(latest.current?.activeId).toBe("browser::managed-a");
		const stableTabs = latest.current?.tabs;
		render();
		expect(latest.current?.tabs).toBe(stableTabs);
	});

	it("closes and duplicates browser tabs through the host, including batch close", () => {
		const { latest } = mountPanel({ seedNotes: true });
		act(() => void createTab("https://example.test", { tabId: "managed-a" }).catch(() => {}));
		openTabMenu("example.test");
		click(menuItem(t("general.duplicateTab")));
		expect(getHostState().tabs).toHaveLength(2);
		expect(getHostState().tabs[1]?.url).toBe("https://example.test");
		expect(latest.current?.tabs.filter(tab => tab.surface === "browser")).toHaveLength(2);
		expect(latest.current?.tabs.every(tab => !tab.id.includes("#copy"))).toBe(true);

		openTabMenu("example.test");
		click(menuItem(t("general.closeTab")));
		expect(getHostState().tabs).toHaveLength(1);
		openTabMenu("example.test");
		click(menuItem(t("general.closeOtherTabs")));
		expect(getHostState().tabs).toHaveLength(1);
		expect(latest.current?.tabs).toHaveLength(1);
	});

	it("offers browser tab actions according to the page state", () => {
		mountPanel({ seedNotes: true });
		act(() => void createTab("about:blank", { tabId: "blank-tab" }).catch(() => {}));
		openTabMenu(t("tools.browserEmptyTab"));
		let labels = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map(button =>
			button.textContent?.trim(),
		);
		expect(labels).toContain(t("tools.browserNewTabRight"));
		expect(labels).toContain(t("tools.browserRenameTab"));
		expect(labels).toContain(t("tools.browserMuteTab"));
		expect(menuItem(t("tools.browserCopyUrl")).disabled).toBe(true);
		expect(menuItem(t("tools.browserRefresh")).disabled).toBe(true);
		act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

		act(() => void createTab("https://example.test", { tabId: "page-tab" }).catch(() => {}));
		openTabMenu("example.test");
		labels = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map(button =>
			button.textContent?.trim(),
		);
		expect(labels).toContain(t("tools.browserRefresh"));
		expect(menuItem(t("tools.browserCopyUrl")).disabled).toBe(false);
		expect(menuItem(t("tools.browserOpenSystem")).disabled).toBe(false);
	});

	it("keeps browser tabs and active panel projections independent per session", () => {
		const { latest, render } = mountPanel();
		openManaged("session-a-page");
		expect(latest.current?.tabs.filter(tab => tab.surface === "browser")).toHaveLength(1);

		render({ sessionId: "session-b" });
		expect(latest.current?.tabs.filter(tab => tab.surface === "browser")).toHaveLength(0);
		openManaged("session-b-page");
		expect(latest.current?.tabs.find(tab => tab.surface === "browser")?.target).toBe("session-b-page");

		render({ sessionId: "s1" });
		expect(latest.current?.tabs.find(tab => tab.surface === "browser")?.target).toBe("session-a-page");
	});

	it("keeps browser projection in the requested split column", () => {
		const { latest } = mountPanel({ seedNotes: true, split: true });
		openAddMenu(1);
		click(menuItem(t("browser")));
		const managed = getHostState().tabs[0]!;
		expect(latest.current?.split).toBe(true);
		expect(latest.current?.tabs.find(tab => tab.id === `browser::${managed.id}`)?.column).toBe(1);
	});

	it("reveals a background Agent tab by managed id and expands a folded panel", () => {
		const expand = vi.fn();
		const { latest } = mountPanel({ seedNotes: true, open: false, onExpandPanel: expand });
		act(() => void createTab("https://a.test", { tabId: "managed-a" }).catch(() => {}));
		act(() => void createTab("https://b.test", { tabId: "managed-b" }).catch(() => {}));
		act(() => latest.current?.activate("notes::"));
		expect(latest.current?.activeId).toBe("notes::");

		emitBrowserState(
			{
				id: "op-reveal",
				action: "read",
				summary: "Reading",
				domain: "a.test",
				status: "dispatched",
				tabId: "managed-a",
				at: 2,
			},
			["managed-a"],
			true,
		);
		expect(getHostState().activeId).toBe("managed-a");
		expect(latest.current?.activeId).toBe("browser::managed-a");
		expect(expand).toHaveBeenCalledTimes(1);
	});

	it("resolves openRequest to a managed browser tab instead of a placeholder", () => {
		const { latest } = mountPanel({ browserOpenRequest: { url: "https://example.test", nonce: 1 } });
		const managed = getHostState().tabs[0]!;
		expect(managed).toBeDefined();
		expect(latest.current?.activeId).toBe(`browser::${managed.id}`);
		expect(latest.current?.tabs[0]?.target).toBe(managed.id);
	});
});

describe("ContextPanel browser projection regressions", () => {
	it("rail reopen preserves the existing browser split column", async () => {
		const storageKey = "musepi-gui-panel-tabs-rail-split";
		storageKeys.push(storageKey);
		localStorage.removeItem(storageKey);
		const { code } = await compileComponentModule(`${process.cwd()}/src/plugins/panel/page.tsx`);
		const store = new GuiSessionStore("rail-split", { entries: [], cursor: 0 }, "C:/workspace");
		sessionStores.push(store);
		const chatRpc = {
			request: async (method: string) => {
				if (method === "extensions.list") {
					return {
						extensions: [],
						tabs: [],
						providers: [],
						components: [
							{ slot: "panel.shell", extensionId: "panel", code },
							{ slot: "panel.tab.browser", extensionId: "browser-ui", code: "", error: "test browser surface" },
						],
						toolViews: [],
						widgets: [],
						statusBarSegments: [],
						slots: { exact: [], prefixes: [] },
					};
				}
				if (method.startsWith("models.list")) return [];
				if (method === "session.turns") return { turns: [] };
				if (method === "git.branches") return { error: "not a repository" };
				return {};
			},
			addEventListener: () => () => {},
		} as unknown as RpcClient;
		const host = document.createElement("div");
		document.body.appendChild(host);
		hosts.push(host);
		const root = createRoot(host);
		roots.push(root);
		await act(async () =>
			root.render(
				<ChatView
					store={store}
					rpc={chatRpc}
					onSend={() => {}}
					onStop={() => {}}
					onDecideApproval={() => {}}
					busy={false}
					project="C:/workspace"
					onProject={() => {}}
					onSubmitNewSession={() => {}}
					rightPanelOpen
					terminalOpen={false}
					focusMode={false}
					onToggleFocus={() => {}}
				/>,
			),
		);
		for (let attempt = 0; attempt < 50 && !host.querySelector(".gui-pane-right"); attempt++) {
			await act(async () => Bun.sleep(10));
		}
		expect(host.querySelector(".gui-pane-right")).not.toBeNull();
		click(host.querySelector(`.gui-pane-tool[aria-label="${t("settings.splitPanel")}"]`)!);
		openAddMenu(0);
		click(menuItem(t("project knowledge")));
		openAddMenu(1);
		click(menuItem(t("browser")));
		const managed = getHostState().tabs[0]!;
		click(panelTabByText("notes"));
		const browserRail = host.querySelector<HTMLButtonElement>(`.gui-right-rail-btn[aria-label="${t("browser")}"]`);
		expect(browserRail).not.toBeNull();
		await act(async () => browserRail!.click());
		const persisted = JSON.parse(localStorage.getItem(storageKey)!) as {
			activeId: string | null;
			columnActive: [string | null, string | null];
		};
		expect(persisted.activeId).toBe(`browser::${managed.id}`);
		expect(persisted.columnActive).toEqual(["notes::", `browser::${managed.id}`]);
	});

	it("Agent reveal preserves the existing browser split column", () => {
		const { latest } = mountPanel({ seedNotes: true, split: true });
		arrangeBrowserInSecondColumn(latest);
		emitBrowserState(
			{
				id: "op-split-reveal",
				action: "read",
				summary: "Reading",
				domain: "managed-a.test",
				status: "dispatched",
				tabId: "managed-a",
				at: 3,
			},
			["managed-a"],
			true,
		);
		expect(latest.current?.activeId).toBe("browser::managed-a");
		expect(latest.current?.columnActive).toEqual(["notes::", "browser::managed-a"]);
	});

	it("openRequest preserves the existing browser split column", () => {
		const { latest, render } = mountPanel({ seedNotes: true, split: true });
		arrangeBrowserInSecondColumn(latest);
		render({ browserOpenRequest: { url: "https://managed-a.test", nonce: 1 } });
		expect(latest.current?.activeId).toBe("browser::managed-a");
		expect(latest.current?.columnActive).toEqual(["notes::", "browser::managed-a"]);
	});

	it("keeps every one of 13 browser guests projected without eviction churn", () => {
		const { latest, render } = mountPanel();
		for (let index = 0; index < 13; index++) openManaged(`managed-${index}`);
		expect(getHostState().tabs).toHaveLength(13);
		expect(latest.current?.tabs.filter(tab => tab.surface === "browser")).toHaveLength(13);
		expect(latest.current?.tabs.map(tab => tab.id)).toEqual(
			Array.from({ length: 13 }, (_, index) => `browser::managed-${index}`),
		);
		const stable = latest.current?.tabs;
		render();
		expect(latest.current?.tabs).toBe(stable);
	});

	it("places a duplicated browser tab immediately after its source", () => {
		const { latest } = mountPanel();
		openManaged("managed-a");
		openManaged("managed-b");
		openManaged("managed-c");
		openTabMenu("managed-a");
		click(menuItem(t("general.duplicateTab")));
		const duplicate = getHostState().tabs.at(-1)!;
		expect(latest.current?.tabs.map(tab => tab.id)).toEqual([
			"browser::managed-a",
			`browser::${duplicate.id}`,
			"browser::managed-b",
			"browser::managed-c",
		]);
	});

	it("closing an active browser keeps the reordered panel neighbour and selects it in host", () => {
		const { latest } = mountPanel();
		openManaged("managed-a");
		openManaged("managed-b");
		openManaged("managed-c");
		openManaged("managed-d");
		act(() => latest.current?.reorder("browser::managed-c", "browser::managed-b"));
		click(panelTabByText("managed-a"));
		click(panelTabByText("managed-a").querySelector(".gui-surface-tab-close")!);
		expect(latest.current?.activeId).toBe("browser::managed-c");
		expect(getHostState().activeId).toBe("managed-c");
	});

	it("closing an active browser honours a cross-column right neighbour over the host tail", () => {
		const { latest } = mountPanel({ split: true });
		openManaged("managed-a");
		openManaged("managed-b");
		openManaged("managed-d");
		openManaged("managed-c");
		act(() => latest.current?.moveToColumn("browser::managed-b", 1));
		click(panelTabByText("managed-c"));
		click(panelTabByText("managed-c").querySelector(".gui-surface-tab-close")!);
		expect(latest.current?.activeId).toBe("browser::managed-b");
		expect(latest.current?.columnActive[1]).toBe("browser::managed-b");
		expect(getHostState().activeId).toBe("managed-b");
	});

	it("closing an active browser keeps a non-browser panel neighbour without host reveal stealing focus", () => {
		const { latest } = mountPanel({ seedNotes: true });
		openManaged("managed-b");
		openManaged("managed-a");
		act(() => latest.current?.reorder("notes::", "browser::managed-a"));
		click(panelTabByText("managed-a"));
		click(panelTabByText("managed-a").querySelector(".gui-surface-tab-close")!);
		expect(latest.current?.activeId).toBe("notes::");
		expect(getHostState().activeId).toBe("managed-b");
	});
});

describe("ContextPanel 子代理会话标签页", () => {
	const scout: AgentSnapshot = {
		id: "a1",
		displayName: "scout",
		kind: "sub",
		status: "running",
		hasSessionFile: true,
		createdAt: 1,
		lastActivity: 2,
	};

	interface AgentCall {
		method: string;
		params?: unknown;
	}

	function agentRpc(calls: AgentCall[]): RpcClient {
		return {
			request: async (method: string, params?: unknown): Promise<unknown> => {
				calls.push({ method, params });
				if (method === "agents.transcript") return { text: "", newSize: 0 };
				if (method === "session.agents") return { agents: [] };
				return null;
			},
			addEventListener: () => () => {},
		} as unknown as RpcClient;
	}

	function panel(): HTMLElement {
		return document.querySelector<HTMLElement>(".gui-pane-right")!;
	}

	async function flush(): Promise<void> {
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
	}

	it("点击 roster 行打开 agent surface 的标签页，dedupeKey 为 agent id", () => {
		const { latest } = mountPanel({ agents: [scout] });
		act(() => latest.current?.open({ surface: "agents", label: t("agents") }));
		const row = panel().querySelector<HTMLButtonElement>(".ag-row");
		expect(row).not.toBeNull();

		click(row!);
		const opened = latest.current?.tabs.find(tab => tab.surface === "agent");
		expect(opened).toMatchObject({ id: "agent::a1", target: "a1", dedupeKey: "a1", label: "scout" });
		expect(latest.current?.activeId).toBe("agent::a1");
	});

	it("agent 标签页渲染子代理名并拉取 transcript", async () => {
		const calls: AgentCall[] = [];
		const { latest } = mountPanel({ agents: [scout], rpc: agentRpc(calls) });
		act(() => latest.current?.open(agentTabDescriptor(scout)));
		await flush();

		expect(panel().textContent).toContain("scout");
		expect(panel().querySelector(".ag-drawer-body")).not.toBeNull();
		expect(panel().querySelector(".ag-chat-input")).not.toBeNull();
		const fetchCall = calls.find(call => call.method === "agents.transcript");
		expect(fetchCall?.params).toMatchObject({ agentId: "a1", fromByte: 0 });
	});

	it("agent 不在快照时渲染空态，并可用标签页的 target 打开子会话", () => {
		const opened: string[] = [];
		mountPanel({
			seedAgentTab: { id: "gone", displayName: "gone-agent", childSessionId: "child-9" },
			onOpenSession: id => opened.push(id),
		});
		expect(panel().querySelector(".gui-pane-tab-empty-title")?.textContent).toBe(t("agents.subagentUnavailable"));
		const openButton = [...panel().querySelectorAll<HTMLButtonElement>("button")].find(
			button => button.textContent === t("general.openSubagentSession"),
		);
		expect(openButton).toBeDefined();

		click(openButton!);
		expect(opened).toEqual(["child-9"]);
	});
});
