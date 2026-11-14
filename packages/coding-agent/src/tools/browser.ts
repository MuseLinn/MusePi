import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@musepi/musepi-type";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@musepi/pi-agent-core";
import type { ToolExample } from "@musepi/pi-ai";
import { prompt, Snowflake, untilAborted } from "@musepi/pi-utils";
import { isCapabilityActive } from "../extensibility/capability-activation";
import browserDescription from "../prompts/tools/browser.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import { enforceInlineByteCap } from "../session/streaming-output";
import { truncateForPrompt } from "./approval";
import { resolveCmuxKind } from "./browser/cmux/rpc";
import { BROWSER_DEVICE_PROFILES, type BrowserDeviceConfiguration, deviceActionCode } from "./browser/devices";
import { managedBrowserBridgeUrl, managedBrowserEnabled } from "./browser/managed-bridge";
import { type BrowserNavigationResult, navigationActionCode } from "./browser/navigation";
import { type PageTextSnapshot, pageTextCode } from "./browser/page-text";
import { assertSafeBrowserDestination } from "./browser/policy";
import {
	acquireBrowser,
	type BrowserHandle,
	type BrowserKind,
	type BrowserKindTag,
	holdBrowser,
	releaseBrowser,
} from "./browser/registry";
import { resolveRelayKind } from "./browser/relay/kind";
import { type BrowserVisualInteraction, type SnapshotAction, snapshotActionCode } from "./browser/snapshot-actions";
import {
	type BrowserElementsPage,
	type BrowserVisualSnapshot,
	createElementSnapshot,
	createVisualSnapshot,
	paginateElementSnapshot,
	readElementSnapshot,
	readVisualSnapshot,
} from "./browser/snapshots";
import {
	type BrowserDownloadRecord,
	type BrowserHistoryRecord,
	type BrowserStatus,
	browserStatusFromTabs,
	readManagedBrowserRecords,
	readManagedBrowserStatus,
} from "./browser/state";
import type {
	BrowserDialogInfo,
	BrowserHandledDialog,
	BrowserOperation,
	Observation,
	RunResultOk,
	ScreenshotResult,
} from "./browser/tab-protocol";
import {
	type AcquireTabResult,
	acquireTab,
	activateManagedPanel,
	activateTabTarget,
	dropHeadlessTabs,
	getTab,
	listTabs,
	releaseAllTabs,
	releaseManagedAgent,
	releaseTab,
	runInTab,
	stopTabLoading,
} from "./browser/tab-supervisor";
import { type BrowserVisualCrop, resolveVisualCrop } from "./browser/visual-crop";
import { type BrowserWaitResult, pageWaitCode } from "./browser/wait";
import type { OutputMeta } from "./output-meta";
import { resolveToCwd } from "./path-utils";
import { ToolAbortError, ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

export {
	type AriaSnapshotOptions,
	buildAriaSnapshotScript,
	parseAriaRefSelector,
} from "./browser/aria/aria-snapshot";
export { cmuxSnapshotToObservation, mapWaitUntil, resolveCmuxKind, serializeEval } from "./browser/cmux/rpc";
export { CmuxSocketClient } from "./browser/cmux/socket-client";
export { extractReadableFromHtml, type ReadableFormat, type ReadableResult } from "./browser/readable";
export { DEFAULT_RELAY_URL, type RelayKind, resolveRelayKind } from "./browser/relay/kind";
export type { Observation, ObservationEntry } from "./browser/tab-protocol";

const DEFAULT_TAB_NAME = "main";

const appSchema = type({
	"path?": type("string").describe("binary path to spawn"),
	"cdp_url?": type("string").describe("existing cdp endpoint"),
	"relay?": type("boolean").describe("drive the user's own tabs via the musepi browser relay"),
	"args?": type("string[]").describe("extra cli args"),
	"target?": type("string").describe("substring to pick a window"),
});

const browserSchema = type({
	action: type(
		"'open' | 'close' | 'run' | 'status' | 'read' | 'screenshot' | 'elements' | 'visual' | 'visual_crop' | 'click' | 'double_click' | 'right_click' | 'click_if_interactive' | 'visual_type' | 'fill' | 'type' | 'press' | 'hover' | 'scroll' | 'drag' | 'drag_path' | 'select_option' | 'set_checked' | 'scroll_into_view' | 'dialog' | 'dialog_respond' | 'activate' | 'activate_panel' | 'switch' | 'release' | 'device_profiles' | 'set_device' | 'history' | 'downloads' | 'navigate' | 'search' | 'back' | 'forward' | 'reload' | 'stop' | 'wait_load' | 'wait_for'",
	).describe("operation"),
	"name?": type("string").describe("tab id (default 'main')"),
	"url?": type("string").describe("url to open"),
	"query?": type("string").describe("search text for the configured search engine"),
	"state?": type("'committed' | 'dom_ready' | 'complete'").describe("document load state for wait_load"),
	"condition?": {
		kind: "'element' | 'text' | 'url'",
		"locator?": { role: "string", "name?": "string", "exact?": "boolean" },
		"state?": "'visible' | 'hidden' | 'enabled' | 'present' | 'absent'",
		"text?": "string",
		"match?": "'exact' | 'contains' | 'prefix'",
		"value?": "string",
	},
	"timeoutMs?": type("number").describe("page condition timeout, up to 30000 ms"),
	"stableForMs?": type("number").describe("required condition stability, 0-5000 ms"),
	"app?": appSchema,
	"viewport?": {
		width: "number",
		height: "number",
		"scale?": "number",
	},
	"wait_until?": type("'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2'").describe(
		"navigation wait condition",
	),
	"dialogs?": type("'accept' | 'dismiss'").describe("auto-handle dialogs"),
	"accept?": type("boolean").describe("accept or dismiss the pending dialog"),
	"code?": type("string").describe("js body to run in tab"),
	"scope?": type("'viewport' | 'document' | 'element'").describe(
		"rendered text or element scope (default 'viewport')",
	),
	"maxChars?": type("number").describe("read/element output budget, 2048-24000 characters"),
	"cursor?": type("string").describe("nextCursor from the previous read or element snapshot"),
	"limit?": type("number").describe("maximum elements per snapshot page (1-500, default 100)"),
	"role?": type("string").describe("filter elements by exact accessibility role"),
	"filterText?": type("string").describe("filter elements by name or value substring"),
	"snapshotId?": type("string").describe("snapshot id returned by elements or visual"),
	"ref?": type("string").describe("element ref from the same elements snapshot"),
	"x?": type("number").describe("x coordinate in returned screenshot pixels"),
	"y?": type("number").describe("y coordinate in returned screenshot pixels"),
	"radius?": type("number").describe("nearby interactive-candidate radius, 8-128 pixels"),
	"deltaX?": type("number").describe("horizontal scroll delta in screenshot pixels"),
	"deltaY?": type("number").describe("vertical scroll delta in screenshot pixels"),
	"from?": { x: "number", y: "number" },
	"to?": { x: "number", y: "number" },
	"points?": type({ x: "number", y: "number" }, "[]").describe("ordered visual drag-path points"),
	"button?": type("'left' | 'right' | 'middle'").describe("pointer button for visual drag_path"),
	"durationMs?": type("number").describe("total visual drag-path movement time"),
	"modifiers?": type("'Alt' | 'Control' | 'Meta' | 'Shift'", "[]").describe("keys held during drag_path"),
	"text?": type("string").describe("text to enter"),
	"key?": type("string").describe("key or chord such as Enter or ControlOrMeta+A"),
	"value?": type("string").describe("option value for select_option"),
	"checked?": type("boolean").describe("checked state for set_checked"),
	"replace?": type("boolean").describe("replace existing text instead of appending"),
	"selector?": type("string").describe("optional element selector for screenshot"),
	"fullPage?": type("boolean").describe("capture the full page instead of the viewport"),
	"region?": {
		x: "number",
		y: "number",
		width: "number",
		height: "number",
	},
	"device?": {
		enabled: "boolean",
		"orientation?": type("'portrait' | 'landscape'"),
		"profileId?": type(
			"'iphone-se' | 'iphone-12-pro' | 'iphone-14-pro' | 'iphone-14-pro-max' | 'pixel-7' | 'galaxy-s20-ultra' | 'ipad-mini' | 'ipad-pro-13' | 'iphone-duo-outer' | 'iphone-duo-inner' | 'iphone-16' | 'iphone-16-pro' | 'iphone-16-pro-max' | 'pixel-8' | 'pixel-9' | 'desktop-1280' | 'desktop-1440' | 'desktop-1920' | 'responsive'",
		),
		"scaleMode?": type("'fit' | 'fixed'"),
		"scale?": "number",
		"width?": "number",
		"height?": "number",
	},
	"timeout?": type("number").describe("timeout in seconds"),
	"all?": type("boolean").describe("close every tab"),
	"kill?": type("boolean").describe("also kill spawned-app browsers"),
});

/** Input schema for the browser tool. */
export type BrowserParams = typeof browserSchema.infer;

export interface BrowserActionReceipt {
	action: string;
	status: "completed" | "failed";
	target?: string;
	url?: string;
	error?: string;
}

/** Details describing a browser tool execution result (for renderers + transcript). */
export interface BrowserToolDetails {
	action: BrowserParams["action"];
	name?: string;
	url?: string;
	browser?: BrowserKindTag;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	observation?: Observation;
	screenshots?: ScreenshotResult[];
	operations?: BrowserOperation[];
	status?: BrowserStatus;
	pageText?: PageTextSnapshot;
	pageScreenshot?: ScreenshotResult & { capturedAt: string };
	elementsSnapshot?: BrowserElementsPage;
	visualSnapshot?: BrowserVisualSnapshot;
	visualCrop?: BrowserVisualCrop;
	deviceProfiles?: typeof BROWSER_DEVICE_PROFILES;
	deviceConfiguration?: BrowserDeviceConfiguration;
	history?: BrowserHistoryRecord[];
	downloads?: BrowserDownloadRecord[];
	navigation?: BrowserNavigationResult;
	waitResult?: BrowserWaitResult;
	visualInteraction?: BrowserVisualInteraction;
	actionReceipt?: BrowserActionReceipt;
	pendingDialogs?: BrowserDialogInfo[];
	handledDialogs?: BrowserHandledDialog[];
	control?: {
		action: "activate" | "activate_panel" | "switch" | "release";
		activeTabId?: string;
		visibleTabId?: string;
		panelVisible?: boolean;
		released?: boolean;
	};
	result?: string;
	meta?: OutputMeta;
}

/** 浏览器后端组件 id（builtin-registry browser 行 components 声明同步）。
 *  launch = 脚本启动的 Chromium（browser.headless 控制有头/无头）；
 *  attach = 接管已有浏览器（CDP 端点 / relay 扩展 / cmux / spawn-and-attach）；
 *  gui = 托管面板浏览器桥（browser.gui，agent 页面开进右侧面板）。 */
export type BrowserBackendComponent = "launch" | "attach" | "gui";

/** BrowserKind → 后端组件分组的唯一映射。gui 是 connected 的 gui:true
 *  变体，其余 connected/spawned/relay/cmux 全属 attach。 */
function browserBackendComponent(kind: BrowserKind): BrowserBackendComponent {
	if (kind.kind === "connected") return kind.gui ? "gui" : "attach";
	return kind.kind === "headless" ? "launch" : "attach";
}

export function resolveBrowserKind(params: BrowserParams, session: ToolSession): BrowserKind {
	const disabled = new Set<BrowserBackendComponent>();
	for (const backend of ["launch", "attach", "gui"] as const) {
		if (!isCapabilityActive("browser", backend)) disabled.add(backend);
	}
	/** 显式 app 参数指向被禁后端 = 用户/agent 显式意图，给结构化
	 *  DISABLED_BACKEND，不静默回退（terminal-provider 同哲学）。 */
	const denyExplicit = (kind: BrowserKind): BrowserKind => {
		const backend = browserBackendComponent(kind);
		if (disabled.has(backend)) {
			throw new ToolError(`browser backend "${backend}" is disabled (plugin component toggle)`, {
				code: "DISABLED_BACKEND",
				backend,
			});
		}
		return kind;
	};
	const app = params.app;
	if (app?.cdp_url) {
		return denyExplicit({ kind: "connected", cdpUrl: app.cdp_url.replace(/\/+$/, "") });
	}
	if (app?.path) {
		const exe = resolveToCwd(app.path, session.cwd);
		return denyExplicit({ kind: "spawned", path: exe });
	}
	const relayUrl = session.settings.get("browser.relayUrl") as string | undefined;
	// Explicit app.relay wins over every setting; PI_BROWSER_RELAY stays the
	// final kill switch (a relay that is down would otherwise brick the tool).
	if (app?.relay) {
		const relayKind = resolveRelayKind({ settingEnabled: true, url: relayUrl });
		if (relayKind) return denyExplicit(relayKind);
	}
	// Relay before cdpUrl among settings: enabling the opt-out-by-default relay
	// is a deliberate mode selection, while cdpUrl is a standing fallback
	// endpoint. A configured endpoint is a default, not an override: explicit
	// app options win.
	if (app?.relay !== false && !disabled.has("attach")) {
		const relayKind = resolveRelayKind({
			settingEnabled: session.settings.get("browser.relay") as boolean | undefined,
			url: relayUrl,
		});
		if (relayKind) return relayKind;
	}
	// Settings chain below is defaults, not overrides: a backend disabled by
	// the plugin component toggle is skipped (never attempted), falling through
	// to the next candidate — same contract as terminal auto-fallback.
	const configuredCdpUrl = (session.settings.get("browser.cdpUrl") as string | undefined)?.trim();
	if (!disabled.has("attach") && configuredCdpUrl) {
		return { kind: "connected", cdpUrl: configuredCdpUrl.replace(/\/+$/, "") };
	}
	if (!disabled.has("attach")) {
		const cmuxKind = resolveCmuxKind({
			settingEnabled: session.settings.get("browser.cmux") as boolean | undefined,
		});
		if (cmuxKind) {
			return cmuxKind;
		}
	}
	// GUI managed browser: the desktop app's right-pane browser (Electron
	// WebContentsView) exposes a loopback CDP bridge the tool attaches to like
	// any connected browser. Opt-in via `browser.gui`; wins over headless so
	// the agent's work is visible in the panel and shares its login state.
	// The `gui` marker lets the supervisor drive a dedicated agent tab instead
	// of adopting whatever tab the user is looking at.
	if (managedBrowserEnabled(session.settings) && !disabled.has("gui")) {
		const guiUrl = resolveManagedBrowserUrl(session);
		if (guiUrl) {
			return { kind: "connected", cdpUrl: guiUrl.replace(/\/+$/, ""), gui: true };
		}
	}
	const headless = session.settings.get("browser.headless") as boolean;
	if (!disabled.has("launch")) return { kind: "headless", headless };
	throw new ToolError("no browser backend available (all backends disabled by plugin components)", {
		code: "NO_BACKEND",
	});
}

/**
 * Endpoint for the managed browser: the live bridge's ACTUAL port (9230-9239
 * is a retry range, so the setting's default can be off by nine), else the
 * configured/default `browser.guiUrl`.
 */
function resolveManagedBrowserUrl(session: ToolSession): string | undefined {
	const live = managedBrowserBridgeUrl();
	if (live) return live;
	return (session.settings.get("browser.guiUrl") as string | undefined)?.trim() || undefined;
}

/**
 * Browser tool: stateful, multi-tab. Three actions:
 * - `open`  → acquire/create a named tab on a browser kind (headless | spawned | connected) and optionally goto a url.
 * - `close` → release a named tab (or all tabs); dispose browser when refcount hits 0.
 * - `run`   → execute JS code against an existing tab with `page`/`browser`/`tab` helpers in scope.
 */
export class BrowserTool implements AgentTool<typeof browserSchema, BrowserToolDetails> {
	readonly name = "browser";
	readonly approval = "exec" as const;
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<BrowserParams>;
		const lines = [`Action: ${typeof params.action === "string" ? params.action : "(missing)"}`];
		const tabName = typeof params.name === "string" ? params.name : DEFAULT_TAB_NAME;
		lines.push(`Tab: ${truncateForPrompt(tabName)}`);
		if (typeof params.url === "string" && params.url.length > 0) {
			lines.push(`URL: ${truncateForPrompt(params.url)}`);
		}
		if (typeof params.code === "string" && params.code.length > 0) {
			lines.push(`Code:\n${truncateForPrompt(params.code)}`);
		}
		return lines;
	};
	readonly label = "Browser";
	readonly loadMode = "discoverable";
	readonly summary = "Control the app's built-in browser, or a headless Chromium when no desktop app is attached";
	readonly parameters = browserSchema;
	readonly strict = true;

	readonly examples: readonly ToolExample<typeof browserSchema.infer>[] = [
		{
			caption: "Inspect browser and tab state",
			call: { action: "status" },
		},
		{
			caption: "Open a tab",
			call: { action: "open", name: "docs", url: "https://example.com" },
		},
		{
			caption: "Wait for visible text with observable evidence",
			call: {
				action: "wait_for",
				name: "docs",
				condition: { kind: "text", text: "Done", match: "contains", state: "present" },
				timeoutMs: 10000,
				stableForMs: 250,
			},
		},
		{
			caption: "Read rendered page text",
			call: { action: "read", name: "docs", scope: "viewport", maxChars: 12000 },
		},
		{
			caption: "Snapshot interactive elements",
			call: { action: "elements", name: "docs", scope: "viewport", limit: 100 },
		},
		{
			caption: "Click an element ref from that snapshot",
			call: { action: "click", name: "docs", snapshotId: "elements-1", ref: "e5" },
		},
		{
			caption: "Double-click an element ref",
			call: { action: "double_click", name: "docs", snapshotId: "elements-1", ref: "e5" },
		},
		{
			caption: "Open the context menu on an element ref",
			call: { action: "right_click", name: "docs", snapshotId: "elements-1", ref: "e5" },
		},
		{
			caption: "Capture a visual coordinate snapshot",
			call: { action: "visual", name: "docs" },
		},
		{
			caption: "Click a point in that visual snapshot",
			call: { action: "click", name: "docs", snapshotId: "visual-1", x: 120, y: 240 },
		},
		{
			caption: "Inspect a visual point without clicking nearby candidates",
			call: { action: "click_if_interactive", name: "docs", snapshotId: "visual-1", x: 120, y: 240, radius: 48 },
		},
		{
			caption: "Replace text at a visual input",
			call: {
				action: "visual_type",
				name: "docs",
				snapshotId: "visual-1",
				x: 120,
				y: 240,
				text: "hello",
				replace: true,
			},
		},
		{
			caption: "Read one element subtree",
			call: { action: "read", name: "docs", scope: "element", snapshotId: "elements-1", ref: "e5" },
		},
		{
			caption: "Reveal the managed panel without switching tabs",
			call: { action: "activate_panel", name: "docs" },
		},
		{
			caption: "Crop the original visual snapshot",
			call: {
				action: "visual_crop",
				name: "docs",
				snapshotId: "visual-1",
				region: { x: 100, y: 80, width: 320, height: 240 },
			},
		},
		{
			caption: "Draw a continuous path",
			call: {
				action: "drag_path",
				name: "docs",
				snapshotId: "visual-1",
				points: [
					{ x: 120, y: 240 },
					{ x: 180, y: 200 },
					{ x: 240, y: 240 },
				],
				durationMs: 400,
			},
		},
		{
			caption: "Apply a responsive mobile viewport",
			call: {
				action: "set_device",
				name: "docs",
				device: {
					enabled: true,
					profileId: "responsive",
					orientation: "portrait",
					scaleMode: "fit",
					width: 390,
					height: 844,
				},
			},
		},
		{
			caption: "Inspect retained download progress",
			call: { action: "downloads" },
		},
		{
			caption: "Answer the pending browser prompt",
			call: { action: "dialog_respond", name: "docs", accept: true, text: "MusePi Agent" },
		},
		{
			caption: "Reveal a managed tab",
			call: { action: "switch", name: "docs" },
		},
		{
			caption: "Release control without closing the page",
			call: { action: "release", name: "docs" },
		},
		{
			caption: "Read structured page data in the opened tab",
			call: {
				action: "run",
				name: "docs",
				code: "const obs = await tab.observe(); display(obs); return obs.elements.length;",
			},
		},
		{
			caption: "Click an observed element by id",
			call: {
				action: "run",
				name: "docs",
				code: "const obs = await tab.observe(); const link = obs.elements.find(e => e.role === 'link' && e.name === 'Sign in'); assert(link, 'Sign in link missing'); await (await tab.id(link.id)).click();",
			},
		},
		{
			caption: "Fill and submit a form via selectors",
			call: {
				action: "run",
				name: "docs",
				code: "await tab.fill('input[name=email]', 'me@example.com'); await tab.click('text/Continue');",
			},
		},
		{
			caption: "Capture a screenshot with metadata",
			call: { action: "screenshot", name: "docs", fullPage: false },
		},
		{
			caption: "Attach to an existing Electron app",
			call: {
				action: "open",
				name: "cursor",
				app: { path: "/Applications/Cursor.app/Contents/MacOS/Cursor" },
			},
		},
		{
			caption: "Close every tab and kill spawned-app processes",
			call: { action: "close", all: true, kill: true },
		},
	];

	constructor(private readonly session: ToolSession) {}
	#description?: string;
	get description(): string {
		// The managed-browser paragraph is injected ONLY on that channel — a
		// CLI/TUI run must not be told about a browser panel it cannot see.
		this.#description ??= prompt.render(browserDescription, {
			managedBrowser: managedBrowserEnabled(this.session.settings),
		});
		return this.#description;
	}

	/**
	 * Agent identity attached to the tabs this tool opens/runs. The registry
	 * carries both the display name and the spawning agent, which the tab
	 * supervisor uses to keep a subagent's tab ownership from outliving its
	 * parent — or from stealing the parent's tab name.
	 */
	#agentIdentity(): {
		agentId?: string;
		agentName?: string;
		parentAgentId?: string;
		parentAgentName?: string;
		parentSessionId?: string;
	} {
		const agentId = this.session.getAgentId?.() ?? undefined;
		if (!agentId) return {};
		const ref = this.session.agentRegistry?.get(agentId);
		const parentAgentId = ref?.parentId;
		const parentRef = parentAgentId ? this.session.agentRegistry?.get(parentAgentId) : undefined;
		return {
			agentId,
			agentName: ref?.displayName ?? agentId,
			parentAgentId,
			parentAgentName: parentRef?.displayName,
			// The parent's own session id is the key its dispose passes; a
			// subagent without a shared transcript mints its own id instead.
			parentSessionId: parentRef?.session?.sessionManager.getSessionId(),
		};
	}

	/** Restart browser to apply mode changes (e.g. headless toggle). Drops only headless browsers. */
	async restartForModeChange(): Promise<void> {
		await dropHeadlessTabs();
	}

	async execute(
		_toolCallId: string,
		params: BrowserParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<BrowserToolDetails>,
		_ctx?: AgentToolContext,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		try {
			throwIfAborted(signal);
			if (this.session.settings.get("browser.agentControl") === false) {
				throw new ToolError(
					'Browser agent control is disabled. Turn on "Allow Agent Control" in Settings → Browser (设置 → 浏览器).',
					{ code: "AGENT_CONTROL_DISABLED" },
				);
			}
			const timeoutSeconds = clampTimeout("browser", params.timeout, this.session.settings.get("tools.maxTimeout"));
			const timeoutMs = timeoutSeconds * 1000;
			const name = params.name ?? DEFAULT_TAB_NAME;
			const details: BrowserToolDetails = {
				action: params.action,
				...(params.action === "status" ? {} : { name }),
			};

			switch (params.action) {
				case "open":
					return await this.#open(name, params, details, timeoutMs, signal);
				case "close":
					return await this.#close(name, params, details, timeoutMs, signal);
				case "run":
					return await this.#run(name, params, details, timeoutMs, signal, _onUpdate);
				case "status":
					return await this.#status(details, timeoutMs, signal);
				case "read":
					return await this.#read(name, params, details, timeoutMs, signal, _onUpdate);
				case "screenshot":
					return await this.#screenshot(name, params, details, timeoutMs, signal, _onUpdate);
				case "elements":
					return await this.#elements(name, params, details, timeoutMs, signal, _onUpdate);
				case "visual":
					return await this.#visual(name, params, details, timeoutMs, signal, _onUpdate);
				case "visual_crop":
					return await this.#visualCrop(name, params, details, timeoutMs, signal, _onUpdate);
				case "click":
				case "double_click":
				case "right_click":
				case "click_if_interactive":
				case "visual_type":
				case "fill":
				case "type":
				case "press":
				case "hover":
				case "scroll":
				case "drag":
				case "drag_path":
				case "select_option":
				case "set_checked":
				case "scroll_into_view":
					return await this.#snapshotAction(name, params, details, timeoutMs, signal, _onUpdate);
				case "dialog":
					return await this.#dialog(name, params, details, timeoutMs, signal, _onUpdate);
				case "dialog_respond":
					return await this.#dialogRespond(name, params, details, timeoutMs, signal, _onUpdate);
				case "activate":
					return await this.#activate(name, params, details, timeoutMs, signal);
				case "activate_panel":
					return await this.#activatePanel(name, details);
				case "switch":
					return await this.#switch(name, params, details, timeoutMs, signal);
				case "release":
					return await this.#release(name, details);
				case "device_profiles":
					return await this.#deviceProfiles(details);
				case "set_device":
					return await this.#setDevice(name, params, details, timeoutMs, signal, _onUpdate);
				case "history":
					return await this.#records("history", details, timeoutMs, signal);
				case "downloads":
					return await this.#records("downloads", details, timeoutMs, signal);
				case "navigate":
				case "search":
				case "back":
				case "forward":
				case "reload":
				case "stop":
				case "wait_load":
					return await this.#navigation(name, params, details, timeoutMs, signal, _onUpdate);
				case "wait_for":
					return await this.#waitFor(name, params, details, timeoutMs, signal, _onUpdate);
				default:
					throw new ToolError(`Unsupported action: ${(params as BrowserParams).action}`);
			}
		} catch (error) {
			if (error instanceof ToolAbortError) throw error;
			if (error instanceof Error && error.name === "AbortError") {
				throw new ToolAbortError();
			}
			throw error;
		}
	}

	async #open(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		const kind = resolveBrowserKind(params, this.session);
		details.browser = kind.kind;

		// Optional public-only navigation policy (browser.policy.restrictToPublic):
		// scheme + private-network checks plus a DNS re-check before navigating.
		let openUrl = params.url;
		if (openUrl && this.session.settings.get("browser.policy.restrictToPublic")) {
			openUrl = await assertSafeBrowserDestination(openUrl);
		}

		// If a tab with this name already exists on a different browser kind, fail fast — caller must close first.
		const existing = getTab(name);
		if (existing && !sameBrowserKind(existing.browser.kind, kind)) {
			throw new ToolError(
				`Tab ${JSON.stringify(name)} is bound to a different browser (${describeKind(existing.browser.kind)}). Close it first.`,
			);
		}

		// The requested timeout must cover the *entire* open — browser
		// acquisition (CDP discovery/connect), queued tab acquisition, worker
		// creation, and navigation — not only `acquireTab`. Compose one deadline
		// from the caller signal and `params.timeout` and thread it through both
		// stages so a stalled acquisition rejects at the requested boundary.
		const timeoutSignal = AbortSignal.timeout(timeoutMs);
		const openSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		try {
			const browser = await untilAborted(openSignal, () =>
				acquireBrowser(kind, {
					cwd: this.session.cwd,
					viewport: params.viewport
						? {
								width: params.viewport.width,
								height: params.viewport.height,
								deviceScaleFactor: params.viewport.scale,
							}
						: undefined,
					appArgs: params.app?.args,
					signal: openSignal,
				}),
			);

			// Hold one open-acquisition lease across the whole tab acquisition.
			// A freshly-created browser sits in the registry at refCount 0 until a
			// tab takes a hold; without this lease an abort/timeout mid-acquisition
			// (or a sibling open of a different tab name on the same browser that
			// fails) could dispose it out from under this operation. The lease is
			// released exactly once — the success and failure paths are mutually
			// exclusive — transferring ownership to the published tab on success or
			// rolling the fresh browser back on failure.
			holdBrowser(browser);
			let result: AcquireTabResult;
			try {
				result = await untilAborted(openSignal, () =>
					acquireTab(name, browser, {
						url: openUrl,
						waitUntil: params.wait_until,
						viewport: params.viewport
							? {
									width: params.viewport.width,
									height: params.viewport.height,
									deviceScaleFactor: params.viewport.scale,
								}
							: undefined,
						target: params.app?.target,
						timeoutMs,
						dialogs: params.dialogs,
						signal: openSignal,
						ownerSessionId: this.session.getSessionId?.() ?? undefined,
						...this.#agentIdentity(),
					}),
				);
			} catch (error) {
				await releaseBrowser(browser, { kill: false });
				throw error;
			}
			await releaseBrowser(browser, { kill: false });

			const tab = result.tab;
			const url = tab.info.url;
			const title = tab.info.title ?? "";
			details.url = url;
			details.viewport = tab.info.viewport;
			const verb = result.created ? "Opened" : "Reused";
			const lines = [
				`${verb} tab ${JSON.stringify(name)} on ${describeBrowser(browser)}`,
				`URL: ${url}`,
				title ? `Title: ${title}` : null,
			].filter((l): l is string => typeof l === "string");
			details.result = lines.join("\n");
			return toolResult(details).text(lines.join("\n")).done();
		} catch (error) {
			// Caller cancellation stays a ToolAbortError; the requested timeout
			// becomes a timeout ToolError; anything else passes through unchanged.
			if (signal?.aborted) throw error instanceof ToolAbortError ? error : new ToolAbortError();
			if (timeoutSignal.aborted) throw new ToolError(`Browser open timed out after ${timeoutMs}ms`);
			throw error;
		}
	}

	async #close(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		const kill = !!params.kill;
		if (params.all) {
			const count = await untilAborted(signal, () => releaseAllTabs({ kill, timeoutMs }));
			details.result = `Closed ${count} tab(s)`;
			return toolResult(details).text(details.result).done();
		}
		const closed = await untilAborted(signal, () => releaseTab(name, { kill, timeoutMs }));
		details.result = closed ? `Closed tab ${JSON.stringify(name)}` : `No tab named ${JSON.stringify(name)}`;
		return toolResult(details).text(details.result).done();
	}

	async #status(
		details: BrowserToolDetails,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		const managedUrl = managedBrowserEnabled(this.session.settings)
			? resolveManagedBrowserUrl(this.session)
			: undefined;
		const timeoutSignal = AbortSignal.timeout(timeoutMs);
		const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		const status = managedUrl
			? await readManagedBrowserStatus(managedUrl, requestSignal)
			: browserStatusFromTabs(listTabs());
		details.status = status;
		details.pendingDialogs = listTabs().flatMap(tab => (tab.pendingDialog ? [tab.pendingDialog] : []));
		details.browser = managedUrl ? "connected" : listTabs()[0]?.browser.kind.kind;
		details.url = status.url;
		details.result = JSON.stringify(status, null, 2);
		return toolResult(details).text(details.result).done();
	}

	async #read(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<BrowserToolDetails> | undefined,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		if (params.scope === "element") {
			if (!params.snapshotId) throw new ToolError("Element page text requires snapshotId");
			if (!params.ref) throw new ToolError("Element page text requires ref");
			const snapshot = readElementSnapshot(name, params.snapshotId);
			if (!snapshot.elements.some(element => `e${element.id}` === params.ref)) {
				throw new ToolError(`Element ref ${params.ref} is not present in snapshot ${params.snapshotId}`);
			}
		}
		const code = pageTextCode({
			scope: params.scope,
			maxChars: params.maxChars,
			cursor: params.cursor,
			snapshotId: params.snapshotId,
			ref: params.ref,
		});
		return await this.#run(name, { ...params, action: "run", code }, details, timeoutMs, signal, onUpdate, run => {
			if (typeof run.returnValue !== "object" || run.returnValue === null) {
				throw new ToolError("Browser read returned an invalid page-text result");
			}
			details.pageText = run.returnValue as PageTextSnapshot;
		});
	}

	async #navigation(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<BrowserToolDetails> | undefined,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		if (params.action === "stop") {
			const tab = getTab(name);
			if (!tab) throw new ToolError(`Tab ${JSON.stringify(name)} is not alive`);
			await stopTabLoading(name);
			details.navigation = { action: "stop", url: tab.info.url, title: tab.info.title ?? "" };
			details.result = JSON.stringify(details.navigation, null, 2);
			return toolResult(details).text(details.result).done();
		}
		if (params.action === "navigate" && params.url && this.session.settings.get("browser.policy.restrictToPublic")) {
			await assertSafeBrowserDestination(params.url);
		}
		const code = navigationActionCode(
			params as Parameters<typeof navigationActionCode>[0],
			this.session.settings.get("browser.searchEngine"),
		);
		return await this.#run(name, { ...params, action: "run", code }, details, timeoutMs, signal, onUpdate, run => {
			if (typeof run.returnValue !== "object" || run.returnValue === null) {
				throw new ToolError("Browser navigation returned an invalid result");
			}
			details.navigation = run.returnValue as BrowserNavigationResult;
		});
	}

	async #waitFor(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<BrowserToolDetails> | undefined,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		if (!params.condition) throw new ToolError("wait_for requires condition");
		const code = pageWaitCode(
			params.condition as Parameters<typeof pageWaitCode>[0],
			params.timeoutMs,
			params.stableForMs,
		);
		const result = await this.#run(
			name,
			{ ...params, action: "run", code },
			details,
			timeoutMs,
			signal,
			onUpdate,
			run => {
				if (typeof run.returnValue !== "object" || run.returnValue === null) {
					throw new ToolError("Browser wait returned an invalid result");
				}
				details.waitResult = run.returnValue as BrowserWaitResult;
			},
		);
		if (details.waitResult?.outcome === "timeout") result.isError = true;
		return result;
	}

	async #records(
		kind: "history" | "downloads",
		details: BrowserToolDetails,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		const managedUrl = managedBrowserEnabled(this.session.settings)
			? resolveManagedBrowserUrl(this.session)
			: undefined;
		if (!managedUrl) throw new ToolError(`Browser ${kind} requires the managed Electron browser profile`);
		const timeoutSignal = AbortSignal.timeout(timeoutMs);
		const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		const records = await readManagedBrowserRecords(managedUrl, kind, requestSignal);
		if (kind === "history") details.history = records as BrowserHistoryRecord[];
		else details.downloads = records as BrowserDownloadRecord[];
		details.browser = "connected";
		details.result = JSON.stringify(records, null, 2);
		return toolResult(details).text(details.result).done();
	}

	async #deviceProfiles(details: BrowserToolDetails): Promise<AgentToolResult<BrowserToolDetails>> {
		details.deviceProfiles = BROWSER_DEVICE_PROFILES;
		details.result = JSON.stringify(BROWSER_DEVICE_PROFILES, null, 2);
		return toolResult(details).text(details.result).done();
	}

	async #setDevice(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<BrowserToolDetails> | undefined,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		if (!params.device) throw new ToolError("set_device requires device");
		const code = deviceActionCode(params.device);
		return await this.#run(name, { ...params, action: "run", code }, details, timeoutMs, signal, onUpdate, run => {
			if (typeof run.returnValue !== "object" || run.returnValue === null) {
				throw new ToolError("Device configuration returned an invalid result");
			}
			details.deviceConfiguration = run.returnValue as BrowserDeviceConfiguration;
		});
	}

	async #dialog(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<BrowserToolDetails> | undefined,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		return await this.#run(
			name,
			{ ...params, action: "run", code: "return await tab.dialog();" },
			details,
			timeoutMs,
			signal,
			onUpdate,
			undefined,
			() => ({ pendingDialogs: details.pendingDialogs ?? [], handledDialogs: details.handledDialogs ?? [] }),
		);
	}

	async #dialogRespond(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<BrowserToolDetails> | undefined,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		if (typeof params.accept !== "boolean")
			throw new ToolError("dialog_respond requires accept:true or accept:false");
		const code = `return await tab.respondDialog(${params.accept}, ${JSON.stringify(params.text)});`;
		return await this.#run(
			name,
			{ ...params, action: "run", code },
			details,
			timeoutMs,
			signal,
			onUpdate,
			undefined,
			() => ({ pendingDialogs: details.pendingDialogs ?? [], handledDialogs: details.handledDialogs ?? [] }),
		);
	}

	async #activate(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		let tab = getTab(name);
		if (!tab && params.app?.target) {
			const opened = await this.#open(name, params, details, timeoutMs, signal);
			if (opened.isError) return opened;
			tab = getTab(name);
		}
		if (!tab) throw new ToolError(`Tab ${JSON.stringify(name)} is not alive. Open or adopt it first.`);
		details.control = { action: "activate", activeTabId: tab.targetId };
		details.url = tab.info.url;
		details.result = JSON.stringify(details.control, null, 2);
		return toolResult(details).text(details.result).done();
	}

	async #activatePanel(name: string, details: BrowserToolDetails): Promise<AgentToolResult<BrowserToolDetails>> {
		const tab = getTab(name);
		if (!tab) throw new ToolError(`Tab ${JSON.stringify(name)} is not alive. Open or adopt it first.`);
		await activateManagedPanel(tab);
		details.control = { action: "activate_panel", panelVisible: true };
		details.url = tab.info.url;
		details.result = JSON.stringify(details.control, null, 2);
		return toolResult(details).text(details.result).done();
	}

	async #switch(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		const activated = await this.#activate(name, params, details, timeoutMs, signal);
		if (activated.isError) return activated;
		const targetId = await activateTabTarget(name);
		details.control = { action: "switch", activeTabId: targetId, visibleTabId: targetId };
		details.result = JSON.stringify(details.control, null, 2);
		return toolResult(details).text(details.result).done();
	}

	async #release(name: string, details: BrowserToolDetails): Promise<AgentToolResult<BrowserToolDetails>> {
		const tab = getTab(name);
		if (!tab) throw new ToolError(`Tab ${JSON.stringify(name)} is not alive`);
		const targetId = tab.targetId;
		const released = await releaseManagedAgent(name);
		if (!released) throw new ToolError(`Tab ${JSON.stringify(name)} could not be released`);
		details.control = { action: "release", activeTabId: targetId, released: true };
		details.url = tab.info.url;
		details.result = JSON.stringify(details.control, null, 2);
		return toolResult(details).text(details.result).done();
	}

	async #screenshot(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<BrowserToolDetails> | undefined,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		const options = { selector: params.selector, fullPage: params.fullPage };
		const code = `return await tab.screenshot(${JSON.stringify(options)});`;
		return await this.#run(name, { ...params, action: "run", code }, details, timeoutMs, signal, onUpdate, run => {
			const screenshot = run.screenshots.at(-1);
			if (!screenshot) throw new ToolError("Browser screenshot returned no capture metadata");
			details.pageScreenshot = { ...screenshot, capturedAt: new Date().toISOString() };
		});
	}

	async #elements(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<BrowserToolDetails> | undefined,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		const scope = params.scope;
		if (scope === "element") throw new ToolError('scope:"element" is only valid for read');
		if (params.cursor !== undefined) {
			if (!params.snapshotId) throw new ToolError("Element continuation requires snapshotId");
			const page = paginateElementSnapshot(readElementSnapshot(name, params.snapshotId), {
				scope,
				limit: params.limit,
				maxChars: params.maxChars,
				cursor: params.cursor,
				role: params.role,
				text: params.filterText,
			});
			details.elementsSnapshot = page;
			details.url = page.url;
			details.result = JSON.stringify(page, null, 2);
			return toolResult(details).text(details.result).done();
		}
		const options = { viewportOnly: (scope ?? "viewport") === "viewport" };
		const code = `return await tab.observe(${JSON.stringify(options)});`;
		return await this.#run(
			name,
			{ ...params, action: "run", code },
			details,
			timeoutMs,
			signal,
			onUpdate,
			run => {
				if (typeof run.returnValue !== "object" || run.returnValue === null) {
					throw new ToolError("Browser elements returned an invalid observation");
				}
				const snapshot = createElementSnapshot(name, run.returnValue as Observation);
				details.observation = snapshot;
				details.elementsSnapshot = paginateElementSnapshot(snapshot, {
					scope,
					limit: params.limit,
					maxChars: params.maxChars,
					role: params.role,
					text: params.filterText,
				});
				details.url = snapshot.url;
			},
			() => details.elementsSnapshot,
		);
	}

	async #visual(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<BrowserToolDetails> | undefined,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		const result = await this.#screenshot(name, params, details, timeoutMs, signal, onUpdate);
		const image = details.pageScreenshot;
		const tab = getTab(name);
		if (image && tab) {
			const snapshot = createVisualSnapshot(name, {
				url: details.url ?? tab.info.url,
				title: tab.info.title ?? "",
				viewport: tab.info.viewport,
				image,
				capturedAt: image.capturedAt,
			});
			details.visualSnapshot = snapshot;
			result.content.push({ type: "text", text: JSON.stringify(snapshot, null, 2) });
		}
		return result;
	}

	async #visualCrop(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<BrowserToolDetails> | undefined,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		const snapshot = readVisualSnapshot(name, params.snapshotId ?? "");
		const region = params.region;
		if (!region) throw new ToolError("Visual crop requires region");
		const buffer = await fs.readFile(snapshot.image.dest);
		const metadata = await new Bun.Image(buffer).metadata();
		const source = resolveVisualCrop(snapshot, region, metadata.width, metadata.height);
		const dest = path.join(path.dirname(snapshot.image.dest), `crop-${Snowflake.next()}.png`);
		const input = { data: buffer.toBase64(), mimeType: snapshot.image.mimeType, ...source };
		const code = `return await tab.evaluate(async ({ data, mimeType, left, top, width, height }) => {
			const image = new Image();
			image.src = "data:" + mimeType + ";base64," + data;
			await image.decode();
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const context = canvas.getContext("2d");
			if (!context) throw new Error("Canvas 2D is unavailable");
			context.drawImage(image, left, top, width, height, 0, 0, width, height);
			return { data: canvas.toDataURL("image/png").split(",")[1] };
		}, ${JSON.stringify(input)});`;
		let data: string | undefined;
		const result = await this.#run(
			name,
			{ ...params, action: "run", code },
			details,
			timeoutMs,
			signal,
			onUpdate,
			run => {
				const value = run.returnValue;
				if (typeof value !== "object" || value === null || !("data" in value) || typeof value.data !== "string") {
					throw new ToolError("Visual crop returned no image data");
				}
				data = value.data;
				details.visualCrop = {
					sourceSnapshotId: snapshot.snapshotId,
					region: { ...region },
					image: {
						dest,
						mimeType: "image/png",
						bytes: Buffer.from(data, "base64").length,
						width: source.width,
						height: source.height,
					},
					capturedAt: snapshot.capturedAt,
				};
			},
			() => details.visualCrop,
		);
		if (details.visualCrop && data) {
			await Bun.write(dest, Buffer.from(data, "base64"));
			result.content.push({ type: "image", data, mimeType: "image/png" });
		}
		return result;
	}

	async #snapshotAction(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<BrowserToolDetails> | undefined,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		const action = params.action as SnapshotAction;
		const target =
			params.ref ?? (params.x !== undefined && params.y !== undefined ? `${params.x},${params.y}` : undefined);
		try {
			const elements = params.ref ? readElementSnapshot(name, params.snapshotId ?? "") : undefined;
			const needsVisual =
				!params.ref &&
				(action === "scroll" ||
					action === "drag" ||
					action === "drag_path" ||
					action === "click" ||
					action === "double_click" ||
					action === "right_click" ||
					action === "click_if_interactive" ||
					action === "visual_type" ||
					action === "hover" ||
					(action === "press" && params.x !== undefined));
			const visual = needsVisual ? readVisualSnapshot(name, params.snapshotId ?? "") : undefined;
			const code = snapshotActionCode({ ...params, action }, elements, visual);
			const result = await this.#run(
				name,
				{ ...params, action: "run", code },
				details,
				timeoutMs,
				signal,
				onUpdate,
				run => {
					if (action === "click_if_interactive")
						details.visualInteraction = run.returnValue as BrowserVisualInteraction;
				},
			);
			details.actionReceipt = {
				action,
				status: result.isError === true ? "failed" : "completed",
				...(target ? { target } : {}),
				...(details.url ? { url: details.url } : {}),
				...(result.isError === true ? { error: details.result ?? "Browser action failed" } : {}),
			};
			return result;
		} catch (error) {
			if (error instanceof ToolAbortError || (error instanceof Error && error.name === "AbortError")) throw error;
			const message = error instanceof Error ? error.message : String(error);
			details.actionReceipt = { action, status: "failed", ...(target ? { target } : {}), error: message };
			details.result = message;
			return toolResult(details).text(message).error().done();
		}
	}

	async #run(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<BrowserToolDetails>,
		onResult?: (run: RunResultOk) => void,
		transformReturn?: (value: unknown) => unknown,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		if (!params.code?.trim()) {
			throw new ToolError("Missing required parameter 'code' for action 'run'.");
		}
		const tab = getTab(name);
		if (tab) {
			details.browser = tab.browser.kind.kind;
			details.url = tab.info.url;
		}

		const identity = this.#agentIdentity();
		const run = await runInTab(name, {
			code: params.code,
			timeoutMs,
			signal,
			session: this.session,
			agentId: identity.agentId,
			agentName: identity.agentName,
			onOperations: current => {
				details.operations = current;
				onUpdate?.({ content: [], details: { ...details } });
			},
		}).catch(error => {
			if (signal?.aborted || error instanceof ToolAbortError) throw error;
			details.result = error instanceof Error ? error.message : String(error);
			return null;
		});
		if (!run)
			return toolResult(details)
				.text(details.result ?? "Browser run failed")
				.error()
				.done();
		const { displays, returnValue, screenshots, operations = [] } = run;

		details.url = getTab(name)?.info.url ?? details.url;
		details.operations = operations;
		if (screenshots.length) details.screenshots = screenshots;
		if (run.pendingDialogs) details.pendingDialogs = run.pendingDialogs;
		if (run.handledDialogs) details.handledDialogs = run.handledDialogs;
		onResult?.(run);

		const content = [...displays];
		const outputValue = transformReturn ? transformReturn(returnValue) : returnValue;
		if (outputValue !== undefined) {
			content.push({ type: "text", text: stringifyReturnValue(outputValue) });
		}
		if (!content.length) {
			content.push({ type: "text", text: `Ran code on tab ${JSON.stringify(name)}` });
		}
		const textOnly = content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map(c => c.text)
			.join("\n");
		// Final defense at the tool-result boundary: a single run can display
		// tens of KB (large JSON returns, dumped observations). Cap the combined
		// text inline; the full text stays recoverable via the artifact footer
		// when allocation succeeds.
		const cappedText = await enforceInlineByteCap(textOnly, {
			saveArtifact: full => saveBrowserOutputArtifact(this.session, full),
		});
		details.result = cappedText;
		if (cappedText !== textOnly) {
			const nonText = content.filter(c => c.type !== "text");
			return toolResult(details)
				.content([...nonText, { type: "text", text: cappedText }])
				.done();
		}
		return toolResult(details).content(content).done();
	}
}

/** Persist over-cap browser run output as a session artifact; mirrors the bash minimizer's save path. */
async function saveBrowserOutputArtifact(session: ToolSession, fullText: string): Promise<string | undefined> {
	try {
		const alloc = await session.allocateOutputArtifact?.("browser-original");
		if (!alloc?.path || !alloc.id) return undefined;
		await Bun.write(alloc.path, fullText);
		return alloc.id;
	} catch {
		return undefined;
	}
}

function describeBrowser(handle: BrowserHandle): string {
	if (!("browser" in handle)) {
		return `cmux browser (${handle.kind.surface ?? "split"})`;
	}
	switch (handle.kind.kind) {
		case "headless":
			return `headless browser (${handle.kind.headless ? "hidden" : "visible"}${handle.sharedDaemon ? ", shared" : ""})`;
		case "spawned":
			return `spawned ${handle.kind.path} (pid ${handle.pid ?? "?"})`;
		case "connected":
			return `connected ${handle.cdpUrl ?? handle.kind.cdpUrl}`;
		case "relay":
			return `relay ${handle.cdpUrl ?? handle.kind.cdpUrl}`;
	}
}

function describeKind(kind: BrowserKind): string {
	switch (kind.kind) {
		case "headless":
			return `headless ${kind.headless ? "hidden" : "visible"}`;
		case "spawned":
			return `spawned:${kind.path}`;
		case "connected":
			return `connected:${kind.cdpUrl}`;
		case "relay":
			return `relay:${kind.cdpUrl}`;
		case "cmux":
			return `cmux:${kind.surface ?? "split"}`;
	}
}

function sameBrowserKind(a: BrowserKind, b: BrowserKind): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "headless" && b.kind === "headless") return a.headless === b.headless;
	if (a.kind === "spawned" && b.kind === "spawned") return a.path === b.path;
	if (a.kind === "connected" && b.kind === "connected") return a.cdpUrl === b.cdpUrl;
	if (a.kind === "relay" && b.kind === "relay") return a.cdpUrl === b.cdpUrl;
	if (a.kind === "cmux" && b.kind === "cmux") return a.socketPath === b.socketPath;
	return false;
}

function stringifyReturnValue(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}
