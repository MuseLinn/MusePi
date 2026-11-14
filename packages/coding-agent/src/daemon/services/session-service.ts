import type { DaemonService } from "./types";
import { type DeletedWorkspaces, sessionHiddenByWorkspace } from "./workspace-registry";

/**
 * SessionService — 会话树契约面（P2 首个 cordis 化 L2 服务，ADR 0001）。
 *
 * 能力缝声明（M2.4）：
 * - 名称+ns：session-tree（RPC 路由 `session.tree` / `session.resume` /
 *   `session.toolGates`——客户端 tree 接口契约的归属，route-coverage 测试
 *   钉桩）。session.catchup 仍归 EventService（journal 序语义载体，重复认领
 *   会被 routeTable 拒）。
 * - 输入：session.tree（跨会话树， OMP /tree  parity）、session.resume
 *  （快照 + 订阅附着前的 resumeLive 登记）、session.toolGates（live 会话的
 *  工具开关重算）。
 * - 输出：树节点（entry + children）；resume 返回 `{ stream, snapshot,
 *   compactedThrough }`；toolGates 返回 `{ removed, active }`；catchup
 *  透传 EventService。
 * - 生命周期：无进程内状态——全部委托宿主（knownSessions/snapshot/
 *  checkpointSeq）与既有 L2 服务（schedule/views/events）；start/stop 无
 *  副作用。
 * - 启停：always-on——会话树是 GUI 侧栏的常驻数据面，无独立启停语义
 *  （声明理由：服务本体无状态可卸载）。
 * - 冲突：`#resumeLiveByConn` 登记是 server 的订阅附着前置状态（session.resume
 *  与 catchupIfNeeded 的跨 RPC 约定），按连接归属（P0-7：旧单字段让并发 resume
 *  跨连接串线）；本服务只写不读，读取侧仍在 server.ts——v2 收编
 *  session.subscribe 时必须一并迁移该状态。分支族
 *  （branchAt/btwBranch/forkAt——复活/事件序纠缠区）按分层文档纪律留
 *  v2 独立刀。检视入口：本文件。
 */

/** 树行（host.knownSessions 返回行的结构子集，避免服务对宿主的传递依赖）。 */
export interface SessionTreeRow {
	sessionId: string;
	parentId: string | null;
	createdAt: number | string;
	updatedAt: number | string;
	/** 会话工作目录（已删工作区的列表过滤口径，与 session.list 一致）。 */
	cwd?: string;
	title?: string;
	/** 子代理 transcript 行（task/vibe 子会话）——GUI 渲染为父行下的层级子行。 */
	subagent?: boolean;
	/** 顾问 transcript 行（`__advisor[.<slug>].jsonl`）——GUI 渲染顾问标记且只读。 */
	advisor?: boolean;
	/** 子代理定义名（`session_init.agent`）——树行标注“是哪个子代理”。 */
	agentName?: string;
}

/** live 会话最小结构面（tree 的 autoTitle 判定 + resumeLive 登记引用 +
 *  resume 响应的流式视觉水合——server 的 resolveLive 实参是全量 LiveSession，
 *  此处只声明用到的结构子集）。 */
export interface ResumeLiveHandle {
	autoTitle?: boolean;
	/** Running tool calls（subscribe-time 水合同源；GUI 打开 live 会话时的
	 *  composer dock 首帧）。 */
	activeToolCalls?: Map<string, unknown>;
	/** Owned subagent progress（同上，swarm 卡首帧）。 */
	subagentProgress?: Map<string, unknown>;
}

/** live 会话的工具开关面（session.toolGates 的结构子集）。 */
export interface ToolGateSession {
	readonly agentSession: {
		syncRegisteredToolGates(): Promise<string[]>;
		getEnabledToolNames(): string[];
	};
}

export interface SessionServiceDeps {
	/** 跨会话行（宿主 DaemonSessionHost.knownSessions）。 */
	knownSessions(): Promise<readonly SessionTreeRow[]>;
	/** live 会话本体（宿主 session-host.get；undefined = 会话不存在）。 */
	getSession(sessionId: string): ToolGateSession | undefined;
	/** resume 的快照（宿主 session-host.snapshot，调用方 tailSnapshot；
	 *  结构面只要求 entries——tailSnapshot 的泛型约束）。 */
	snapshot(sessionId: string): Promise<{ entries?: readonly unknown[] }>;
	/** 压缩检查点序号（宿主 session-host.checkpointSeq）。 */
	checkpointSeq(sessionId: string): Promise<number>;
	/** 写 resumeLive 登记（server `#resumeLiveByConn` 的写半；按连接归属——
	 *  P0-7：单字段被并发 resume 跨连接串线）。 */
	setResumeLive(conn: object, live: ResumeLiveHandle | null): void;
	/** 会话 id 的 live 引用（宿主 session-host.get；resume 的 stream 判定）。 */
	resolveLive?(sessionId: string): ResumeLiveHandle | undefined;
	/** 打开历史会话时按需激活（宿主 session-host.activate）。resume 是客户端
	 *  打开会话的唯一入口，随后的 live 状态 RPC（thinkingInfo/contextUsage/
	 *  pauseStatus）都以激活为前提；不激活则打开即有快照、无 live，聊天面
	 *  只能显示空壳。失败（转录缺失的孤儿行）保持快照可用，live 为 null。 */
	activateLive?(sessionId: string): Promise<ResumeLiveHandle>;
	/** cron 会话 id 集合（ScheduleService.sessionIds——树节点 source 标注）。 */
	cronSessionIds(): Set<string>;
	/** 标题兜底（ViewStoreService.firstUserMessage——autoTitle 会话）。 */
	firstUserMessage(sessionId: string): string;
	/** 已删工作区证据：树的列表投影与 session.list 同一口径（已删工作区的
	 *  会话不出现在任何列表）。 */
	deletedWorkspaces?(): Promise<DeletedWorkspaces>;
}

export class SessionService implements DaemonService {
	readonly key = "session-tree";
	readonly routes = {
		"session.tree": "tree",
		"session.resume": "resume",
		"session.toolGates": "toolGates",
	} as const;

	readonly #deps: SessionServiceDeps;

	constructor(deps: SessionServiceDeps) {
		this.#deps = deps;
	}

	/** RPC session.tree：跨会话树（roots 无 parent；label 60 字截断；
	 *  cron 节点带 source 标注；updatedAt 供侧栏按最近活动排序）。 */
	async tree(): Promise<unknown[]> {
		const deleted = await this.#deps.deletedWorkspaces?.();
		const rows = deleted
			? (await this.#deps.knownSessions()).filter(
					r =>
						!sessionHiddenByWorkspace(
							r.cwd,
							typeof r.createdAt === "number" ? r.createdAt : Date.parse(r.createdAt),
							deleted,
						),
				)
			: await this.#deps.knownSessions();
		const cronIds = this.#deps.cronSessionIds();
		const nodes = new Map<
			string,
			{
				entry: {
					type: string;
					id: string;
					parentId: string | null;
					/** 子代理 transcript 行:GUI 渲染为父会话下的层级子行。 */
					subagent?: boolean;
					/** 顾问 transcript 行:GUI 渲染顾问标记且保持只读。 */
					advisor?: boolean;
					/** 是哪个子代理(`session_init.agent`)。 */
					agentName?: string;
					timestamp: string;
					label?: string;
					source?: string;
					updatedAt?: string;
				};
				children: unknown[];
			}
		>();
		const roots: unknown[] = [];
		for (const r of rows) {
			const title =
				r.title ??
				(this.#deps.resolveLive?.(r.sessionId)?.autoTitle !== false
					? this.#deps.firstUserMessage(r.sessionId)
					: undefined);
			nodes.set(r.sessionId, {
				entry: {
					type: "session",
					id: r.sessionId,
					parentId: r.parentId,
					/** 子代理 transcript 行:GUI 渲染为父会话下的层级子行。 */
					subagent: r.subagent === true,
					/** 顾问 transcript 行:GUI 渲染顾问标记且保持只读。 */
					advisor: r.advisor === true,
					/** 是哪个子代理(`session_init.agent`);行标题只是实例 id。 */
					agentName: r.advisor === true ? undefined : r.agentName,
					timestamp: new Date(r.createdAt).toISOString(),
					updatedAt: new Date(r.updatedAt).toISOString(),
					source: cronIds.has(r.sessionId) ? "cron" : undefined,
					...(title ? { label: title.length > 60 ? `${title.slice(0, 60)}…` : title } : {}),
				},
				children: [],
			});
		}
		for (const r of rows) {
			const node = nodes.get(r.sessionId);
			if (!node) continue;
			const parent = r.parentId ? nodes.get(r.parentId) : undefined;
			if (parent) {
				parent.children.push(node);
			} else {
				roots.push(node);
			}
		}
		return roots;
	}

	/** RPC session.resume：快照 + resumeLive 登记（订阅附着前置状态，
	 *  读取侧在 server.ts 的 catchupIfNeeded——仅当会话本就 live 才附着，
	 *  历史会话保持只读快照、不激活，P0-6）。compactedThrough = 请求 cursor
	 *  早于压缩检查点（期间 delta 已折进快照，客户端须刷新派生态）。stream
	 *  = 发起 resume 的连接 id（live 存在时客户端切流凭证）。live 时快照
	 *  附带 activeTools/agentsProgress 水合（subscribe 路由的 dock/swarm 首帧
	 *  等价物——GUI 打开路径改 resume 首选后不能丢这段）。 */
	async resume(
		params: { sessionId: string; cursor?: number },
		conn: { id: string },
	): Promise<{
		stream: string | null;
		snapshot: {
			entries?: readonly unknown[];
			activeTools?: unknown[];
			agentsProgress?: unknown[];
		};
		compactedThrough: boolean;
	}> {
		const snapshot = await this.#deps.snapshot(params.sessionId);
		let live = this.#deps.resolveLive?.(params.sessionId) ?? null;
		if (!live && this.#deps.activateLive) {
			live = await this.#deps.activateLive(params.sessionId).catch(() => null);
		}
		this.#deps.setResumeLive(conn, live);
		const checkpointSeq = await this.#deps.checkpointSeq(params.sessionId);
		const compacted = typeof params.cursor === "number" && checkpointSeq > params.cursor;
		return {
			stream: live ? conn.id : null,
			snapshot: {
				...snapshot,
				...(live?.activeToolCalls ? { activeTools: [...live.activeToolCalls.values()] } : {}),
				...(live?.subagentProgress ? { agentsProgress: [...live.subagentProgress.values()] } : {}),
			},
			compactedThrough: compacted,
		};
	}

	/** RPC session.toolGates：设置页工具开关即时生效——摘掉刚被关闭（或进入
	 *  拒绝名单）的已挂载注册工具；重新启用仍需新会话（本会话从未创建它）。
	 *  未知会话保持原错误文案 `Unknown session: <id>`。 */
	async toolGates(params: unknown): Promise<{ removed: string[]; active: string[] }> {
		const p = (params ?? {}) as { sessionId: string };
		const live = this.#deps.getSession(p.sessionId);
		if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
		const g = live.agentSession;
		const removed = await g.syncRegisteredToolGates();
		return { removed, active: g.getEnabledToolNames() };
	}
}
