import type { ConnectorServerInfo } from "../session-host";
import type { DaemonService } from "./types";

/**
 * ConnectorService — M4 P1 连接器面（L2 宿主服务）。
 *
 * 能力缝声明（M2-2.4）：
 * - 输入：RPC `connectors.list`（某 live 会话的 MCP 服务器清单 + 健康态 +
 *   该会话的选择态）、`connectors.setSelected`（写会话级白名单）。
 * - 输出：服务器清单（name/transport/status，status 取 manager 权威连接态）；
 *   选择态（null = 未配置存量全量语义，数组可空 = 已配置）。写通道返回
 *   `{ ok, appliedToLive }`。
 * - 生命周期：无自有状态——选择态持久化在 view-store 快照头
 *  （session-host.persistHeaderPatch），激活集过滤在 SessionTools；
 *   本服务只做参数校验 + 宿主委托。
 * - 启停：随 daemon 宿主注册/消亡。冲突：路由唯一归属由 HostServices
 *   routeTable 强制。
 *
 * 安全契约（M4 §4.2）：白名单过滤在 daemon 侧 SessionTools 生效，本服务
 * 与客户端都不承担安全边界；密钥类能力（CredentialService）不在本服务。
 */
export interface ConnectorServiceDeps {
	/** 服务器清单 + 健康态（宿主 session-host.connectorsSnapshot）。 */
	connectorsSnapshot(sessionId: string): { servers: ConnectorServerInfo[] } | null;
	/** 空态半：某 cwd 的清单 + 健康态，无需 live 会话（宿主 session-host.connectorsSnapshotForCwd）。 */
	connectorsSnapshotForCwd(cwd: string): Promise<{ servers: ConnectorServerInfo[] }>;
	/** 选择态读半（宿主 session-host.readSessionConnectors）。 */
	readSelection(sessionId: string): string[] | null;
	/** 写半：应用 + 持久化（宿主 session-host.setSessionConnectors）。 */
	setSelection(sessionId: string, servers: string[] | null): Promise<{ ok: true; appliedToLive: boolean }>;
}

export class ConnectorService implements DaemonService {
	readonly key = "connectors";
	readonly routes = {
		"connectors.list": "list",
		"connectors.setSelected": "setSelected",
	} as const;

	readonly #deps: ConnectorServiceDeps;

	constructor(deps: ConnectorServiceDeps) {
		this.#deps = deps;
	}

	/**
	 * RPC connectors.list：composer 连接器选择浮层的数据面。返回该会话
	 * cwd 的 MCP 服务器（真实健康态）+ 该会话当前选择态。
	 *
	 * 两种问法：live 会话按 sessionId（composer chip 的原生场景）；空态
	 * 输入框/欢迎页没有 live 会话，按 cwd 回退——服务器清单照常返回，
	 * 选择态为 null（客户端把空态选择暂存为 pending，会话创建后写回）。
	 * 两者都给不到时抛错。
	 */
	async list(params: { sessionId?: unknown; cwd?: unknown }): Promise<{
		servers: ConnectorServerInfo[];
		/** null = 未配置（存量全量语义）；数组（可空）= 已配置。 */
		selected: string[] | null;
	}> {
		const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "";
		const cwd = typeof params?.cwd === "string" ? params.cwd : "";
		if (!sessionId && !cwd) throw new Error("sessionId or cwd required");
		let snapshot = sessionId ? this.#deps.connectorsSnapshot(sessionId) : null;
		// 会话尚未 live（创建中的过渡帧）也能按 cwd 给出清单，客户端不用闪空。
		if (!snapshot && cwd) snapshot = await this.#deps.connectorsSnapshotForCwd(cwd);
		if (!snapshot) throw new Error(`Session not live: ${sessionId}`);
		return { servers: snapshot.servers, selected: sessionId ? this.#deps.readSelection(sessionId) : null };
	}

	/**
	 * RPC connectors.setSelected：写会话级连接器白名单并即时生效。
	 * servers = null 清除（回存量全量语义）；数组（可空 = 会话内零 MCP
	 * 工具）立即过滤。宿主侧持久化失败（未知会话）抛错。
	 */
	async setSelected(params: { sessionId?: unknown; servers?: unknown }): Promise<{
		ok: true;
		appliedToLive: boolean;
	}> {
		const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "";
		if (!sessionId) throw new Error("sessionId required");
		const raw = params?.servers;
		if (raw !== null && raw !== undefined && !Array.isArray(raw)) {
			throw new Error("servers must be an array of server names or null");
		}
		const servers = raw == null ? null : raw.filter((s): s is string => typeof s === "string" && s.length > 0);
		return this.#deps.setSelection(sessionId, servers);
	}
}
