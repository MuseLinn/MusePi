import { t } from "@musepi/desktop-web";
import { type ReactNode, useEffect, useRef, useState } from "react";

/**
 * First-browser-use hint (user-friendliness gap): `browser.gui` defaults to
 * false, so the agent's first browser tool call runs an INVISIBLE headless
 * Chromium — the user sees activity but no pages. When that first call
 * happens, offer a one-click switch to the managed in-app browser (live view
 * in the right panel + shared login state). The setting is re-read on every
 * browser tool invocation (tools/browser.ts), so enabling here takes effect
 * immediately — no restart.
 *
 * Dismissal tiers:
 *  - 「不再提示」 → localStorage flag (permanent)
 *  - × / outside click → this session only
 */
const HINT_SKIP_KEY = "musepi-browser-gui-hint-skip";

export function BrowserGuiHint({
	activeTools,
	rpc,
	onView,
	onExpandPanel,
}: {
	activeTools: ReadonlyMap<string, { toolName: string }> | undefined;
	rpc: import("../lib/rpc").RpcClient;
	/** Switch the right rail to the browser surface. */
	onView(): void;
	/** Expand the ContextPanel if folded. */
	onExpandPanel?(): void;
}): ReactNode {
	const [visible, setVisible] = useState(false);
	const checkedRef = useRef(false);
	const browserActive = [...(activeTools?.values() ?? [])].some(x => x.toolName === "browser");

	useEffect(() => {
		if (!browserActive || checkedRef.current) return;
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
	}, [browserActive, rpc]);

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
				<button type="button" className="gui-update-toast-close" onClick={() => setVisible(false)} aria-label={t("close")}>
					×
				</button>
			</div>
			<div className="gui-update-toast-notes">
				{t("the agent is using its own hidden browser — enable the managed browser to watch it in the side panel and share login state")}
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
