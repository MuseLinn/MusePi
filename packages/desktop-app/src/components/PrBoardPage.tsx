/**
 * PrBoardPage — the main-view surface for the PR/issue center (sidebar
 * 「问题与拉取请求」entry). A full page over the chat column: page header
 * with the back-to-workspace action, then the shared PrCenter body. The
 * app keeps the chat surface mounted underneath (display:none), so leaving
 * the page restores the session view without a re-mount.
 */
import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import type { RpcClient } from "../lib/rpc";
import { Icon } from "../vendor/oc-icons";
import { PrCenter } from "./pr-center";

export function PrBoardPage({
	rpc,
	cwd,
	onBack,
}: {
	rpc: RpcClient | null;
	cwd: string | undefined;
	onBack(): void;
}): ReactNode {
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex items-center justify-between gap-2 px-4 pb-2 pt-3">
				<div className="flex min-w-0 items-center gap-2">
					<Icon name="git-pull-request" className="h-4 w-4 flex-shrink-0 text-[var(--color-text-muted)]" />
					<span className="gui-prboard-title">{t("pr board")}</span>
				</div>
				<button type="button" className="gui-btn" onClick={onBack}>
					{t("settings.backWorkspace")}
				</button>
			</div>
			<div className="gui-prboard-body min-h-0 flex-1 px-4 pb-4">
				{rpc && cwd ? (
					<PrCenter rpc={rpc} cwd={cwd} />
				) : (
					<div className="px-2 py-5 text-[12.5px] text-[var(--color-text-faint)]">{t("settings.loading2")}</div>
				)}
			</div>
		</div>
	);
}
