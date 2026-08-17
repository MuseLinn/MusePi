import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { RpcClient } from "../../lib/rpc";
import { SETTINGS_EXTENSION_SLOT, SlotComponentHost } from "../../lib/slot-components";

/** Settings → 智能体 → 插件: extensions discovered from .omp/tools,
 *  .claude/plugins etc (daemon plugins.list). */
export function PluginsSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [plugins, setPlugins] = useState<
		{ path: string; label: string | null; tools: number; commands: number; handlers: number }[] | null
	>(null);
	const [errors, setErrors] = useState<{ path: string; error: string }[]>([]);
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		const load = (): void => {
			if (document.visibilityState === "hidden") return;
			void rpc
				.request<{
					plugins: { path: string; label: string | null; tools: number; commands: number; handlers: number }[];
					errors: { path: string; error: string }[];
				} | null>("plugins.list", {})
				.then(res => {
					if (!alive) return;
					setPlugins(res?.plugins ?? []);
					setErrors(res?.errors ?? []);
				})
				.catch(() => alive && setPlugins([]));
		};
		load();
		const id = setInterval(load, 5000);
		// HMR: the daemon watcher invalidates plugins.list and pushes
		// extensions.changed — refresh immediately instead of waiting for the
		// next poll.
		const off = rpc.addEventListener(event => {
			const payload = event.payload as { type?: string } | undefined;
			if (payload?.type === "extensions.changed") load();
		});
		return () => {
			alive = false;
			clearInterval(id);
			off();
		};
	}, [rpc]);
	return (
		<>
			<h2 className="gui-settings-page-title">{t("plugins")}</h2>
			<p className="gui-settings-page-desc">{t("plugins settings")}</p>
			{plugins === null ? (
				<div className="text-[13px] text-[var(--color-text-faint)]">…</div>
			) : plugins.length === 0 ? (
				<div className="gui-settings-row">{t("no plugins loaded")}</div>
			) : (
				plugins.map(p => (
					<div key={p.path} className="gui-agent-card">
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-1.5">
								<span className="truncate text-[13px] font-medium">{p.label ?? p.path}</span>
								<span className="gui-provider-chip">{t("plugin")}</span>
							</div>
							<div className="truncate text-[12px] text-[var(--color-text-faint)]">{p.path}</div>
							<div className="mt-1 flex flex-wrap gap-x-3 text-[12px] text-[var(--color-text-muted)]">
								<span>{t("{count} tools", { count: String(p.tools) })}</span>
								<span>{t("{count} commands", { count: String(p.commands) })}</span>
								<span>{t("{count} handlers", { count: String(p.handlers) })}</span>
							</div>
						</div>
					</div>
				))
			)}
			{errors.length > 0 && (
				<>
					<h3 className="gui-settings-group-h">{t("load errors")}</h3>
					{errors.map((e, i) => (
						<div key={i} className="gui-settings-row">
							<div className="truncate text-[12px] text-[var(--color-text-muted)]">
								{e.path}: {e.error}
							</div>
						</div>
					))}
				</>
			)}
			{/* Extension-contributed UI (pi.registerComponent → settings.extensions
			 * slot): dynamically imported modules mount below the plugin list.
			 * Enabled/disabled takes effect within the 10s poll window. */}
			<SlotComponentHost rpc={rpc} slot={SETTINGS_EXTENSION_SLOT} />
		</>
	);
}
