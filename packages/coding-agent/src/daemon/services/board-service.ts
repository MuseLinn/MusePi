import type { DaemonService } from "./types";

/**
 * BoardService — 看板与挂件数据面（L2 宿主服务，P1 抽取）。
 *
 * 能力缝声明（M2-2.4）：
 * - 输入：RPC `board.list` / `board.save`（GUI 看板编辑）、`widget.schema`
 *   （agent 侧 widget 工具 parity：类型/字段/默认值/卡片色调）、
 *   `widget.data`（挂件数据源代理，首个 feed 为 fx-rates）。
 * - 输出：~/.musepi/boards/boards.json 的读写视图（多客户端共享同一
 *   权威存储）；widget 数据源为 `{ rates, base, updatedAt }` 或类型化
 *   `{ error }`（软错误约定，与 git.* 、notes.* 一致，不抛进 JSON-RPC）。
 * - 生命周期：无进程内状态——boards.json 与 fx-rates 的进程内 TTL 缓存
 *   都在领域模块（boards.ts / fx-rates.ts）内；本服务是纯路由归属层。
 *
 * 范围边界：
 * - guest 侧 collab/host.ts 的 board.list/board.save 是另一数据面
 *   （访客 RPC），与 daemon switch 无关，仍直连 boards.ts 模块——同一
 *   权威存储，无需经过本服务。
 * - WIDGET_TYPES/WIDGET_TONES 保持动态 import：widget 工具模块图较重，
 *  懒加载语义与原 case 一致。
 */
export class BoardService implements DaemonService {
	readonly key = "boards";
	readonly routes = {
		"board.list": "list",
		"board.save": "save",
		"widget.schema": "schema",
		"widget.data": "data",
	} as const;

	/** RPC board.list：看板持久化在 daemon（~/.musepi/boards/boards.json），
	 *  GUI、agent 与其他窗口共享一个存储（localStorage 只是离线 GUI 的
	 *  兜底）。 */
	async list(): Promise<{ boards: unknown[] }> {
		const { readBoards } = await import("../boards");
		return { boards: readBoards() };
	}

	/** RPC board.save：整表覆写 + 内建示例保护（任何客户端的全表覆写都
	 *  不得丢内建板——agent 不能改它们，它们永远出厂如新）。校验失败抛错
	 *  （与原 case 一致）。 */
	async save(params: { boards?: unknown }): Promise<{ ok: true; boards: unknown[] }> {
		const { boards } = params ?? {};
		const { readBoards, validateBoards, writeBoards } = await import("../boards");
		const { WIDGET_TYPES } = await import("../../tools/widget");
		const check = validateBoards(boards, WIDGET_TYPES);
		if (!check.ok) throw new Error(`board.save: ${check.error}`);
		const list = boards as Array<{ id?: string; builtin?: boolean }>;
		// Builtin examples are protected: a full-list overwrite from
		// any client must not drop them (agents can't modify them, so
		// they always come back factory-fresh).
		const current = readBoards();
		const currentBuiltin = current.filter(b => b.builtin === true && !list.some(x => x.id === b.id));
		if (currentBuiltin.length > 0) writeBoards([...(boards as never[]), ...(currentBuiltin as never[])]);
		else writeBoards(boards as never);
		return { ok: true, boards: readBoards() };
	}

	/** RPC widget.schema：agent 侧 widget schema（widget 工具 parity）——
	 *  types、fields、defaults 与卡片 tones，agent 写看板挂件无需硬编码形状。 */
	async schema(): Promise<{ types: unknown; tones: unknown }> {
		const { WIDGET_TYPES } = await import("../../tools/widget");
		const { WIDGET_TONES } = await import("../../tools/widget");
		return { types: WIDGET_TYPES, tones: WIDGET_TONES };
	}

	/** RPC widget.data：daemon 侧数据源代理（docs/archive/board-dashboard.md
	 *  §4）：挂件永远不直接抓网络——daemon 按 TTL 每个 feed 只抓一次并进程
	 *  内缓存。首个 feed：FX 汇率（open.er-api.com）。 */
	async data(params: { feed?: unknown; base?: unknown }): Promise<Record<string, unknown>> {
		const { getFxRates } = await import("../fx-rates");
		const p = params ?? {};
		const feed = typeof p.feed === "string" ? p.feed : "";
		if (feed !== "fx-rates") return { error: `widget.data: unknown feed "${feed}"` };
		const base = typeof p.base === "string" && /^[A-Za-z]{3}$/.test(p.base) ? p.base.toUpperCase() : "CNY";
		const rates = await getFxRates(base);
		if (rates === null) return { error: "widget.data: FX feed unavailable" };
		return { rates, base, updatedAt: Date.now() };
	}
}
