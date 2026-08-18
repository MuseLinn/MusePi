import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { tapFeedback } from "../../lib/haptic";
import type { RpcClient } from "../../lib/rpc";
import { useExtensionRegistry } from "../../lib/slot-host";
import type { McpItem } from "./shared";

/** Settings → 智能体 → 钩子: hook-capability extensions (pre/post tool
 * scripts) with enable toggles — same extensions.list/setEnabled path the
 * skills center and MCP tab use. Data comes from the shared registry
 * singleton (10s poll + extensions.changed instant refresh). */
export function HooksSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const data = useExtensionRegistry(rpc);
	const hooks = useMemo(() => (data?.extensions ?? []).filter(e => e.kind === "hook"), [data]);
	const toggle = (e: McpItem, next: boolean): void => {
		// daemon 广播 extensions.changed → 单例重拉,不本地乐观更新。
		void rpc?.request("extensions.setEnabled", { id: e.id, enabled: next });
	};
	return (
		<>
			<h2 className="gui-settings-page-title">{t("hooks")}</h2>
			<p className="gui-settings-page-desc">{t("hooks description")}</p>
			{hooks.length === 0 ? (
				<div className="gui-settings-row">{t("no hooks")}</div>
			) : (
				hooks.map(h => (
					<div key={h.id} className="gui-agent-card">
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-1.5">
								<span className="truncate text-[13px] font-medium">{h.displayName || h.name}</span>
								<span className="gui-provider-chip">hook</span>
							</div>
							{h.description && (
								<div className="truncate text-[12px] text-[var(--color-text-muted)]">{h.description}</div>
							)}
						</div>
						<button
							type="button"
							role="switch"
							aria-checked={h.state === "active"}
							className={`gui-toggle${h.state === "active" ? " gui-toggle--on" : ""}`}
							onClick={() => {
								tapFeedback();
								toggle(h, h.state !== "active");
							}}
						/>
					</div>
				))
			)}
		</>
	);
}
