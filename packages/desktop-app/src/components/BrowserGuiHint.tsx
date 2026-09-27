import { t } from "@musepi/client-core";
import { type ReactNode, useEffect, useRef, useState } from "react";

/**
 * 受管浏览器引导（`browser.gui`）。
 *
 * 触发时机：**首次打开浏览器面板**就提示——不必等 agent 真的跑了一次
 * 浏览器（那是旧行为，用户先看到的是一段「有活动但没有页面」的空窗）。
 * agent 已经在用浏览器时同样提示，那是显式关掉受管浏览器的用户唯一的
 * 信号来源。两种触发共用一次检查：`browser.gui !== true` 才弹。
 *
 * 设置每次 browser 工具调用都会重读（tools/browser.ts），所以这里启用后
 * 立即生效,不用重启。
 *
 * Dismissal tiers:
 *  - 「不再提示」 → localStorage flag (permanent)
 *  - × / outside click → this session only
 */
const HINT_SKIP_KEY = "musepi-browser-gui-hint-skip";

export function BrowserGuiHint({
	activeTools,
	browserPanelOpen,
	rpc,
	onView,
	onExpandPanel,
}: {
	activeTools: ReadonlyMap<string, { toolName: string }> | undefined;
	/** 浏览器面板是当前面板 tab（提前触发的判据）。 */
	browserPanelOpen: boolean;
	rpc: import("../lib/rpc").RpcClient;
	/** Switch the right rail to the browser surface. */
	onView(): void;
	/** Expand the ContextPanel if folded. */
	onExpandPanel?(): void;
}): ReactNode {
	const [visible, setVisible] = useState(false);
	const checkedRef = useRef(false);
	const browserActive = [...(activeTools?.values() ?? [])].some(x => x.toolName === "browser");
	const armed = browserPanelOpen || browserActive;

	useEffect(() => {
		if (!armed || checkedRef.current) return;
		checkedRef.current = true;
		try {
			if (localStorage.getItem(HINT_SKIP_KEY) === "1") return;
		} catch {
			// localStorage unavailable — still ask once per session
		}
		void rpc
			.request<{ [k: string]: unknown }>("settings.get", { keys: ["browser.gui"] })
			.then(res => {
				if (res["browser.gui"] !== true) setVisible(true);
			})
			.catch(() => {});
	}, [armed, rpc]);

	if (!visible) return null;

	const enableAndWatch = (): void => {
		void rpc
			.request("settings.set", { key: "browser.gui", value: true })
			.catch(() => {})
			.finally(() => {
				// Surface the browser pane either way — if the set failed the
				// settings page is the recovery path, not a stuck toast.
				onView();
				onExpandPanel?.();
				setVisible(false);
			});
	};
	const neverAsk = (): void => {
		try {
			localStorage.setItem(HINT_SKIP_KEY, "1");
		} catch {
			// ignore — dismissal still applies for this session
		}
		setVisible(false);
	};

	return (
		<div className="gui-update-toast" role="status" data-testid="browser-gui-hint">
			<div className="gui-update-toast-head">
				<span className="gui-update-toast-title">{t("watch the agent's browser live")}</span>
				<button
					type="button"
					className="gui-update-toast-close"
					onClick={() => setVisible(false)}
					aria-label={t("close")}
				>
					×
				</button>
			</div>
			<div className="gui-update-toast-notes">
				{t(
					"with the managed browser on, pages the agent opens show up in the side panel and share its login state",
				)}
			</div>
			<div className="gui-update-toast-actions">
				<button type="button" className="gui-btn gui-btn-primary" onClick={enableAndWatch}>
					{t("enable & watch")}
				</button>
				<button type="button" className="gui-btn" onClick={neverAsk}>
					{t("don't ask again")}
				</button>
			</div>
		</div>
	);
}
