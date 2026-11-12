import type { DaemonService } from "./types";

/**
 * LivenessService — 传输无关的存活探测面（L2 宿主服务）。
 *
 * 能力缝声明：
 * - 名称/命名空间：`liveness`；RPC `ping` 与 `system.ping` ——同一语义的两个
 *   名字，不分传输、不分客户端。
 * - 输入：无参数。
 * - 输出：`{ pong: Date.now() }`（服务端时钟毫秒）。
 * - 生命周期：无自有状态、无定时器；每次调用取当前时间。
 * - 启停：常驻，无启停副作用。
 * - 冲突：只回答存活问题，不触碰会话、事件或设置面。`ping` 是跨传输别名
 *   （guest 客户端在所有传输上只用一个方法名，collab host 同样应答
 *   `ping`）；`system.ping` 是 GUI 的应用层 keepalive（浏览器不能发 WS
 *   ping 帧，渲染进程用它发现 Electron 休眠后静默断开的 socket）。
 */
export class LivenessService implements DaemonService {
	readonly key = "liveness";
	readonly routes = {
		ping: "ping",
		"system.ping": "ping",
	} as const;

	/** RPC `ping` / `system.ping`：两个路由共享同一个应答形状。 */
	ping(): { pong: number } {
		return { pong: Date.now() };
	}
}
