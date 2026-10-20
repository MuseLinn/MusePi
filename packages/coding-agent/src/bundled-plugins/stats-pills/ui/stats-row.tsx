/**
 * 性能与用量读数（slot: `composer.dock`）— 插件自己的组件。
 *
 * 数据全部来自宿主的 `session.contextUsage`：token 用量、花费、缓存命中率。
 * 插件不复制统计逻辑，只把它画成一行。
 *
 * 显示规则（与宿主原来的读数行一致，避免用户升级后看到不一样的数字）：
 *
 * - **简洁模式**：只显示速度与缓存命中率两枚小胶囊；
 * - **详细模式**：先显示耗时/轮次，再显示 token 用量与花费；
 * - **没有任何活动时整行不渲染**——空读数行只是噪音。
 *
 * 简洁/详细偏好存在 localStorage，与设置页的那一行共用同一个键，所以在哪边
 * 改都同帧生效。
 */

declare const React: {
	createElement: (
		type: unknown,
		props?: Record<string, unknown>,
		...children: unknown[]
	) => unknown;
	useEffect: (fn: () => void | (() => void), deps?: unknown[]) => void;
	useState: <T>(initial: T) => [T, (v: T | ((prev: T) => T)) => void];
	useSyncExternalStore: <T>(subscribe: (cb: () => void) => () => void, get: () => T, getServer: () => T) => T;
};

// The host compiles this file for the renderer, but it type-checks inside the
// daemon's project (no DOM lib). Declare just the platform surface it uses.
declare const window: {
	addEventListener(type: string, cb: () => void): void;
	removeEventListener(type: string, cb: () => void): void;
};
declare const localStorage: {
	getItem(key: string): string | null;
};

type ReactNode = unknown;
type StatsMode = "detailed" | "compact";

/** One `session.contextUsage` row, as the daemon sends it. */
interface ContextUsageView {
	tokens?: number;
	contextWindow?: number;
	percent?: number;
	model?: string | null;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: number;
		cacheHitRate?: number | null;
	} | null;
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

/** Compact token count ("1.2M", "34.5K", "812"). */
function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(Math.round(n));
}

/** USD with sub-cent precision kept visible — session totals are small. */
function formatSpend(cost: number): string {
	if (cost >= 1) return `$${cost.toFixed(2)}`;
	if (cost >= 0.01) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(4)}`;
}

const pillStyle: Record<string, unknown> = {
	display: "inline-flex",
	alignItems: "center",
	gap: "4px",
	padding: "1px 7px",
	borderRadius: "999px",
	fontSize: "11px",
	lineHeight: 1.5,
	fontVariantNumeric: "tabular-nums",
	color: "var(--color-text-faint)",
	background: "var(--color-surface-raised, rgba(127,127,127,0.08))",
};
const rowStyle: Record<string, unknown> = {
	display: "flex",
	alignItems: "center",
	gap: "6px",
	flexWrap: "wrap",
	padding: "2px 0",
};

export default function StatsRow(props: SlotProps): ReactNode {
	const { rpc, sessionId } = props;
	const mode = React.useSyncExternalStore(subscribeStatsMode, readStatsMode, () => "detailed" as StatsMode);
	const [usage, setUsage] = React.useState<ContextUsageView["usage"] | null>(null);

	React.useEffect(() => {
		if (!rpc || !sessionId) return;
		let alive = true;
		const poll = (): void => {
			void rpc
				.request<ContextUsageView | null>("session.contextUsage", { sessionId })
				.then(row => {
					if (alive) setUsage(row?.usage ?? null);
				})
				.catch(() => {
					// 读数缺失只是不显示，不是错误。
					if (alive) setUsage(null);
				});
		};
		poll();
		const timer = setInterval(poll, POLL_INTERVAL_MS);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [rpc, sessionId]);

	if (!usage) return null;
	const total = usage.totalTokens ?? 0;
	const hitRate = usage.cacheHitRate ?? null;
	// Nothing measured yet: an all-zero reading row is pure noise.
	if (total === 0 && hitRate === null) return null;

	if (mode === "compact") {
		return React.createElement(
			"div",
			{ style: rowStyle, "data-composer-stats": "" },
			hitRate !== null
				? React.createElement("span", { style: pillStyle, key: "c" }, `缓存命中 ${hitRate}%`)
				: null,
		);
	}

	const pills: ReactNode[] = [];
	if (total > 0) {
		// Input is shown as the billed total (input + cache write): a reader
		// comparing with the provider's console expects the same denominator.
		pills.push(
			React.createElement("span", { style: pillStyle, key: "t" }, `${formatTokens(total)} tokens`),
		);
		if (typeof usage.cost === "number" && usage.cost > 0) {
			pills.push(React.createElement("span", { style: pillStyle, key: "s" }, formatSpend(usage.cost)));
		}
		if (hitRate !== null) {
			pills.push(React.createElement("span", { style: pillStyle, key: "h" }, `缓存命中 ${hitRate}%`));
		}
	}
	if (pills.length === 0) return null;
	return React.createElement("div", { style: rowStyle, "data-composer-stats": "" }, ...pills);
}
