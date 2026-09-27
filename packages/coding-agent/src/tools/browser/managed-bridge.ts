/**
 * 桌面 GUI 托管浏览器 CDP 桥的进程内登记处（`browser.gui` 通道）。
 *
 * 桌面应用启动后把桥的**实际**地址（9230-9239 里真正绑定的那个端口）用
 * `browser.managedBridge` RPC 推给 daemon；本模块只保存这一条活跃登记，
 * `resolveBrowserKind` 据此在用户没显式配置 `browser.gui` 时把 agent 的
 * browser 工具接到右栏内置浏览器上，而不是起一个谁也看不见的无头 Chromium。
 *
 * 为什么桥地址不写进 settings：
 * - 持久化会把「桌面应用此刻开着」这个瞬时事实固化下来：GUI 退出后 agent
 *   仍去连一个已经不存在的端口；
 * - 写设置无法区分「用户显式关过」和「从未配置」，每次启动覆盖会吃掉用户的
 *   显式 false。判据因此拆成两半——桥是否活着（本模块，进程内、随连接撤销）
 *   + 用户是否显式配置过（`Settings.isConfigured`，落盘）。
 *
 * 登记按 RPC 连接记名：连接断开（GUI 退出 / WS 关闭）时由 daemon 显式清除，
 * 免得一条陈旧登记把后来的会话指向死端口。
 */

import type { Settings } from "../../config/settings";

export interface ManagedBrowserBridge {
	/** 登记这条桥的 RPC 连接（连接断开时按它撤销）。 */
	connectionId: string;
	/** 回环 CDP discovery 地址，如 `http://127.0.0.1:9235`。 */
	url: string;
}

/**
 * 桌面宿主默认接管判据：用户显式配置过 `browser.gui` 就以配置为准（显式
 * false 因此永远生效），只有**没配置过**时才由「本进程里有没有活着的桥」
 * 决定——也就是这个 daemon 是不是正被桌面应用驱动着。
 */
export function managedBrowserEnabled(settings: Settings): boolean {
	if (settings.isConfigured("browser.gui")) return settings.get("browser.gui") === true;
	return managedBrowserBridgeUrl() !== null;
}

let bridge: ManagedBrowserBridge | null = null;

/**
 * 登记或撤销桌面 GUI 的托管浏览器桥。`url` 为 null 表示桥已停止（GUI 侧
 * 端口释放）。返回撤销后的当前登记。
 */
export function setManagedBrowserBridge(connectionId: string, url: string | null): ManagedBrowserBridge | null {
	if (url === null) {
		dropManagedBrowserBridge(connectionId);
		return bridge;
	}
	bridge = { connectionId, url };
	return bridge;
}

/** 连接断开时只撤销它自己的登记（后来的 GUI 重连登记的不动）。 */
export function dropManagedBrowserBridge(connectionId: string): ManagedBrowserBridge | null {
	if (bridge?.connectionId !== connectionId) return bridge;
	bridge = null;
	return null;
}

/** 当前活跃的桥地址；没有 GUI 桥时为 null。 */
export function managedBrowserBridgeUrl(): string | null {
	return bridge?.url ?? null;
}

/** 当前登记（设置面板/诊断用；无登记为 null）。 */
export function managedBrowserBridge(): ManagedBrowserBridge | null {
	return bridge;
}

/**
 * 校验并归一化桥地址：只接受回环 http(s) 端点，取 `origin`（去掉路径与
 * 结尾斜杠）。非法地址抛错——这是 RPC 边界，agent 的浏览器会被指向这里。
 */
export function normalizeManagedBrowserUrl(raw: string): string {
	const trimmed = raw.trim();
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error(`browser.managedBridge requires an absolute http(s) url, got ${JSON.stringify(raw)}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`browser.managedBridge requires an http(s) url, got ${trimmed}`);
	}
	const host = parsed.hostname.toLowerCase();
	const loopback = host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
	if (!loopback) {
		throw new Error(`browser.managedBridge requires a loopback address, got ${trimmed}`);
	}
	return parsed.origin;
}
