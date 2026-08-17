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

/** Settings → 智能体 → 钩子: hook-capability extensions (pre/post tool
 * scripts) with enable toggles — same extensions.list/setEnabled path the
 * skills center and MCP tab use. */
export function HooksSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [hooks, setHooks] = useState<McpItem[] | null>(null);
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		const load = (): void => {
			void rpc
				.request<{ extensions: McpItem[] }>("extensions.list", {})
				.then(res => {
					if (alive) setHooks((res?.extensions ?? []).filter(e => e.kind === "hook"));
				})
				.catch(() => alive && setHooks([]));
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
			setHooks(prev => prev?.map(m => (m.id === e.id ? { ...m, state: next ? "active" : "disabled" } : m)) ?? prev);
		});
	};
	return (
		<>
			<h2 className="gui-settings-page-title">{t("hooks")}</h2>
			<p className="gui-settings-page-desc">{t("hooks description")}</p>
			{hooks === null ? (
				<div className="text-[13px] text-[var(--color-text-faint)]">…</div>
			) : hooks.length === 0 ? (
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
