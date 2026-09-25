import { addRemoteHost, browseRemoteDir, connectRemoteHost, disconnectRemoteHost, listRemoteHosts } from "../remote";
import type { DaemonService } from "./types";

/**
 * RemoteService — SSH 远程主机管理面（L2 宿主服务，P1 第九刀抽取）。
 *
 * 能力缝声明（M2-2.4）：
 * - 输入：RPC `remote.hosts` / `remote.hostAdd` / `remote.connect` /
 *   `remote.browse` / `remote.disconnect`（全部无会话状态，按 ~/.ssh/config
 *   与 MusePi 远程主机目录寻址）。
 * - 输出：各 RPC 返回值原样（主机清单/连接结果/目录浏览/卸载结果）；
 *   本服务不广播任何事件。领域逻辑全部在 remote.ts 内（SSH 连接、
 *   目录浏览、挂载生命周期）。
 * - 生命周期：无自有状态——连接态由 remote.ts 模块级注册表监管；
 *   本服务只做无状态转发。
 *
 * 从 server.ts 巨型 switch 的五个 case 原样搬移（P1 纪律：纯搬移不改
 * 行为，docs/review/0.5.0-m2-daemon-host-layering.md §5）。无宿主依赖，
 * 不需要 deps 注入接口。
 */
export class RemoteService implements DaemonService {
	readonly key = "remote";
	readonly routes = {
		"remote.browse": "browse",
		"remote.connect": "connect",
		"remote.disconnect": "disconnect",
		"remote.hostAdd": "hostAdd",
		"remote.hosts": "hosts",
	} as const;

	/** RPC remote.hosts：列出已配置的 SSH 远程主机。 */
	hosts() {
		return listRemoteHosts();
	}

	/** RPC remote.hostAdd：写入 ~/.ssh/config 新增主机条目。 */
	hostAdd(params: Parameters<typeof addRemoteHost>[0]) {
		return addRemoteHost((params ?? {}) as Parameters<typeof addRemoteHost>[0]);
	}

	/** RPC remote.connect：建立 SSH 连接并挂载远程目录。 */
	connect(params: { name?: unknown }) {
		return connectRemoteHost((params ?? {}) as { name?: unknown });
	}

	/** RPC remote.browse：浏览远程主机目录树。 */
	browse(params: { name?: unknown; path?: unknown }) {
		return browseRemoteDir((params ?? {}) as { name?: unknown; path?: unknown });
	}

	/** RPC remote.disconnect：断开连接并卸载远程目录。 */
	disconnect(params: { name?: unknown }) {
		return disconnectRemoteHost((params ?? {}) as { name?: unknown });
	}
}
