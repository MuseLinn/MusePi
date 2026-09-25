import type { ApprovalBridge } from "../approval-bridge";
import type { DaemonService } from "./types";

/**
 * ApprovalService — GUI 工具审批/询问应答面（L2 宿主服务，P1 抽取）。
 *
 * 能力缝声明（M2-2.4）：
 * - 输入：RPC `tool.approve` / `tool.deny`（按 sessionId+requestId 应答
 *   待审批工具调用，`note` 为操作者自由文本理由）、`session.askAnswer`
 *   （应答待询问卡片：select 一个选项 label / input 自定义文本 / null 取消）。
 * - 输出：对 ApprovalBridge 内 pending 表的 resolve（select promise 落定）；
 *   审批/询问卡片的**发布**不经本服务（创建与订阅者广播在宿主
 *   #adoptAgentSession 的 approval-request / ask-request 信封路径）。
 * - 生命周期：无自有状态——pending 表随 LiveSession 存活（approval-bridge
 *   实例由宿主在会话接线时创建并持有），本服务只按 sessionId 寻址应答；
 *   未知会话/未知请求均抛错（原语义）。
 *
 * 范围边界（有意不包，P1 纪律）：
 * - ApprovalBridge 的创建、setToolUIContext 注入与 approval-request /
 *   ask-request 信封扇出仍在 DaemonSessionHost（会话生命周期纠缠，
 *   属最后一刀 SessionService）。
 * - subscribe 时的未答 ask 重放、tray.state 的 pending 审批枚举原地保留。
 *
 * 从 server.ts 巨型 switch 的三个 case 原样搬移（P1 纪律：纯搬移不改
 * 行为，docs/review/0.5.0-m2-daemon-host-layering.md §5）。会话访问以
 * 结构接口注入（host access），保持服务对 DaemonSessionHost 无传递依赖、
 * 可单测。
 */

/** 活跃会话的审批相关切面（结构类型，避免 import DaemonSessionHost）。 */
export interface ApprovalLiveSession {
	approvals: ApprovalBridge;
}

export interface ApprovalServiceHostAccess {
	get(sessionId: string): ApprovalLiveSession | undefined;
}

export class ApprovalService implements DaemonService {
	readonly key = "approvals";
	readonly routes = {
		"session.askAnswer": "answer",
		"tool.approve": "approve",
		"tool.deny": "deny",
	} as const;

	readonly #deps: ApprovalServiceHostAccess;

	constructor(deps: ApprovalServiceHostAccess) {
		this.#deps = deps;
	}

	/** RPC tool.approve：批准待审批工具调用。`note` = 操作者自由文本理由
	 *  （TUI ask-dialog "✎ note" parity），批准时仅记录（审批 label 契约
	 *  无它的位置——见 approval-bridge select 的 throw 路径）。 */
	approve(params: { sessionId: string; requestId: string; note?: string }): { ok: true } {
		const p = (params ?? {}) as { sessionId: string; requestId: string; note?: string };
		const live = this.#deps.get(p.sessionId);
		if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
		const note = typeof p.note === "string" && p.note.trim() ? p.note.trim() : undefined;
		if (!live.approvals.resolve(p.requestId, true, note)) throw new Error(`Unknown approval request: ${p.requestId}`);
		return { ok: true };
	}

	/** RPC tool.deny：拒绝待审批工具调用，note 成为 agent 看到的拒绝理由。 */
	deny(params: { sessionId: string; requestId: string; note?: string }): { ok: true } {
		const p = (params ?? {}) as { sessionId: string; requestId: string; note?: string };
		const live = this.#deps.get(p.sessionId);
		if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
		const note = typeof p.note === "string" && p.note.trim() ? p.note.trim() : undefined;
		if (!live.approvals.resolve(p.requestId, false, note))
			throw new Error(`Unknown approval request: ${p.requestId}`);
		return { ok: true };
	}

	/** RPC session.askAnswer：应答待询问卡片（TUI ask parity）：select 模式
	 *  取一个选项 label，input 模式取自定义文本；null 取消。 */
	answer(params: { sessionId: string; requestId: string; answer: string | null }): { ok: true } {
		const p = (params ?? {}) as { sessionId: string; requestId: string; answer: string | null };
		const live = this.#deps.get(p.sessionId);
		if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
		if (!live.approvals.resolveAsk(p.requestId, p.answer ?? null))
			throw new Error(`Unknown ask request: ${p.requestId}`);
		return { ok: true };
	}
}
