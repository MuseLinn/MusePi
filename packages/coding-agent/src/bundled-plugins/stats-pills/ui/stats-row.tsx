/**
 * 性能与用量读数（slot: `composer.dock`）— 插件自己的组件。
 *
 * 两枚胶囊（液态玻璃样式用本应用的设计令牌）：
 *
 * - **活动**（`data-composer-stat="activity"`）：轮次/步数 + 解码速度；
 *   窗口里有任一计时读数时是可点击按钮，点开弹窗列出模型耗时、工具耗时、
 *   平均首字、速度；
 * - **用量**（`data-composer-stat="usage"`）：token 总量 + 缓存命中率；
 *   点击弹窗按账单桶拆分（命中、未缓存输入、输入、缓存读、缓存写、输出、
 *   花费）。
 *
 * 数据全部来自宿主已有的 `session.contextUsage` RPC：
 *
 * - `usage` 块 — token 用量、花费、缓存命中率（持久投影，翻页/压缩不动）；
 * - `windowStats` 块 — 可见窗口计时折叠（轮次、步数、耗时、首字、解码），
 *   回答「这次会话现在有多快」。
 *
 * 显示规则（与宿主原来的读数行一致，避免用户升级后看到不一样的数字）：
 *
 * - **简洁模式**：只显示速度与缓存命中率两枚纯读数胶囊，无弹窗；
 * - **详细模式**：两枚胶囊都可点击（活动胶囊在没有计时读数时退化为纯读数）；
 * - **没有读数时保留固定高度并显示 `—`**——初始加载和空会话不推动输入区。
 *
 * 弹窗行为约定：同一行最多开一个；Escape 或点外部关闭；弹窗门户到
 * body 并用锚点量位，不被输入区的裁切上下文吞掉。
 *
 * 简洁/详细偏好存在 localStorage，与设置页的那一行共用同一个键，所以在哪边
 * 改都同帧生效。
 */

import "./stats-row.css";

// ── 平台面 ──────────────────────────────────────────────────────────────
// 宿主把此文件编译给 renderer，但在 daemon 工程内做类型检查（无 DOM lib）。
// 只声明用到的最小表面；组件通过 `React` 标识符取宿主的 React 实例
// （编译器 define: React → window.MusePiReact，绝不裸 import react）。

declare const React: {
	createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown;
	createPortal: (children: unknown, container: unknown) => unknown;
	Fragment: unknown;
	useState: <T>(initial: T | (() => T)) => [T, (v: T | ((prev: T) => T)) => void];
	useEffect: (fn: () => void | (() => void), deps?: readonly unknown[]) => void;
	useLayoutEffect: (fn: () => void | (() => void), deps?: readonly unknown[]) => void;
	useRef: <T>(initial: T | null) => { current: T | null };
	useSyncExternalStore: <T>(subscribe: (cb: () => void) => () => void, get: () => T, getServer: () => T) => T;
};
declare const window: {
	addEventListener(type: string, cb: (ev?: unknown) => void): void;
	removeEventListener(type: string, cb: (ev?: unknown) => void): void;
	readonly innerHeight: number;
};
declare const localStorage: {
	getItem(key: string): string | null;
};
declare const document: {
	readonly body: unknown;
	addEventListener(type: string, cb: (ev?: unknown) => void): void;
	removeEventListener(type: string, cb: (ev?: unknown) => void): void;
};

interface RectLike {
	readonly left: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
}
interface ElemLike {
	getBoundingClientRect(): RectLike;
}

type ReactNode = unknown;
type StatsMode = "detailed" | "compact";
type StatId = "activity" | "usage";

/** One `session.contextUsage` usage row, as the daemon sends it. */
interface UsageView {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
	cacheHitRate: number | null;
}

/** One `session.contextUsage.windowStats` row (pi-wire 的 WindowStats 形状)。 */
interface WindowStatsView {
	turns: number;
	steps: number;
	llmMs: number;
	toolMs: number;
	ttftMs: number;
	ttftSteps: number;
	decodeMs: number;
	decodeTokens: number;
}

interface ContextUsageResponse {
	usage?: UsageView | null;
	windowStats?: WindowStatsView | null;
}

interface SlotProps {
	rpc?: {
		request: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
	} | null;
	sessionId?: string | null;
}

const STATS_MODE_KEY = "musepi-gui-stats-mode";
const STATS_MODE_EVENT = "musepi-stats-mode-changed";
const POLL_INTERVAL_MS = 3000;

function readStatsMode(): StatsMode {
	try {
		return localStorage.getItem(STATS_MODE_KEY) === "compact" ? "compact" : "detailed";
	} catch {
		return "detailed";
	}
}

function subscribeStatsMode(onChange: () => void): () => void {
	const onEvent = (): void => onChange();
	window.addEventListener(STATS_MODE_EVENT, onEvent);
	window.addEventListener("storage", onEvent);
	return () => {
		window.removeEventListener(STATS_MODE_EVENT, onEvent);
		window.removeEventListener("storage", onEvent);
	};
}

// ── 数字格式 ──────────────────────────────────────────────────────────────

/** Compact token count ("1.2M", "34.5K", "812"). */
function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
	return String(Math.round(n));
}

/** USD with sub-cent precision kept visible — session totals are small. */
function formatSpend(cost: number): string {
	if (cost >= 1) return `$${cost.toFixed(2)}`;
	if (cost >= 0.01) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(4)}`;
}

/** Compact duration: 45.2s under a minute, 2m42s from there on. */
function formatDuration(ms: number): string {
	const s = ms / 1000;
	if (s < 60) return `${Math.round(s * 10) / 10}s`;
	const whole = Math.round(s);
	return `${Math.floor(whole / 60)}m${whole % 60}s`;
}

/** Decode speed reading; null when no decode-timed step exists. */
function formatSpeed(stats: WindowStatsView): string | null {
	return stats.decodeMs > 0 ? `${((stats.decodeTokens / stats.decodeMs) * 1000).toFixed(1)} tok/s` : null;
}

/**
 * Cache-hit percent text: integer text when integer rounding stays
 * below 100, otherwise the minimum decimal precision that still rounds below
 * 100; a full hit returns "100".
 */
function formatHitRate(percent: number): string {
	for (let prec = 0; prec <= 2; prec += 1) {
		const text = percent.toFixed(prec);
		if (Number.parseFloat(text) < 100) return text;
	}
	return "100";
}

/** Billed input buckets + output — the usage pill's「总 tok」figure. */
function billedTotalTokens(usage: UsageView): number {
	return usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
}

/** True when the session has billed any tokens — gates the usage pill. */
function hasTokenActivity(usage: UsageView | null): boolean {
	return usage !== null && (usage.input + usage.cacheRead + usage.cacheWrite > 0 || usage.output > 0);
}

/** True when the window carries no timing figure at all. */
function hasAnyTiming(stats: WindowStatsView): boolean {
	return stats.llmMs > 0 || stats.toolMs > 0 || stats.ttftSteps > 0 || stats.decodeMs > 0;
}

// ── 图标（内联 SVG，插件不引宿主的图标库）───────────────────────────────

function GaugeIcon(): ReactNode {
	return React.createElement(
		"svg",
		{ width: 12, height: 12, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
		React.createElement("circle", { cx: 8, cy: 9, r: 5.5, stroke: "currentColor", strokeWidth: 1.4 }),
		React.createElement("path", {
			d: "M8 9 L10.5 5.5",
			stroke: "currentColor",
			strokeWidth: 1.4,
			strokeLinecap: "round",
		}),
		React.createElement("path", {
			d: "M2.5 4.5 L4 6",
			stroke: "currentColor",
			strokeWidth: 1.4,
			strokeLinecap: "round",
		}),
	);
}

function DatabaseIcon(): ReactNode {
	return React.createElement(
		"svg",
		{ width: 12, height: 12, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
		React.createElement("ellipse", { cx: 8, cy: 4, rx: 5, ry: 2, stroke: "currentColor", strokeWidth: 1.4 }),
		React.createElement("path", {
			d: "M3 4 V12 C3 13.1 5.2 14 8 14 C10.8 14 13 13.1 13 12 V4",
			stroke: "currentColor",
			strokeWidth: 1.4,
		}),
		React.createElement("path", {
			d: "M3 8 C3 9.1 5.2 10 8 10 C10.8 10 13 9.1 13 8",
			stroke: "currentColor",
			strokeWidth: 1.4,
		}),
	);
}

// ── 弹窗骨架 ────────────────────────────────────────────────────────────

/**
 * 门户到 body 的玻璃弹窗：锚点量位（中对其上），Escape 或外部点按关闭。
 * 打开时往 document 挂一次性监听，关闭即摘。
 */
function Popover(props: {
	open: boolean;
	onClose(): void;
	anchorRef: { current: ElemLike | null };
	title: string;
	titleValue?: string;
	icon: ReactNode;
	children: ReactNode;
}): ReactNode {
	const { open, onClose, anchorRef, title, titleValue, icon, children } = props;
	const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null);
	const [mounted, setMounted] = React.useState(open);

	React.useLayoutEffect(() => {
		if (!open) return;
		const rect = anchorRef.current?.getBoundingClientRect();
		if (rect) {
			// 中对其上：left 取锚点中心，top 取锚点上沿上方 8px；
			// 翻转留给宿主视口（弹窗矮，输入区在底部，向上不会出界）。
			setPos({ left: rect.left + rect.width / 2, top: rect.top - 8 });
		}
		const onKey = (ev?: unknown): void => {
			const key = (ev as { key?: string } | undefined)?.key;
			if (key === "Escape") onClose();
		};
		const onPointer = (ev?: unknown): void => {
			const target = (ev as { target?: unknown } | undefined)?.target as
				| { closest?: (sel: string) => unknown }
				| null
				| undefined;
			const inside =
				(target?.closest?.(".mpstats-anchor") ?? null) !== null ||
				(target?.closest?.(".mpstats-pop") ?? null) !== null;
			if (!inside) onClose();
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("pointerdown", onPointer);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("pointerdown", onPointer);
		};
	}, [open, onClose, anchorRef]);

	React.useEffect(() => {
		if (open) {
			setMounted(true);
			return;
		}
		if (!mounted) return;
		const timer = setTimeout(() => setMounted(false), 140);
		return () => clearTimeout(timer);
	}, [open, mounted]);

	if (!mounted) return null;
	const style: Record<string, unknown> = pos
		? { left: pos.left, top: pos.top, transform: "translate(-50%, -100%)" }
		: { left: -9999, top: -9999, transform: "translate(-50%, -100%)" };
	return React.createPortal(
		React.createElement(
			"div",
			{
				className: open ? "mpstats-pop" : "mpstats-pop mpstats-pop--closing",
				role: "dialog",
				"aria-label": title,
				style,
			},
			React.createElement(
				"div",
				{ className: "mpstats-pop-motion" },
				React.createElement(
					"div",
					{ className: "mpstats-pop-title" },
					icon,
					React.createElement("span", null, title),
					titleValue !== undefined
						? React.createElement("span", { className: "mpstats-pop-val" }, titleValue)
						: null,
				),
				React.createElement("div", { className: "mpstats-pop-rule", "aria-hidden": true }),
				children,
			),
		),
		document.body,
	);
}

function PopRow({ label, value }: { label: string; value: string }): ReactNode {
	return React.createElement(
		"div",
		{ className: "mpstats-pop-row" },
		React.createElement("span", null, label),
		React.createElement("span", { className: "mpstats-pop-val" }, value),
	);
}

// ── 胶囊 ────────────────────────────────────────────────────────────────

interface PillShellProps {
	stat: StatId;
	icon: ReactNode;
	label: ReactNode;
	ariaLabel: string;
	open: boolean;
	onToggle(): void;
	/** false → 纯读数（span），true → 可点击（button + 弹窗）。 */
	clickable: boolean;
	anchorRef: { current: ElemLike | null };
	dialog?: ReactNode;
}

/** 一枚胶囊：可点击时是 button + 弹窗，否则只是静态读数。 */
function PillShell(props: PillShellProps): ReactNode {
	const { stat, icon, label, ariaLabel, open, onToggle, clickable, anchorRef, dialog } = props;
	const inner = [icon, React.createElement("span", { className: "mpstats-pill-label", key: "l" }, label)];
	if (!clickable) {
		return React.createElement(
			"span",
			{ className: "mpstats-pill", "data-composer-stat": stat, key: stat },
			...inner,
		);
	}
	return React.createElement(
		"span",
		{ className: "mpstats-anchor", ref: anchorRef, "data-composer-stat": stat, key: stat },
		React.createElement(
			"button",
			{
				type: "button",
				className: open ? "mpstats-pill mpstats-pill--open" : "mpstats-pill",
				"aria-haspopup": "dialog",
				"aria-expanded": open,
				"aria-label": ariaLabel,
				onClick: onToggle,
			},
			...inner,
		),
		dialog ?? null,
	);
}

/** 活动胶囊：轮次/步数 + 解码速度；弹窗列耗时分解。 */
function ActivityPill(props: {
	stats: WindowStatsView;
	compact: boolean;
	open: boolean;
	onToggle(): void;
	anchorRef: { current: ElemLike | null };
}): ReactNode {
	const { stats, compact, open, onToggle, anchorRef } = props;
	const speed = formatSpeed(stats);
	const icon = React.createElement(GaugeIcon);
	if (compact) {
		return speed === null
			? null
			: React.createElement(
					"span",
					{ className: "mpstats-pill", "data-composer-stat": "activity", key: "activity" },
					icon,
					React.createElement("span", { className: "mpstats-pill-label" }, speed),
				);
	}
	const counts = `${stats.turns} 轮 · ${stats.steps} 步`;
	const label = React.createElement(
		React.Fragment,
		null,
		counts,
		speed !== null
			? React.createElement("span", { className: "mpstats-pill-sep", "aria-hidden": true, key: "s" }, "·")
			: null,
		speed !== null ? React.createElement("span", { key: "v" }, speed) : null,
	);
	// A window without one timed figure has no dialog rows to show, so the
	// pill stays a plain reading instead of a button opening an empty dialog.
	const clickable = hasAnyTiming(stats);
	const rows: ReactNode[] = [];
	if (stats.llmMs > 0)
		rows.push(React.createElement(PopRow, { label: "模型耗时", value: formatDuration(stats.llmMs), key: "llm" }));
	if (stats.toolMs > 0)
		rows.push(React.createElement(PopRow, { label: "工具耗时", value: formatDuration(stats.toolMs), key: "tool" }));
	if (stats.ttftSteps > 0)
		rows.push(
			React.createElement(PopRow, {
				label: "平均首字",
				value: formatDuration(stats.ttftMs / stats.ttftSteps),
				key: "ttft",
			}),
		);
	if (speed !== null) rows.push(React.createElement(PopRow, { label: "速度", value: speed, key: "speed" }));
	return React.createElement(PillShell, {
		stat: "activity",
		icon,
		label,
		ariaLabel: speed === null ? counts : `${counts} · ${speed}`,
		open,
		onToggle,
		clickable,
		anchorRef,
		dialog: clickable
			? React.createElement(Popover, { open, onClose: onToggle, anchorRef, title: counts, icon }, ...rows)
			: null,
	});
}

/** 用量胶囊：token 总量 + 缓存命中率；弹窗按账单桶拆分。 */
function UsagePill(props: {
	usage: UsageView;
	compact: boolean;
	open: boolean;
	onToggle(): void;
	anchorRef: { current: ElemLike | null };
}): ReactNode {
	const { usage, compact, open, onToggle, anchorRef } = props;
	const icon = React.createElement(DatabaseIcon);
	const hit = usage.cacheHitRate;
	const hitText = hit !== null ? `缓存命中 ${formatHitRate(hit)}%` : null;
	if (compact) {
		return hitText === null
			? null
			: React.createElement(
					"span",
					{ className: "mpstats-pill", "data-composer-stat": "usage", key: "usage" },
					icon,
					React.createElement("span", { className: "mpstats-pill-label" }, hitText),
				);
	}
	const total = billedTotalTokens(usage);
	const totalText = `${formatTokens(total)} tokens`;
	const label = React.createElement(
		React.Fragment,
		null,
		totalText,
		hitText !== null
			? React.createElement("span", { className: "mpstats-pill-sep", "aria-hidden": true, key: "s" }, "·")
			: null,
		hitText !== null ? React.createElement("span", { key: "v" }, hitText) : null,
	);
	const rows: ReactNode[] = [];
	if (hit !== null)
		rows.push(React.createElement(PopRow, { label: "缓存命中率", value: `${formatHitRate(hit)}%`, key: "hit" }));
	if (usage.input > usage.cacheRead)
		rows.push(
			React.createElement(PopRow, {
				label: "未缓存输入",
				value: formatTokens(usage.input - usage.cacheRead),
				key: "uncached",
			}),
		);
	rows.push(React.createElement(PopRow, { label: "输入", value: formatTokens(usage.input), key: "input" }));
	rows.push(React.createElement(PopRow, { label: "缓存读", value: formatTokens(usage.cacheRead), key: "read" }));
	if (usage.cacheWrite !== 0)
		rows.push(React.createElement(PopRow, { label: "缓存写", value: formatTokens(usage.cacheWrite), key: "write" }));
	rows.push(React.createElement(PopRow, { label: "输出", value: formatTokens(usage.output), key: "output" }));
	if (usage.cost > 0)
		rows.push(React.createElement(PopRow, { label: "花费", value: formatSpend(usage.cost), key: "cost" }));
	return React.createElement(PillShell, {
		stat: "usage",
		icon,
		label,
		ariaLabel: hitText === null ? totalText : `${totalText} · ${hitText}`,
		open,
		onToggle,
		clickable: true,
		anchorRef,
		dialog: React.createElement(
			Popover,
			{ open, onClose: onToggle, anchorRef, title: totalText, titleValue: String(total), icon },
			...rows,
		),
	});
}

// ── 行 ──────────────────────────────────────────────────────────────────

export default function StatsRow(props: SlotProps): ReactNode {
	const { rpc, sessionId } = props;
	const mode = React.useSyncExternalStore(subscribeStatsMode, readStatsMode, () => "detailed" as StatsMode);
	const [readings, setReadings] = React.useState<{
		sessionId: string | null;
		usage: UsageView | null;
		windowStats: WindowStatsView | null;
	}>({ sessionId: null, usage: null, windowStats: null });
	// 同一行最多开一个弹窗（Escape/外部点按关闭，互不叠放）。
	const [openStat, setOpenStat] = React.useState<StatId | null>(null);
	const activityAnchor = React.useRef<ElemLike | null>(null);
	const usageAnchor = React.useRef<ElemLike | null>(null);
	const currentSessionId = sessionId ?? null;
	const usage = readings.sessionId === currentSessionId ? readings.usage : null;
	const windowStats = readings.sessionId === currentSessionId ? readings.windowStats : null;
	const empty = React.createElement("span", { className: "mpstats-empty", "aria-hidden": true }, "—");

	React.useEffect(() => {
		setReadings(current =>
			current.sessionId === currentSessionId
				? current
				: { sessionId: currentSessionId, usage: null, windowStats: null },
		);
		setOpenStat(null);
		if (!rpc || !sessionId) return;
		let alive = true;
		const poll = (): void => {
			void rpc
				.request<ContextUsageResponse | null>("session.contextUsage", { sessionId })
				.then(row => {
					if (!alive || row === null) return;
					setReadings({
						sessionId,
						usage: row.usage ?? null,
						windowStats: row.windowStats ?? null,
					});
				})
				.catch(() => {
					// A transient read failure must not erase the last good readings.
				});
		};
		poll();
		const timer = setInterval(poll, POLL_INTERVAL_MS);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [rpc, currentSessionId, sessionId]);

	if (mode === "compact") {
		// Compact = plain readings only (speed + cache hit); no popovers.
		const speed = windowStats ? formatSpeed(windowStats) : null;
		const hit = usage !== null && hasTokenActivity(usage) && usage.cacheHitRate !== null ? usage.cacheHitRate : null;
		return React.createElement(
			"div",
			{ className: "mpstats-row", "data-composer-stats": "" },
			windowStats
				? React.createElement(ActivityPill, {
						stats: windowStats,
						compact: true,
						open: false,
						onToggle: () => {},
						anchorRef: activityAnchor,
					})
				: null,
			hit !== null && usage
				? React.createElement(UsagePill, {
						usage,
						compact: true,
						open: false,
						onToggle: () => {},
						anchorRef: usageAnchor,
					})
				: null,
			speed === null && hit === null ? empty : null,
		);
	}
	const stats = windowStats;
	const showActivity = stats !== null && stats.steps > 0;
	const showUsage = hasTokenActivity(usage);
	const toggle = (id: StatId) => (): void => {
		setOpenStat(prev => (prev === id ? null : id));
	};
	return React.createElement(
		"div",
		{ className: "mpstats-row", "data-composer-stats": "" },
		showActivity && stats
			? React.createElement(ActivityPill, {
					stats,
					compact: false,
					open: openStat === "activity",
					onToggle: toggle("activity"),
					anchorRef: activityAnchor,
				})
			: null,
		showUsage && usage
			? React.createElement(UsagePill, {
					usage,
					compact: false,
					open: openStat === "usage",
					onToggle: toggle("usage"),
					anchorRef: usageAnchor,
				})
			: null,
		!showActivity && !showUsage ? empty : null,
	);
}
