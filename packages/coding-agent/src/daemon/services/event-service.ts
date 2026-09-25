import type { ExtensionNotificationMessage } from "../../extensibility/extensions/types";
import type { BatchedEvent } from "../event-batcher";
import type { DaemonService } from "./types";

/**
 * EventService — 全局事件面（L2 宿主服务，P1 抽取）。
 *
 * 能力缝声明（M2-2.4）：
 * - 输入：RPC `events.subscribe`（连接级，订阅全局非会话事件）、
 *   `session.catchup`（会话级 gap fill，委托宿主 catchupFrom）；
 *   内部广播入口 broadcastExtensionsChanged / broadcastExtensionNotification。
 * - 输出：全局事件走各连接的事件批处理器（host emitEvent → batcher），
 *   事件载荷为 extensions.changed / extensions.notification；
 *   catchup 的 delta 帧 riding 常规推送通道，响应体轻量。
 * - 生命周期：随 DaemonServer 构造创建、随进程退出销毁；无持久状态
 *   （targets/seq 均为内存态）。连接关闭必须调 dropTarget 防泄漏。
 *
 * 范围边界（有意不包，P1 纪律——碰 session tree 契约需专项评审）：
 * - 会话级事件流（publishWireEvent / journal append / per-connection
 *   EventBatcher 生命周期 / DaemonSessionHost.catchupFrom 实现）仍归
 *   DaemonSessionHost——它们与会话生命周期、leaf 移动广播
 *   （session_leaf_moved）、事件序（seq 水位）纠缠，是 session tree
 *   客户端契约的载体，本轮只转移"全局订阅面 + catchup 路由归属"，
 *   实现委托宿主不动。
 * - 事件驱动纪律：本服务是推送语义的唯一入口，不提供任何轮询式接口。
 */

/** 全局事件订阅连接的最小结构面（DaemonConnection 的子集，防循环依赖）。 */
export interface GlobalEventConnection {
	readonly id: string;
}

export interface EventServiceHostAccess {
	emitEvent(conn: GlobalEventConnection, event: BatchedEvent): void;
	catchupFrom(sessionId: string, afterSeq: number, conn: unknown): Promise<unknown>;
}

export class EventService implements DaemonService {
	readonly key = "events";
	readonly routes = {
		"events.subscribe": "subscribe",
		"session.catchup": "catchup",
	} as const;

	readonly #host: EventServiceHostAccess;
	/** 订阅全局事件的连接（events.subscribe 注册，连接关闭 dropTarget 移除）。 */
	readonly #targets = new Set<GlobalEventConnection>();
	/** 全局事件 seq（与 session 事件水位相互独立的空间）。 */
	#seq = 0;

	constructor(host: EventServiceHostAccess) {
		this.#host = host;
	}

	/** RPC events.subscribe：注册连接为全局事件目标。 */
	subscribe(conn: GlobalEventConnection): { ok: true } {
		this.#targets.add(conn);
		return { ok: true };
	}

	/** 连接关闭清理（原 DaemonServer.dropGlobalEventTarget，ws-transport 调用）。 */
	dropTarget(connectionId: string): void {
		for (const conn of this.#targets) {
			if (conn.id === connectionId) {
				this.#targets.delete(conn);
				break;
			}
		}
	}

	/** RPC session.catchup：会话事件断档补推，实现委托宿主（journal 序
	 *  语义/session tree 事件序的载体在 DaemonSessionHost，P1 不动）。 */
	catchup(params: { sessionId?: unknown; afterSeq?: unknown }, conn: unknown): Promise<unknown> {
		if (typeof params.sessionId !== "string" || !params.sessionId) throw new Error("sessionId required");
		if (typeof params.afterSeq !== "number" || !Number.isInteger(params.afterSeq) || params.afterSeq < 0) {
			throw new Error("afterSeq must be a non-negative integer");
		}
		return this.#host.catchupFrom(params.sessionId, params.afterSeq, conn);
	}

	/** 广播 extensions.changed（extensions.list 数据变更后调用）：GUI 的
	 *  单例注册表监听此事件即时重拉——mutation RPC 清缓存后必须广播，
	 *  否则 UI 要等下一个轮询周期才看到翻转。 */
	broadcastExtensionsChanged(): void {
		this.broadcast({ type: "extensions.changed", at: Date.now() });
	}

	/** 广播 modes.changed（设置页/输入框 chip 即时刷新；与
	 *  extensions.changed 同 seq 机制）。 */
	broadcastModesChanged(): void {
		this.broadcast({ type: "modes.changed", at: Date.now() });
	}

	/** 广播 crons.changed（定时任务列表/运行状态变更后调用）：任务中心页
	 *  与 app 级完成通知监听此事件即时刷新，否则要等下一个 30s 轮询周期。
	 *  payload 只带时间戳，客户端重拉 cron.list（任务/运行数据量小，重拉
	 *  比广播全量更省心）。 */
	broadcastCronsChanged(): void {
		this.broadcast({ type: "crons.changed", at: Date.now() });
	}

	/** 广播 models.changed（models.add/models.remove 后 GUI 模型选择器
	 *  即时重拉——会话内的选择器常驻挂载，没有这个事件它永远停在旧列表）。 */
	broadcastModelsChanged(): void {
		this.broadcast({ type: "models.changed", at: Date.now() });
	}

	/** 全局事件广播原语：全部全局事件（含 STT 下载进度等任意载荷）共用
	 *  同一 seq 计数——与原 #globalEventSeq 语义一致。原语不捕获发送异常
	 *  （与原广播方法行为一致）；需要容错清理死连接的路径走
	 *  broadcastExtensionNotification。 */
	broadcast(payload: Record<string, unknown>): void {
		const seq = ++this.#seq;
		for (const conn of this.#targets) {
			this.#host.emitEvent(conn, { kind: "event", seq, payload });
		}
	}

	/** 广播 extensions.notification（扩展 registerNotificationChannel 推送）：
	 *  转发到 events.subscribe 的客户端。频道消息带 channel + 完整
	 *  message(text/title/kind)，GUI 渲染为通知。 */
	broadcastExtensionNotification(channel: string, message: ExtensionNotificationMessage): void {
		const seq = ++this.#seq;
		const payload = { type: "extensions.notification" as const, channel, message, at: Date.now() };
		for (const conn of this.#targets) {
			try {
				this.#host.emitEvent(conn, { kind: "event", seq, payload });
			} catch {
				this.#targets.delete(conn);
			}
		}
	}
}
