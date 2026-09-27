/**
 * 把托管浏览器桥的**实际**绑定端口推给 daemon（`browser.managedBridge`）。
 *
 * 桥在 9230-9239 里重试绑定，所以设置里的默认 9230 可能不是真实端口；只有
 * 渲染端从主进程的状态推送里拿到的 `port` 才是。推给 daemon 后，agent 的
 * browser 工具在用户没显式配置 `browser.gui` 时就会接管右栏内置浏览器
 * （而不是起一个看不见的无头 Chromium）。
 *
 * 这是**连接级运行时事实**，不是设置：GUI 一走 daemon 就该忘掉它（daemon
 * 在连接关闭时撤销登记），所以这里也从不写 settings。
 */
import { getHostState, subscribeHost } from "./managed-browser-host";
import type { RpcClient } from "./rpc";

interface PushedBridge {
	rpc: RpcClient;
	port: number | null;
}

let pushed: PushedBridge | null = null;

/** 推送一次；端口未变且还是同一个 RPC 连接时不重复推。 */
export function pushManagedBrowserBridge(rpc: RpcClient, port: number | null): void {
	if (pushed && pushed.rpc === rpc && pushed.port === port) return;
	pushed = { rpc, port };
	const url = port === null ? null : `http://127.0.0.1:${port}`;
	void rpc.request("browser.managedBridge", { url }).catch(() => {
		// 推送失败（旧 daemon 没这个 RPC / 连接断了）：清掉去重记录，
		// 下一次宿主状态变化或重连会重试。
		if (pushed && pushed.rpc === rpc && pushed.port === port) pushed = null;
	});
}

/**
 * 订阅宿主状态并推送桥端口；返回取消订阅函数。
 * 宿主状态变化很频繁（标签、活动、rect），推送侧按端口去重。
 */
export function watchManagedBrowserBridge(rpc: RpcClient): () => void {
	const push = (): void => pushManagedBrowserBridge(rpc, getHostState().port);
	push();
	return subscribeHost(push);
}
