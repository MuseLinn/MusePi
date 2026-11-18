/**
 * 用量胶囊（`conversation.composer.dock`，entry id `usage`）。
 *
 * token 总量 + 缓存命中率；详细模式点开按账单桶拆分。与 `activity-pill.tsx`
 * 是同一个 list 座位上的两条独立条目，可以按 id 单独替换或新增。
 */

import "./stats-pills.css";
import { type ElemLike, hasTokenActivity, UsagePill, useStatsMode, useStatsReadings } from "./stats-shared";

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

export default function UsageDockPill(props: Props) {
	const { rpc, sessionId } = props;
	const mode = useStatsMode();
	const { usage } = useStatsReadings(rpc, sessionId);
	const [open, setOpen] = React.useState(false);
	const anchorRef = React.useRef<ElemLike | null>(null);

	React.useEffect(() => {
		setOpen(false);
	}, [sessionId]);

	const toggle = (): void => setOpen(prev => !prev);

	if (!hasTokenActivity(usage) || usage === null) return null;

	if (mode === "compact") {
		if (usage.cacheHitRate === null) return null;
		return React.createElement(UsagePill, {
			usage,
			compact: true,
			open: false,
			onToggle: () => {},
			anchorRef,
		});
	}

	return React.createElement(UsagePill, {
		usage,
		compact: false,
		open,
		onToggle: toggle,
		anchorRef,
	});
}
