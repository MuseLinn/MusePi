import { t } from "@musepi/desktop-web";
import type { SessionState } from "@musepi/pi-wire";
import { type ReactNode, useEffect, useState } from "react";
import type { RpcClient } from "../lib/rpc";

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

/**
 * Configurable informational status bar (TUI status-line parity, GUI form):
 * model / goal-plan mode / context-window tokens. Renders only when the
 * settings toggle is on. Data sources are the same ones the composer
 * already polls — no new RPC surface.
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
	const [usage, setUsage] = useState<{ tokens: number; contextWindow: number | null } | null>(null);

	useEffect(() => {
		const onStorage = (): void => setEnabled(statusBarEnabled());
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, []);

	useEffect(() => {
		if (!enabled || !rpc) return;
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
	}, [enabled, rpc, sessionId]);

	if (!enabled) return null;

	const model = state?.model ? `${state.model.provider}/${state.model.id}` : null;
	const mode = state?.goalMode?.enabled ? t("goal") : state?.planMode ? t("plan") : null;
	const tokens = usage?.tokens ? fmtTokens(usage.tokens) : null;
	const windowSize = usage?.contextWindow ? fmtTokens(usage.contextWindow) : null;

	return (
		<div className="gui-statusbar-info" role="status">
			{model && (
				<span className="gui-statusbar-info-seg" title={t("current model")}>
					{model}
				</span>
			)}
			{mode && (
				<span className="gui-statusbar-info-seg" title={t("goal")}>
					{mode}
				</span>
			)}
			{(tokens || windowSize) && (
				<span className="gui-statusbar-info-seg" title={t("context window usage")}>
					{tokens ?? "0"} / {windowSize ?? "?"}
				</span>
			)}
		</div>
	);
}
