import type { Settings } from "../../config/settings";
import type { BrowserExtensionInfo, BrowserTabInfo } from "../browser-rpc";
import type { DaemonService } from "./types";

/**
 * BrowserService — 共享自动化 Chromium 的 GUI 面板 RPC 面（L2 宿主服务，
 * P1 第八刀抽取）。
 *
 * 能力缝声明（M2-2.4）：
 * - 输入：RPC `browser.endpoint` / `browser.tabs` / `browser.screenshot` /
 *   `browser.extensions` / `browser.importChrome` / `browser.clearCache` /
 *   `browser.clearAll`（均按宿主 cwd 定位共享浏览器）、
 *   `browser.relayInstall` / `browser.relayStatus` / `browser.relayUninstall`
 *   （MusePi Browser Relay 扩展安装面，与项目目录无关）。
 * - 输出：各 RPC 返回值原样（endpoint/tabs/截图 base64/扩展清单/清理 ok）；
 *   本服务不广播任何事件。CDP 客户端在 browser-rpc.ts 内（一次连接一请求，
 *   低频 GUI 动作，非热工具路径）。
 * - 生命周期：无自有状态——共享 Chromium 由 per-project broker 监管
 *   （ensureSharedBrowser），relay 扩展文件落 `getBrowserRelayDir()`；
 *   本服务只做无状态寻址与转发。
 *
 * 实现模块（browser-rpc.ts）与启动图保持原样：方法内动态 import，
 * 不把重浏览器机制拉进服务加载路径（原 case 内 `await import` 语义不变）。
 *
 * 从 server.ts 巨型 switch 的十个 case 原样搬移（P1 纪律：纯搬移不改
 * 行为，docs/review/0.5.0-m2-daemon-host-layering.md §5）。设置解析与
 * 项目 cwd 以结构接口注入（host access），保持服务对 DaemonServer 无
 * 传递依赖、可单测。
 */
export interface BrowserServiceDeps {
	/** 解析设置（宿主 #settingsForRpc：先取会话宿主 settings，缺失时
	 *  ensureRegistry 后重取，仍缺失抛 "settings unavailable"）。 */
	settings(): Promise<Settings>;
	/** 宿主项目 cwd（共享浏览器按项目定位 profile/broker）。 */
	cwd(): string;
}

export class BrowserService implements DaemonService {
	readonly key = "browser";
	readonly routes = {
		"browser.clearAll": "clearAll",
		"browser.clearCache": "clearCache",
		"browser.endpoint": "endpoint",
		"browser.extensions": "extensions",
		"browser.importChrome": "importChrome",
		"browser.relayInstall": "relayInstall",
		"browser.relayStatus": "relayStatus",
		"browser.relayUninstall": "relayUninstall",
		"browser.screenshot": "screenshot",
		"browser.tabs": "tabs",
	} as const;

	readonly #deps: BrowserServiceDeps;

	constructor(deps: BrowserServiceDeps) {
		this.#deps = deps;
	}

	/** RPC browser.endpoint：共享自动化 Chromium（agent 驱动的同一实例）
	 *  — 返回 CDP ws endpoint + 稳定 profile 目录（设置面板用）。 */
	async endpoint(): Promise<{ wsEndpoint: string; profileDir: string; headless: boolean } | null> {
		const { browserEndpoint } = await import("../browser-rpc");
		return browserEndpoint(await this.#deps.settings(), this.#deps.cwd());
	}

	/** RPC browser.tabs：列出存活 page targets（title/url）。 */
	async tabs(): Promise<{ tabs: BrowserTabInfo[]; wsEndpoint: string | null }> {
		const { browserTabs } = await import("../browser-rpc");
		return browserTabs(await this.#deps.settings(), this.#deps.cwd());
	}

	/** RPC browser.screenshot：单 tab JPEG 截图（attach → capture → detach）。 */
	async screenshot(params: { targetId: string }): Promise<{ base64?: string; error?: string }> {
		const p = (params ?? {}) as { targetId: string };
		if (!p.targetId) throw new Error("browser.screenshot requires targetId");
		const { browserScreenshot } = await import("../browser-rpc");
		return browserScreenshot(await this.#deps.settings(), this.#deps.cwd(), p.targetId);
	}

	/** RPC browser.extensions：列出共享 profile 内已装扩展。 */
	async extensions(): Promise<{ extensions: BrowserExtensionInfo[]; profileDir: string | null }> {
		const { browserExtensions } = await import("../browser-rpc");
		return browserExtensions(await this.#deps.settings(), this.#deps.cwd());
	}

	/** RPC browser.relayInstall：写出 MusePi Browser Relay 扩展文件
	 *  （chrome.debugger 桥接用户自己的 Chrome）。 */
	async relayInstall(): Promise<{ dir: string; ok: boolean }> {
		const { browserRelayInstall } = await import("../browser-rpc");
		return browserRelayInstall();
	}

	/** RPC browser.relayStatus：relay 扩展三层状态（未安装/已装未加载/已连接）。 */
	async relayStatus(): Promise<{
		extensionDir: string;
		installed: boolean;
		serving: boolean;
		connected: boolean;
	}> {
		const { browserRelayStatus } = await import("../browser-rpc");
		return browserRelayStatus();
	}

	/** RPC browser.relayUninstall：删除写出的 relay 扩展目录。 */
	async relayUninstall(): Promise<{ ok: boolean; dir: string }> {
		const { browserRelayUninstall } = await import("../browser-rpc");
		return browserRelayUninstall();
	}

	/** RPC browser.importChrome：从最近使用的 Chrome profile 一次性导入
	 *  Cookies + LocalStorage（zcode 浏览器数据 parity）。 */
	async importChrome(): Promise<{ ok: boolean; importedFrom?: string; error?: string }> {
		const { browserImportChrome } = await import("../browser-rpc");
		return browserImportChrome(await this.#deps.settings(), this.#deps.cwd());
	}

	/** RPC browser.clearCache：清 HTTP 缓存 / CacheStorage / Service Worker
	 *  （保留 cookies）。 */
	async clearCache(): Promise<{ ok: boolean; error?: string }> {
		const { browserClearCache } = await import("../browser-rpc");
		return browserClearCache(await this.#deps.settings(), this.#deps.cwd());
	}

	/** RPC browser.clearAll：清 cookies + 站点数据 + 缓存（不可逆）。 */
	async clearAll(): Promise<{ ok: boolean; error?: string }> {
		const { browserClearAll } = await import("../browser-rpc");
		return browserClearAll(await this.#deps.settings(), this.#deps.cwd());
	}
}
