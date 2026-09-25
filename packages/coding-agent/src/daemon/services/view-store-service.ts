import type { ViewStore } from "../view-store";
import type { DaemonService } from "./types";

/**
 * ViewStoreService — 物化视图查询面（L2 宿主服务，P1 抽取）。
 *
 * 能力缝声明（M2-2.4）：
 * - 输入：RPC `history.messages`（单会话消息行，历史查看器右栏）、
 *   `session.search`（跨会话消息搜索，按会话分组）；内部查询入口
 *   messagesFor / searchGrouped / firstUserMessage（tray.state 标题兜底）。
 * - 输出：物化查询表（view-store SQLite）的行数据；不含任何会话生命周期
 *   语义，纯只读面（搜索/取行）。
 * - 生命周期：无自有状态——本服务不持有 ViewStore 实例。P1 期间实例仍由
 *   DaemonSessionHost 持有（会话生命周期纠缠：idle 快照 upsert / 复活
 *   load / 处置 close 都在宿主会话路径内），服务构造时经注入句柄认领
 *   查询面与两条路由；P2 cordis 化时再切实例归属（服务构造 +
 *   stop() close）。
 *
 * 范围边界（有意不包，P1 纪律）：
 * - 会话列表合并（knownSessions：live + 物化行 + SDK 历史扫描）仍在
 *   DaemonSessionHost——它混合会话状态语义，是客户端列表契约的载体。
 * - 会话生命周期内的 upsert/load/remove/close 调用点原地保留。
 */
export class ViewStoreService implements DaemonService {
	readonly key = "views";
	readonly routes = {
		"history.messages": "messages",
		"session.search": "search",
	} as const;

	readonly #store: ViewStore;

	constructor(store: ViewStore) {
		this.#store = store;
	}

	/** RPC history.messages：单会话消息行（历史查看器右栏），直接出自
	 *  物化视图库，无需激活会话。默认上限 500 与原 case 一致。 */
	messages(params: { sessionId?: unknown; limit?: unknown }): ReturnType<ViewStore["messagesFor"]> {
		const { sessionId, limit } = params ?? {};
		if (typeof sessionId !== "string" || !sessionId) throw new Error("sessionId required");
		return this.#store.messagesFor(sessionId, typeof limit === "number" ? limit : 500);
	}

	/** RPC session.search：跨会话消息搜索，matches 全量 + 按会话分组计数
	 *  （store 已按时间排序，分组即顺序遍历）。默认上限 50 与原 case 一致。 */
	search(params: { query?: unknown; limit?: unknown }): {
		matches: ReturnType<ViewStore["search"]>;
		sessions: Array<{ sessionId: string; messageCount: number }>;
	} {
		const { query, limit } = params ?? {};
		const matches = this.#store.search(
			typeof query === "string" ? query : "",
			typeof limit === "number" ? limit : 50,
		);
		// Group by session, newest first (store already orders by time).
		const bySession = new Map<string, (typeof matches)[number][]>();
		for (const m of matches) {
			const list = bySession.get(m.sessionId) ?? [];
			list.push(m);
			bySession.set(m.sessionId, list);
		}
		return {
			matches,
			sessions: [...bySession.entries()].map(([sessionId, msgs]) => ({
				sessionId,
				messageCount: msgs.length,
			})),
		};
	}

	/** 单会话最早用户消息（会话树标题兜底，tray.state 消费）。 */
	firstUserMessage(sessionId: string): string {
		return this.#store.firstUserMessage(sessionId);
	}
}
