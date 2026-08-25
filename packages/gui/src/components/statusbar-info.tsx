import { t } from "@musepi/desktop-web";
import type { SessionState } from "@musepi/pi-wire";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { RpcClient } from "../lib/rpc";
import { useExtensionRegistry } from "../lib/slot-host";

/** localStorage switch (settings → 外观 → 信息状态条). */
const STATUSBAR_KEY = "musepi-gui-statusbar-info";

export function statusBarEnabled(): boolean {
	try {
		return localStorage.getItem(STATUSBAR_KEY) === "1";
	} catch {
		return false;
	}
}

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

// ── Segment contract (plugin seam) ───────────────────────────────────────
// The status bar is a list of named segments; each segment renders a
// `{ label, title } | null` (null hides it). Built-ins live in this file;
// extensions contribute via `registerStatusBarSegment` (future
// `statusbar.seg.<id>` slot — the same registry shape the TUI status-line
// segments use, GUI form).

export interface StatusBarSegment {
	/** Unique id (`statusbar.seg.<id>` slot key). */
	id: string;
	/** Render the segment for the current session; null hides it. */
	render(ctx: StatusBarContext): { label: string; title?: string } | null;
}

export interface StatusBarContext {
	rpc: RpcClient | null;
	sessionId: string;
	state: SessionState | null;
	/** Context-window usage from the 3s poll (null before the first tick). */
	usage: { tokens: number; contextWindow: number | null } | null;
}

/** Extension-contributed segments (appended after built-ins). */
const extraSegments = new Map<string, StatusBarSegment>();

/** Register a status-bar segment (plugin seam). Returns an unregister fn. */
export function registerStatusBarSegment(segment: StatusBarSegment): () => void {
	extraSegments.set(segment.id, segment);
	return () => extraSegments.delete(segment.id);
}

const builtinSegments: StatusBarSegment[] = [
	{
		id: "statusbar.seg.model",
		render(ctx) {
			const model = ctx.state?.model;
			if (!model) return null;
			return { label: `${model.provider}/${model.id}`, title: t("current model") };
		},
	},
	{
		id: "statusbar.seg.mode",
		render(ctx) {
			const mode = ctx.state?.goalMode?.enabled ? t("goal") : ctx.state?.planMode ? t("plan") : null;
			if (!mode) return null;
			return { label: mode, title: t("goal") };
		},
	},
	{
		id: "statusbar.seg.context",
		render(ctx) {
			const { usage } = ctx;
			if (!usage) return null;
			const tokens = usage.tokens > 0 ? fmtTokens(usage.tokens) : "0";
			const windowSize = usage.contextWindow ? fmtTokens(usage.contextWindow) : "?";
			return { label: `${tokens} / ${windowSize}`, title: t("context window usage") };
		},
	},
];

/**
 * Merge built-ins + GUI-local + daemon-contributed segments. Daemon segments
 * (registerStatusBarSegment) render after the built-ins, ordered by `order`.
 */
function allSegments(daemonSegments: StatusBarSegment[]): StatusBarSegment[] {
	return [...builtinSegments, ...extraSegments.values(), ...daemonSegments];
}

/**
 * Configurable informational status bar (TUI status-line parity, GUI form):
 * model / goal-plan mode / context-window tokens, extensible via
 * `registerStatusBarSegment`. Renders only when the settings toggle is on.
 * Data sources are the same ones the composer already polls (session context
 * usage, plus the shared extension registry for daemon-contributed segments)
 * — no new RPC surface.
 */
export function SessionStatusBar({
	rpc,
	sessionId,
	state,
}: {
	rpc: RpcClient | null;
	sessionId: string;
	state: SessionState | null;
}): ReactNode {
	const [enabled, setEnabled] = useState(statusBarEnabled);

	useEffect(() => {
		const onStorage = (): void => setEnabled(statusBarEnabled());
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, []);

	if (!enabled) return null;

	return <StatusBarContent rpc={rpc} sessionId={sessionId} state={state} />;
}

/**
 * Renders the status-bar segments. Mounted only while the settings toggle is
 * on, so the shared extension registry poll is not kept alive when hidden.
 */
function StatusBarContent({
	rpc,
	sessionId,
	state,
}: {
	rpc: RpcClient | null;
	sessionId: string;
	state: SessionState | null;
}): ReactNode {
	const [usage, setUsage] = useState<{ tokens: number; contextWindow: number | null } | null>(null);

	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		const tick = (): void => {
			void rpc
				.request<{ tokens: number; contextWindow: number } | null>("session.contextUsage", { sessionId })
				.then(u => {
					if (alive && u) setUsage({ tokens: u.tokens ?? 0, contextWindow: u.contextWindow ?? null });
				})
				.catch(() => {});
		};
		tick();
		const timer = setInterval(tick, 3000);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [rpc, sessionId]);

	const registry = useExtensionRegistry(rpc);
	const daemonSegments = useMemo<StatusBarSegment[]>(() => {
		const items = registry?.statusBarSegments ?? [];
		return [...items]
			.sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER))
			.map(item => ({
				id: item.id,
				render: () => ({ label: item.label }),
			}));
	}, [registry]);

	const ctx: StatusBarContext = { rpc, sessionId, state, usage };
	const segs = allSegments(daemonSegments)
		.map(s => s.render(ctx))
		.filter((r): r is { label: string; title?: string } => r !== null);

	if (segs.length === 0) return null;

	return (
		<div className="gui-statusbar-info" role="status">
			{segs.map((seg, i) => (
				<span key={i} className="gui-statusbar-info-seg" title={seg.title}>
					{seg.label}
				</span>
			))}
		</div>
	);
}
