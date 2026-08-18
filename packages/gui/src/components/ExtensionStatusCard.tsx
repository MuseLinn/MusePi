import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import type { RpcClient } from "../lib/rpc";
import { useExtensionRegistry } from "../lib/slot-host";
import { Icon } from "../vendor/oc-icons";

/**
 * 会话扩展状态卡(DSH Cordis Plugin 卡片参考吸收):composer 顶部操作行左侧
 * 显示运行中的 MusePi 扩展(extension-module)数量,点击浮窗列出各扩展状态。
 * 数据源共享单例 useExtensionRegistry(10s 轮询 + extensions.changed 即时刷新)。
 */
export function ExtensionStatusCard({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const data = useExtensionRegistry(rpc);
	const [open, setOpen] = useState(false);

	const items = useMemo(() => (data?.extensions ?? []).filter(e => e.id.startsWith("extension-module:")), [data]);

	const running = items.filter(e => e.state === "active").length;
	if (items.length === 0 || running === 0) return null;

	return (
		<div className="relative z-20 flex-shrink-0">
			<button
				type="button"
				className="gui-mode-chip"
				title={t("extensions running", { count: String(running) })}
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen(v => !v)}
			>
				<Icon name="plug" className="h-3 w-3" />
				<span className="max-w-[120px] truncate">{t("extensions running", { count: String(running) })}</span>
			</button>
			{open ? (
				<>
					<div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
					<div className="absolute left-0 z-20 mt-1 min-w-[220px] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--color-surface)] p-1 shadow-[0_8px_32px_rgba(0,0,0,0.35)]">
						{items.map(ext => {
							const name = (ext.displayName || ext.name || ext.id).replace(/^extension-module:/, "");
							return (
								<div key={ext.id} className="flex items-center gap-2 px-2 py-1.5">
									<span
										className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
											ext.state === "active" ? "bg-[var(--color-success)]" : "bg-[var(--color-text-faint)]"
										}`}
									/>
									<span className="min-w-0 flex-1 truncate text-[12px]">{name}</span>
									<span className="text-[11px] text-[var(--color-text-faint)]">
										{ext.state === "active" ? t("extensions state running") : t("extensions state disabled")}
									</span>
								</div>
							);
						})}
					</div>
				</>
			) : null}
		</div>
	);
}
