import type { DaemonService } from "./types";

/**
 * SessionService — 会话树契约面（P2 首个 cordis 化 L2 服务，ADR 0001）。
 *
 * 能力缝声明（M2.4）：
 * - 名称+ns：session-tree（RPC 路由 `session.tree` / `session.resume`——
 *   客户端 tree 接口契约的归属，route-coverage 测试钉桩）。session.catchup
 *   仍归 EventService（journal 序语义载体，重复认领会被 routeTable 拒）。
 * - 输入：session.tree（跨会话树， OMP /tree  parity）、session.resume
 *  （快照 + 订阅附着前的 resumeLive 登记）。
 * - 输出：树节点（entry + children）；resume 返回 `{ stream, snapshot,
 *   compactedThrough }`；catchup 透传 EventService。
 * - 生命周期：无进程内状态——全部委托宿主（knownSessions/snapshot/
 *  checkpointSeq）与既有 L2 服务（schedule/views/events）；start/stop 无
 *  副作用。
 * - 启停：always-on——会话树是 GUI 侧栏的常驻数据面，无独立启停语义
 *  （声明理由：服务本体无状态可卸载）。
 * - 冲突：`#resumeLive` 登记是 server 的订阅附着前置状态（session.resume
 *  与 session.subscribe 的跨 RPC 约定），本服务只写不读，读取侧仍在
 *  server.ts——v2 收编 session.subscribe 时必须一并迁移该状态。分支族
 *  （branchAt/btwBranch/forkAt——复活/事件序纠缠区）按分层文档纪律留
 *  v2 独立刀。检视入口：本文件。
 */

/** 树行（host.knownSessions 返回行的结构子集，避免服务对宿主的传递依赖）。 */
export interface SessionTreeRow {
	sessionId: string;
	parentId: string | null;
	createdAt: number | string;
	updatedAt: number | string;
	title?: string;
	/** 子代理 transcript 行（task/vibe 子会话）——GUI 渲染为父行下的层级子行。 */
	subagent?: boolean;
}

/** live 会话最小结构面（tree 的 autoTitle 判定 + resumeLive 登记引用）。 */
export interface ResumeLiveHandle {
	autoTitle?: boolean;
}

export interface SessionServiceDeps {
	/** 跨会话行（宿主 DaemonSessionHost.knownSessions）。 */
	knownSessions(): Promise<readonly SessionTreeRow[]>;
	/** resume 的快照（宿主 session-host.snapshot，调用方 tailSnapshot；
	 *  结构面只要求 entries——tailSnapshot 的泛型约束）。 */
	snapshot(sessionId: string): Promise<{ entries?: readonly unknown[] }>;
	/** 压缩检查点序号（宿主 session-host.checkpointSeq）。 */
	checkpointSeq(sessionId: string): Promise<number>;
	/** 写 resumeLive 登记（server 字段 #resumeLive 的写半）。 */
	setResumeLive(live: ResumeLiveHandle | null): void;
	/** 会话 id 的 live 引用（宿主 session-host.get；resume 的 stream 判定）。 */
	resolveLive?(sessionId: string): ResumeLiveHandle | undefined;
	/** cron 会话 id 集合（ScheduleService.sessionIds——树节点 source 标注）。 */
	cronSessionIds(): Set<string>;
	/** 标题兜底（ViewStoreService.firstUserMessage——autoTitle 会话）。 */
	firstUserMessage(sessionId: string): string;
}

export class SessionService implements DaemonService {
	readonly key = "session-tree";
	readonly routes = {
		"session.tree": "tree",
		"session.resume": "resume",
	} as const;

	readonly #deps: SessionServiceDeps;

	constructor(deps: SessionServiceDeps) {
		this.#deps = deps;
	}

	/** RPC session.tree：跨会话树（roots 无 parent；label 60 字截断；
	 *  cron 节点带 source 标注；updatedAt 供侧栏按最近活动排序）。 */
	async tree(): Promise<unknown[]> {
		const rows = await this.#deps.knownSessions();
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
	 *  读取侧在 server.ts 的 session.subscribe）。compactedThrough = 请求
	 *  cursor 早于压缩检查点（期间 delta 已折进快照，客户端须刷新派生态）。
	 *  stream = 发起 resume 的连接 id（live 存在时客户端切流凭证）。 */
	async resume(
		params: { sessionId: string; cursor?: number },
		conn: { id: string },
	): Promise<{
		stream: string | null;
		snapshot: { entries?: readonly unknown[] };
		compactedThrough: boolean;
	}> {
		const snapshot = await this.#deps.snapshot(params.sessionId);
		const live = this.#deps.resolveLive?.(params.sessionId) ?? null;
		this.#deps.setResumeLive(live);
		const checkpointSeq = await this.#deps.checkpointSeq(params.sessionId);
		const compacted = typeof params.cursor === "number" && checkpointSeq > params.cursor;
		return {
			stream: live ? conn.id : null,
			snapshot,
			compactedThrough: compacted,
		};
	}
}
