/**
 * 会话轨迹数据构建(纯逻辑,无 DOM 依赖):从 MaterializedView entries
 * 构建事件时间线与统计。TrajectoryView 与单元测试共用。
 *
 * 轮次语义与折叠/导航层共用 client-core isTurnStart:user 消息或
 * display:true 的 advisor 笔记各开一轮(stats.turns = 轮起始数,不是
 * assistant 消息数——长会话下后者是前者的数十倍)。
 */
import { isTurnStart } from "@musepi/client-core/src/components/transcript/round-collapse";

export interface TrajectoryEvent {
	id: string;
	kind: "assistant" | "tool" | "system" | "user" | "advisor";
	title: string;
	body?: string;
	result?: string;
	toolCallId?: string;
	turn: number;
	/** 树深度编号(沿父链的根→该条目的轮起始数):branchAt 后新主线轮的
	 *  编号 = 新分支深度(3、4…),不是 journal 追加序(5、6…)。无路径/无
	 *  id 的条目 = undefined,展示层回退 turn。 */
	pathTurn?: number;
	/** 轮展示标签:pathTurn + 同父轮起始的兄弟序——撤回/编辑重发后同一深度
	 *  并存两轮(旧分支 + 新分支),仅深度编号二者无法区分;兄弟数 > 1 时
	 *  追加序号("2-1"/"2-2",journal 创建序),独子/根轮保持纯深度。深度
	 *  链断 = undefined,展示层回退 displayTurn。 */
	pathTurnLabel?: string;
	timestamp?: string;
	/** 源 wire entry id — 轨迹行点击跳转 transcript 用。 */
	entryId?: string;
	/** 数值化时间戳(Overview 时间轴投影与区间判定用;无则 undefined)。 */
	tsMs?: number;
	/** 该事件位于分支上(entry parentId ≠ 线性前驱;非当前路径的旁支消息)。 */
	branch?: boolean;
	/** assistant 消息自带用量(wire AssistantMessage.usage,settled 回合才有)。 */
	usage?: TrajectoryUsage;
	/** 该轮模型请求耗时 ms(wire AssistantMessage.duration,settled 才有)。 */
	durationMs?: number;
	/** 首字节延迟 ms(wire AssistantMessage.ttft,settled 才有)。 */
	ttftMs?: number;
}

/** WireUsage 的展示子集(与 usage-row.ts 同源字段)。 */
export interface TrajectoryUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens?: number;
}

export interface TrajectoryStats {
	durationSec: number;
	turns: number;
	calls: number;
	model?: string;
}

function truncate(text: string, max = 220): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function stringifyArgs(args: unknown): string {
	try {
		const s = JSON.stringify(args);
		return s && s.length > 160 ? `${s.slice(0, 160)}…` : (s ?? "");
	} catch {
		return String(args ?? "");
	}
}

/**
 * first-child 主线启发式的分支集合:不在「根 → 每节点首子」链上的 message
 * 条目全部判为分支。buildTrajectory 首次用到时对自己的批次惰性计算;
 * trajectory-derive 的断点续派生必须用全量输入调本函数经 init 注入
 * (增量片段批次缺前缀,就地算会把前缀条目错判)。追加条目不改变既有
 * 节点的首子/根关系 → 集合对「已验证前缀」稳定,可跨帧复用。
 */
export function computeBranchIds(entries: readonly unknown[]): ReadonlySet<string> {
	const childrenOf = new Map<string, string[]>();
	const ids = new Set<string>();
	let rootId: string | null = null;
	for (const raw of entries) {
		if (!raw || typeof raw !== "object") continue;
		const e2 = raw as { id?: unknown; parentId?: unknown; type?: unknown };
		if (typeof e2.id !== "string" || e2.type !== "message") continue;
		ids.add(e2.id);
		const pid = e2.parentId === null || typeof e2.parentId !== "string" ? null : e2.parentId;
		if (pid !== null) {
			const arr = childrenOf.get(pid) ?? [];
			arr.push(e2.id);
			childrenOf.set(pid, arr);
		} else if (rootId === null) {
			rootId = e2.id;
		}
	}
	// 主线 = 从根沿 first-child 下行;其余全部 = 分支。
	const main = new Set<string>();
	let cur = rootId;
	while (cur !== null && ids.has(cur)) {
		main.add(cur);
		cur = childrenOf.get(cur)?.[0] ?? null;
	}
	const branch = new Set<string>();
	for (const id of ids) if (!main.has(id)) branch.add(id);
	return branch;
}

/**
 * 构建轨迹事件。activePath(可选)= 当前活跃叶路径上的条目 id 集
 * (GUI 由 leafWalk/pinnedPathIds 提供)。提供时:
 *  - 主线/分支按"是否在活跃路径上"判定(取代 first-child 启发式)——
 *    branchAt/编辑重发后旧分支整链标 branch,新主线轮回到主线列;
 *  - 每个事件带 pathTurn(树深度),branchAt 后的新轮编号 = 新分支深度
 *    (撤回第 2 轮再发问 → 新轮是"第 3 轮",不是 journal 追加序的第 5 轮)。
 * 不提供时保持旧行为(first-child 链 = 主线,追加序编号)。
 *
 * hooks(可选,trajectory-derive 的增量复用用):
 *  - init:从上次派生的断点状态继续(turn/toolCalls/首末 ts/toolIndex/
 *    branchIds),只对「entries 是接在断点后的增量片段」的调用有意义;
 *  - onState:消费每条目前的运行态快照(断点记账,复用端按 index 存);
 *  - probe.derivedEntries:每跑一条完整派生 +1(契约测试用来证明
 *    流式追加一帧的重算量与新增条目相关、与总条目无关,P1-11)。
 */
export interface TrajectoryRunState {
	turn: number;
	toolCalls: number;
	firstTs: number | undefined;
	lastTs: number | undefined;
	/** 当前轮展示标签(最后一个轮起始的 pathTurnLabel):断点续派生从
	 *  init 恢复,增量片段里归属前缀轮的 assistant/tool 事件与一次性
	 *  派生同标签(共价契约)。 */
	turnLabel: string | undefined;
	/** 已消费条目产生的事件数(断点拼接用,纯函数调用恒为 0 可忽略)。 */
	eventCount: number;
	/** toolCallId → 最近的 TOOL 事件(结果回填)。跨增量片段共享同一引用。 */
	toolIndex: Map<string, TrajectoryEvent>;
	branchIds: ReadonlySet<string> | undefined;
}

export interface BuildTrajectoryHooks {
	init?: TrajectoryRunState;
	/** 全量批次的树深度索引(增量派生注入;缺省对本批次自建)。 */
	batch?: TrajectoryBatchIndex;
	onState?: (index: number, state: TrajectoryRunState) => void;
	probe?: { derivedEntries: number };
}

export function initialTrajectoryRunState(): TrajectoryRunState {
	return {
		turn: 0,
		toolCalls: 0,
		firstTs: undefined,
		lastTs: undefined,
		turnLabel: undefined,
		eventCount: 0,
		toolIndex: new Map<string, TrajectoryEvent>(),
		branchIds: undefined,
	};
}

/** 树深度索引:parentId 映射 + 轮起始集合 + 首条可见条目 id。一次遍历,
 *  深链(上万条)的记忆化行走靠它不退化成 O(n²)。轮起始口径与折叠/
 *  导航层一致(isTurnStart:user 消息或 display advisor 笔记)。
 *  注意:深度判定的「本批」边界就是这个索引——增量派生(trajectory-
 *  derive)的增量片段批次缺前缀,必须把全量输入索引后经 hooks.batch
 *  注入,否则前缀父被误判链断、pathTurn 全丢。 */
export interface TrajectoryBatchIndex {
	parentOf: Map<string, string | null>;
	turnStartIds: Set<string>;
	firstEntryId: string | undefined;
}

export function indexTrajectoryBatch(entries: readonly unknown[]): TrajectoryBatchIndex {
	const parentOf = new Map<string, string | null>();
	const turnStartIds = new Set<string>();
	let firstEntryId: string | undefined;
	for (const raw of entries) {
		if (!raw || typeof raw !== "object") continue;
		const e = raw as { id?: unknown; parentId?: unknown };
		if (typeof e.id !== "string") continue;
		if (firstEntryId === undefined) firstEntryId = e.id;
		parentOf.set(e.id, typeof e.parentId === "string" ? e.parentId : null);
		if (isTurnStart(raw as Parameters<typeof isTurnStart>[0])) turnStartIds.add(e.id);
	}
	return { parentOf, turnStartIds, firstEntryId };
}

export function buildTrajectory(
	entries: readonly unknown[],
	activePath?: ReadonlySet<string>,
	hooks?: BuildTrajectoryHooks,
): { events: TrajectoryEvent[]; stats: TrajectoryStats; finalState: TrajectoryRunState } {
	const events: TrajectoryEvent[] = [];
	const init = hooks?.init;
	let turn = init?.turn ?? 0;
	let toolCalls = init?.toolCalls ?? 0;
	let firstTs = init?.firstTs;
	let lastTs = init?.lastTs;
	/** 累计事件数 = init 携带的前缀事件数 + 本片段新生成(events 只是本
	 *  片段的局部数组,断点记账必须用累计值)。 */
	const baseEventCount = init?.eventCount ?? 0;
	/** toolCallId → 最近的 TOOL 事件(结果回填)。 */
	const toolIndex = init?.toolIndex ?? new Map<string, TrajectoryEvent>();
	let branchIds = init?.branchIds;

	// ── 树深度索引:默认对本批次构建;增量复用方注入全量索引(见
	//  indexTrajectoryBatch 的边界说明)。
	const batch = hooks?.batch ?? indexTrajectoryBatch(entries);
	const parentOf = batch.parentOf;
	const turnStartIds = batch.turnStartIds;
	const firstEntryId = batch.firstEntryId;
	const depthMemo = new Map<string, number>();
	/** 断链/假根判定也是可记忆化的结论:链上任意节点重查都指向同一个
	 *  断点,不记下就会每个事件重走一遍链(P1-11:尾窗头部条目父在窗外
	 *  是常态,单次重算因此退化为 O(n²))。 */
	const depthBroken = new Set<string>();
	/** 树深度(含自身)的轮起始数。链断(父是 string 但不在本批条目)或
	 *  parentless 但不是首条可见条目(发射端漏打 parentId —— 与 leaf-walk
	 *  同一规则)时返回 undefined,调用方回退 journal 序,不把断链深度当真
	 *  编号(实机回归:parentless 顾问卡全显示 "Turn 1")。 */
	const depthOf = (id: string): number | undefined => {
		if (depthBroken.has(id)) return undefined;
		const hit = depthMemo.get(id);
		if (hit !== undefined) return hit;
		const chain: string[] = [];
		let base = 0;
		let cur: string = id;
		let broken = false;
		for (;;) {
			if (depthBroken.has(cur)) {
				broken = true;
				break;
			}
			const cached = depthMemo.get(cur);
			if (cached !== undefined) {
				base = cached;
				break;
			}
			chain.push(cur);
			const p = parentOf.get(cur);
			if (p === undefined) break; // 根(预计算外的入口,防御)
			if (p === null) {
				if (cur !== firstEntryId) broken = true; // 假根:深度不可信
				break; // 真根 = 首条可见条目
			}
			if (!parentOf.has(p)) {
				broken = true; // 链断:深度不可信
				break;
			}
			cur = p;
		}
		if (broken) {
			// 链上所有已访问节点共享同一个 undefined 结论,一次记下。
			for (const n of chain) depthBroken.add(n);
			return undefined;
		}
		let d = base;
		for (let i = chain.length - 1; i >= 0; i--) {
			if (turnStartIds.has(chain[i]!)) d += 1;
			depthMemo.set(chain[i]!, d);
		}
		return depthMemo.get(id) ?? base;
	};
	/** 轮起始的「最近轮起始祖先」+ 兄弟序索引(惰性,一次构建)。兄弟 =
	 *  同一父轮起始下的轮起始集合,按 journal 创建序编号 1..n;turnStartIds
	 *  的迭代序即条目序(indexTrajectoryBatch 按输入顺序插入),分桶后天然
	 *  有序。深度判定的「本批」边界同样适用:索引基于注入的 batch(增量
	 *  派生经 hooks.batch 拿全量前缀),就地算会把前缀轮误判为无父。 */
	let turnSiblingIndex:
		| {
				parentStartOf: Map<string, string | null>;
				siblingOf: Map<string, number>;
				siblingsOfParent: Map<string, number>;
		  }
		| undefined;
	const siblingIndex = () => {
		if (turnSiblingIndex) return turnSiblingIndex;
		const nearestMemo = new Map<string, string | null>();
		/** 沿父链找最近的轮起始祖先(不含自身)。 */
		const nearestStartAncestor = (id: string): string | null => {
			const hit = nearestMemo.get(id);
			if (hit !== undefined) return hit;
			let result: string | null = null;
			let cur = parentOf.get(id);
			const seen = new Set<string>();
			while (typeof cur === "string" && !seen.has(cur)) {
				seen.add(cur);
				if (turnStartIds.has(cur)) {
					result = cur;
					break;
				}
				cur = parentOf.get(cur);
			}
			nearestMemo.set(id, result);
			return result;
		};
		const buckets = new Map<string, string[]>();
		const parentStartOf = new Map<string, string | null>();
		for (const sid of turnStartIds) {
			const par = nearestStartAncestor(sid);
			parentStartOf.set(sid, par);
			if (par !== null) {
				const arr = buckets.get(par) ?? [];
				arr.push(sid);
				buckets.set(par, arr);
			}
		}
		const siblingOf = new Map<string, number>();
		const siblingsOfParent = new Map<string, number>();
		for (const [par, arr] of buckets) {
			siblingsOfParent.set(par, arr.length);
			arr.forEach((sid, i) => siblingOf.set(sid, i + 1));
		}
		turnSiblingIndex = { parentStartOf, siblingOf, siblingsOfParent };
		return turnSiblingIndex;
	};
	/** 轮标签:pathTurn 深度 + 同父兄弟序(兄弟数 > 1 时)。深度链断 =
	 *  undefined,调用方回退旧编号(与 pathTurn 同一契约)。 */
	const turnLabelOf = (turnStartId: string, depth: number | undefined): string | undefined => {
		if (depth === undefined) return undefined;
		const idx = siblingIndex();
		const par = idx.parentStartOf.get(turnStartId) ?? null;
		if (par !== null && (idx.siblingsOfParent.get(par) ?? 1) > 1) {
			const sib = idx.siblingOf.get(turnStartId);
			if (sib !== undefined) return `${depth}-${sib}`;
		}
		return `${depth}`;
	};

	let currentTurnLabel: string | undefined = init?.turnLabel;
	for (const [index, raw] of entries.entries()) {
		if (!raw || typeof raw !== "object") continue;
		if (hooks?.probe) hooks.probe.derivedEntries += 1;
		hooks?.onState?.(index, {
			turn,
			toolCalls,
			firstTs,
			lastTs,
			turnLabel: currentTurnLabel,
			eventCount: baseEventCount + events.length,
			toolIndex,
			branchIds,
		});
		const entry = raw as {
			type?: string;
			message?: Record<string, unknown>;
			timestamp?: string;
			id?: string;
			parentId?: string | null;
		};
		const entryId = typeof entry.id === "string" ? entry.id : undefined;
		const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
		const tsMs = Number.isFinite(ts) ? ts : undefined;
		if (tsMs !== undefined) {
			if (firstTs === undefined) firstTs = tsMs;
			lastTs = tsMs;
		}
		const type = entry.type ?? "";
		const msg = entry.message as
			| {
					role?: string;
					content?: unknown;
					toolCallId?: string;
					name?: string;
					arguments?: unknown;
					result?: unknown;
					/** wire AssistantMessage 自带字段(settled 回合才有)。 */
					usage?: TrajectoryUsage;
					duration?: number;
					ttft?: number;
			  }
			| undefined;

		if (type === "message" && msg?.role === "toolResult") {
			// ToolResultMessage:回填对应 TOOL 事件的结果预览。
			const target = toolIndex.get(msg.toolCallId ?? "");
			if (target) {
				const content = Array.isArray(msg.content)
					? (msg.content as Array<{ type?: string; text?: string }>)
							.filter(c => c?.type === "text")
							.map(c => c.text ?? "")
							.join(" ")
					: String(msg.content ?? "");
				target.result = truncate(content || String(msg.result ?? ""), 160);
			}
		} else if (type === "message" && msg) {
			// 分支判定:有活跃路径 = "不在路径上即分支"(branchAt 后旧链整体
			// 入分支列,新主线轮归主线);无路径 = 旧 first-child 启发式。
			let isBranch: boolean;
			if (activePath !== undefined && activePath.size > 0) {
				isBranch = entryId !== undefined && !activePath.has(entryId);
			} else {
				// Branch detection: a message not on the main first-child chain is
				// a branch (re-answer / fork continuation) — the timeline flags
				// it instead of hiding it. Set is computed lazily on first use;
				// 增量复用方(trajectory-derive)对全量输入预计算后经 init 注入,
				// 增量片段自己的小批次算出来的集合不可信(缺前缀条目)。
				if (branchIds === undefined) {
					branchIds = computeBranchIds(entries);
				}
				isBranch = entryId !== undefined && branchIds.has(entryId);
			}
			const pathTurn = entryId !== undefined ? depthOf(entryId) : undefined;
			if (msg.role === "user") {
				turn += 1;
				currentTurnLabel = entryId !== undefined ? turnLabelOf(entryId, pathTurn) : undefined;
				const text = Array.isArray(msg.content)
					? msg.content
							.filter((c: { type?: string; text?: string }) => c?.type === "text")
							.map((c: { text?: string }) => c.text ?? "")
							.join(" ")
					: String(msg.content ?? "");
				if (text.trim())
					events.push({
						id: `user:${turn}:${ts}`,
						kind: "user",
						title: truncate(text.trim(), 80),
						turn,
						pathTurn,
						pathTurnLabel: currentTurnLabel,
						timestamp: entry.timestamp,
						entryId,
						tsMs,
						branch: isBranch || undefined,
					});
				continue;
			}
			if (msg.role === "assistant") {
				const parts = Array.isArray(msg.content) ? msg.content : [];
				let text = "";
				let thinking = "";
				for (const part of parts as Array<{
					type?: string;
					text?: string;
					thinking?: string;
					name?: string;
					id?: string;
					arguments?: unknown;
				}>) {
					if (part?.type === "text" && part.text) text += part.text;
					else if (part?.type === "thinking" && part.thinking) thinking += part.thinking;
					else if (part?.type === "toolCall" && part.name) {
						toolCalls += 1;
						const ev: TrajectoryEvent = {
							id: `tool:${turn}:${part.name}:${toolCalls}`,
							kind: "tool",
							title: part.name,
							body: stringifyArgs(part.arguments),
							turn,
							pathTurn,
							pathTurnLabel: currentTurnLabel,
							timestamp: entry.timestamp,
							entryId,
							tsMs,
							branch: isBranch || undefined,
						};
						toolIndex.set(part.id ?? ev.id, ev);
						events.push(ev);
					}
				}
				const summary = text.trim() || (thinking.trim() ? `💭 ${truncate(thinking.trim(), 120)}` : "");
				if (summary) {
					events.push({
						id: `assistant:${turn}:${ts}`,
						kind: "assistant",
						title: truncate(summary, 120),
						body: truncate(summary),
						turn,
						pathTurn,
						pathTurnLabel: currentTurnLabel,
						timestamp: entry.timestamp,
						entryId,
						tsMs,
						// settled 回合的模型请求统计(wire AssistantMessage 原样携带)。
						usage: msg.usage,
						durationMs: msg.duration,
						ttftMs: msg.ttft,
						branch: isBranch || undefined,
					});
				}
			}
		} else if (type === "custom_message" && isTurnStart(raw as Parameters<typeof isTurnStart>[0])) {
			// 顾问(advisor)笔记:与折叠/导航层同一 isTurnStart 口径,各开一轮;
			// 该轮后续 assistant/tool 事件自然归入此 turn。标题取
			// details.notes[].note 的干净文本(与 Transcript 同一解包);
			// content 是给模型看的 <advisory> XML,永不外露(实机回归:地图
			// 节点标题泄出 XML)。
			turn += 1;
			const details = (raw as { details?: unknown }).details;
			const notes =
				details !== null && typeof details === "object" && "notes" in details && Array.isArray(details.notes)
					? (details.notes as Array<{ note?: unknown }>)
					: [];
			const noteText = notes
				.map(n => (typeof n?.note === "string" ? n.note : ""))
				.filter(s => s.trim().length > 0)
				.join("; ");
			const c = (raw as { content?: unknown }).content;
			const contentText =
				typeof c === "string"
					? c
					: Array.isArray(c)
						? (c as Array<{ type?: string; text?: string }>)
								.filter(b => b?.type === "text")
								.map(b => b.text ?? "")
								.join(" ")
						: "";
			const text = noteText || contentText;
			const advisorPathTurn = entryId !== undefined ? depthOf(entryId) : undefined;
			currentTurnLabel = entryId !== undefined ? turnLabelOf(entryId, advisorPathTurn) : undefined;
			events.push({
				id: `advisor:${turn}:${ts}`,
				kind: "advisor",
				title: truncate(text.trim(), 80) || "advisor",
				turn,
				pathTurn: advisorPathTurn,
				pathTurnLabel: currentTurnLabel,
				timestamp: entry.timestamp,
				entryId,
				tsMs,
			});
		} else if (type === "custom_message" && (raw as { customType?: unknown }).customType === "tool_registry") {
			// 工具注册表时间线（热插拔注入行）：display-only custom_message，
			// 与 model_change 同款 system 事件——title 用原始类型名，组件层
			// 映射 i18n（保持纯逻辑无 i18n 依赖）。
			events.push({
				id: `tool_registry:${ts}`,
				kind: "system",
				title: "tool_registry",
				turn,
				pathTurn: entryId !== undefined ? depthOf(entryId) : undefined,
				timestamp: entry.timestamp,
				entryId,
				tsMs,
			});
		} else if (type === "model_change" || type === "thinking_level_change") {
			// system 事件:title 用原始类型名,组件层映射 i18n(保持纯逻辑无 i18n 依赖)。
			events.push({
				id: `${type}:${ts}`,
				kind: "system",
				title: type,
				turn,
				pathTurn: entryId !== undefined ? depthOf(entryId) : undefined,
				timestamp: entry.timestamp,
				entryId,
				tsMs,
			});
		}
	}

	const finalState: TrajectoryRunState = {
		turn,
		toolCalls,
		firstTs,
		lastTs,
		turnLabel: currentTurnLabel,
		eventCount: baseEventCount + events.length,
		toolIndex,
		branchIds,
	};
	return {
		events,
		finalState,
		stats: {
			durationSec:
				firstTs !== undefined && lastTs !== undefined ? Math.max(0, Math.round((lastTs - firstTs) / 1000)) : 0,
			// 轮起始数(user + advisor,与折叠/导航/地图同口径)——不是
			// assistant 消息数(长会话下二者差数十倍,用户当作"轮次"读)。
			// 有活跃路径时只数主线轮(废弃分支的轮不占当前会话轮数)。
			turns:
				activePath !== undefined && activePath.size > 0
					? events.filter(e => (e.kind === "user" || e.kind === "advisor") && e.branch !== true).length
					: turn,
			calls: toolCalls,
		},
	};
}

/** 按 turn 分组的轨迹树(events 已带 turn 字段):折叠节点 = turn 摘要
 *  (assistant 标题/调用数/首个时间戳),展开 = 该 turn 事件列表。纯逻辑,
 *  TrajectoryView 与单元测试共用。 */
export interface TrajectoryTurnGroup {
	turn: number;
	/** 展示编号 = 组内事件的树深度(pathTurn);无 = 回退 turn(journal 序)。 */
	displayTurn?: number;
	/** 展示标签 = 组内事件的 pathTurnLabel(深度 + 同父兄弟序,如
	 *  "2-1"/"2-2");无 = 回退 displayTurn。撤回/编辑重发后的兄弟轮
	 *  仅靠深度编号无法区分,标签补 journal 创建序序号。 */
	displayTurnLabel?: string;
	events: TrajectoryEvent[];
	/** 该 turn 首个事件时间戳(折叠行显示;无则 undefined)。 */
	firstTs?: string;
	/** 该 turn 首个事件数值时间戳(Overview 时间轴投影锚)。 */
	startMs?: number;
	/** 该 turn 末端(最后一个事件;roundDurations 命中时 = start+duration,
	 *  钳制不超过组内最后事件时刻)。 */
	endMs?: number;
	/** 该 turn 完整回合时长(agent_end 冻结值,仅已完成回合有)。 */
	roundDurationMs?: number;
}

/**
 * 归一化 roundDurations(daemon agent_end 冻结的整轮用时,当前键 = turn 起点
 * tsMs(isTurnStart 语义);pre-anchor 快照 = 组内首条 assistant tsMs → 时长
 * ms,查询端回退兼容)。GUI store 以 Map 形态暴露,持久化快照/测试以
 * [number, number][] 形态出现。
 */
export type RoundDurationMap = ReadonlyMap<number, number> | readonly (readonly [number, number])[];

function roundDurationsOf(src: RoundDurationMap | undefined): ReadonlyMap<number, number> {
	if (!src) return new Map();
	if (src instanceof Map) return src;
	const m = new Map<number, number>();
	for (const pair of src) {
		if (Array.isArray(pair) && pair.length === 2 && Number.isInteger(pair[0]) && Number.isInteger(pair[1])) {
			m.set(pair[0] as number, pair[1] as number);
		}
	}
	return m;
}

/** 按事件分组成轮(turn 字段已有;roundDurations 锚定回合时长)。纯逻辑,
 *  buildTrajectoryTree / trajectory-derive 共用。 */
export function groupTrajectoryTurns(
	events: readonly TrajectoryEvent[],
	roundDurations?: RoundDurationMap,
): TrajectoryTurnGroup[] {
	const durations = roundDurationsOf(roundDurations);
	const turns: TrajectoryTurnGroup[] = [];
	for (const ev of events) {
		let group = turns[turns.length - 1];
		if (!group || group.turn !== ev.turn) {
			group = {
				turn: ev.turn,
				// 展示编号 = 组内事件的树深度(pathTurn);链断(undefined)回退
				// journal 序 turn,不把断链深度当真编号。
				displayTurn: ev.pathTurn ?? ev.turn,
				// 展示标签 = 组内事件的 pathTurnLabel(深度+同父兄弟序);
				// 组首事件恒为轮起始(user/advisor),标签随该轮起始。
				displayTurnLabel: ev.pathTurnLabel,
				events: [],
				firstTs: ev.timestamp,
				startMs: ev.tsMs,
			};
			turns.push(group);
		}
		group.events.push(ev);
		// 末端时间 = 组内最后一条带 tsMs 的事件(组内有序,直接覆盖)。
		if (ev.tsMs !== undefined) group.endMs = ev.tsMs;
	}
	// roundDurations 命中:回合锚 = turn 起点 tsMs(materialized-view agent_end
	// 的当前记录键,isTurnStart 语义);pre-anchor 快照按组内首条 assistant ts
	// 记录 → 回退查询保持可读。完整回合闭合 = start + duration,但 endMs
	// 钳制在组内最后事件时刻:时长锚跨空闲/跨轮被污染时(实机回归),旧值
	// 会把 Overview 时间域撑到数百小时。
	for (const group of turns) {
		if (group.startMs === undefined) continue;
		const assistant = group.events.find(e => e.kind === "assistant" && e.tsMs !== undefined);
		const duration =
			durations.get(group.startMs) ?? (assistant?.tsMs !== undefined ? durations.get(assistant.tsMs) : undefined);
		if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
			group.roundDurationMs = duration;
			const candidate = group.startMs + duration;
			group.endMs = group.endMs !== undefined && candidate > group.endMs ? group.endMs : candidate;
		}
	}
	return turns;
}

/** 一次性全量入口(测试与回退用):buildTrajectory + 分组。 */
export function buildTrajectoryTree(
	entries: readonly unknown[],
	roundDurations?: RoundDurationMap,
	activePath?: ReadonlySet<string>,
): {
	turns: TrajectoryTurnGroup[];
	stats: TrajectoryStats;
} {
	const { events, stats } = buildTrajectory(entries, activePath);
	return { turns: groupTrajectoryTurns(events, roundDurations), stats };
}

/** 事件是否落在 [startMs, endMs] 区间内(Overview 拖拽聚焦的高亮/置灰判定)。
 *  无 tsMs 的事件视为不在区间(区间模式从不误亮未知时刻)。纯逻辑,组件复用。 */
export function isTrajectoryEventInRange(ev: TrajectoryEvent, startMs: number, endMs: number): boolean {
	if (ev.tsMs === undefined) return false;
	return ev.tsMs >= startMs && ev.tsMs <= endMs;
}
