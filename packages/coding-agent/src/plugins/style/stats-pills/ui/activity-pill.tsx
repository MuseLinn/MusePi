/**
 * 活动胶囊（`conversation.composer.dock`，entry id `activity`）。
 *
 * 一个 dock 条目一枚胶囊：轮次/步数 + 解码速度，详细模式点开耗时分解。
 * 这枚条目同时负责整行的高度占位——两枚读数都没有时显示 `—`，初始加载与
 * 空会话不推动输入区。用量胶囊是同一座位上的另一条条目（`usage-pill.tsx`），
 * 可以单独被替换。
 */

import "./stats-pills.css";
import {
	ActivityPill,
	type ElemLike,
	hasTokenActivity,
	StatsEmpty,
	useStatsMode,
	useStatsReadings,
} from "./stats-shared";

declare const React: {
	createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown;
	useState: <T>(initial: T | (() => T)) => [T, (v: T | ((prev: T) => T)) => void];
	useEffect: (fn: () => void | (() => void), deps?: readonly unknown[]) => void;
	useRef: <T>(initial: T | null) => { current: T | null };
};

interface Props {
	rpc?: {
		request: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
	} | null;
	sessionId?: string | null;
}

export default function ActivityDockPill(props: Props) {
	const { rpc, sessionId } = props;
	const mode = useStatsMode();
	const { usage, windowStats } = useStatsReadings(rpc, sessionId);
	const [open, setOpen] = React.useState(false);
	const anchorRef = React.useRef<ElemLike | null>(null);

	React.useEffect(() => {
		setOpen(false);
	}, [sessionId]);

	const toggle = (): void => setOpen(prev => !prev);

	if (mode === "compact") {
		if (windowStats) {
			return React.createElement(ActivityPill, {
				stats: windowStats,
				compact: true,
				open: false,
				onToggle: () => {},
				anchorRef,
			});
		}
		return hasTokenActivity(usage) ? null : React.createElement(StatsEmpty);
	}

	const stats = windowStats;
	if (stats === null || stats.steps === 0) {
		return hasTokenActivity(usage) ? null : React.createElement(StatsEmpty);
	}
	return React.createElement(ActivityPill, {
		stats,
		compact: false,
		open,
		onToggle: toggle,
		anchorRef,
	});
}
