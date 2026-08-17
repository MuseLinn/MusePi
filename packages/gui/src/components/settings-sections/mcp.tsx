import {
	t,
} from "@musepi/desktop-web";
import type {
	ReactNode,
} from "react";
import {
	useEffect,
	useState,
} from "react";
import {
	tapFeedback,
} from "../../lib/haptic";
import type {
	RpcClient,
} from "../../lib/rpc";
import type { McpItem } from "./shared";

/** Settings → 智能体 → MCP 服务器: mcp-kind extensions with enable toggles
 * (extensions.list / extensions.setEnabled — the mcp.json denylist path). */
export function McpSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [mcps, setMcps] = useState<McpItem[] | null>(null);
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		const load = (): void => {
			void rpc
				.request<{ extensions: McpItem[] }>("extensions.list", {})
				.then(res => {
					if (alive) setMcps((res?.extensions ?? []).filter(e => e.kind === "mcp"));
				})
				.catch(() => alive && setMcps([]));
		};
		load();
		let id = setInterval(load, 3000);
		const onVis = (): void => {
			clearInterval(id);
			if (document.visibilityState === "visible") {
				load();
				id = setInterval(load, 3000);
			}
		};
		document.addEventListener("visibilitychange", onVis);
		return () => {
			alive = false;
			clearInterval(id);
			document.removeEventListener("visibilitychange", onVis);
		};
	}, [rpc]);
	const toggle = (e: McpItem, next: boolean): void => {
		void rpc?.request("extensions.setEnabled", { id: e.id, enabled: next }).then(() => {
			setMcps(prev => prev?.map(m => (m.id === e.id ? { ...m, state: next ? "active" : "disabled" } : m)) ?? prev);
		});
	};
	return (
		<>
			<h2 className="gui-settings-page-title">{t("mcp servers")}</h2>
			<p className="gui-settings-page-desc">{t("mcp settings")}</p>
			{mcps === null ? (
				<div className="text-[13px] text-[var(--color-text-faint)]">…</div>
			) : mcps.length === 0 ? (
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
