import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { tapFeedback } from "../../lib/haptic";
import type { RpcClient } from "../../lib/rpc";
import { useExtensionRegistry } from "../../lib/slot-host";
import type { McpItem } from "./shared";

/** Settings → 智能体 → MCP 服务器: mcp-kind extensions with enable toggles
 * (extensions.list / extensions.setEnabled — the mcp.json denylist path).
 * Data comes from the shared registry singleton. */
export function McpSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const data = useExtensionRegistry(rpc);
	const mcps = useMemo(() => (data?.extensions ?? []).filter(e => e.kind === "mcp"), [data]);
	const toggle = (e: McpItem, next: boolean): void => {
		// daemon 广播 extensions.changed → 单例重拉,不本地乐观更新。
		void rpc?.request("extensions.setEnabled", { id: e.id, enabled: next });
	};
	return (
		<>
			<h2 className="gui-settings-page-title">{t("mcp servers")}</h2>
			<p className="gui-settings-page-desc">{t("mcp settings")}</p>
			{mcps.length === 0 ? (
				<div className="gui-settings-row">{t("no mcp servers")}</div>
			) : (
				mcps.map(m => (
					<div key={m.id} className="gui-agent-card">
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-1.5">
								<span className="truncate text-[13px] font-medium">{m.displayName || m.name}</span>
								<span className="gui-provider-chip">MCP</span>
							</div>
							{m.description && (
								<div className="truncate text-[12px] text-[var(--color-text-muted)]">{m.description}</div>
							)}
						</div>
						<button
							type="button"
							role="switch"
							aria-checked={m.state === "active"}
							className={`gui-toggle${m.state === "active" ? " gui-toggle--on" : ""}`}
							onClick={() => {
								tapFeedback();
								toggle(m, m.state !== "active");
							}}
						/>
					</div>
				))
			)}
		</>
	);
}
