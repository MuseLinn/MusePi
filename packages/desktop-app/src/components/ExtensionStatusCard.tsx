import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useMemo, useRef, useState } from "react";
import type { RpcClient } from "../lib/rpc";
import { useExtensionRegistry } from "../lib/slot-host";
import { useFloatingMenu } from "../lib/use-floating-menu";
import { Icon } from "../vendor/oc-icons";

/**
 * 会话扩展状态卡(DSH Cordis Plugin 卡片参考吸收):composer 顶部操作行左侧
 * 显示运行中的 MusePi 扩展(extension-module)数量,点击浮窗列出各扩展状态。
 * 数据源共享单例 useExtensionRegistry(10s 轮询 + extensions.changed 即时刷新)。
 *
 * 浮窗走 useFloatingMenu(全局唯一浮层实现):此前是组件内 `absolute bottom-full`
 * 的盒子,而会话 composer 恒为 `hero`,其外层 BorderBeam 的
 * `[data-beam] { overflow: hidden }`(vendor/border-beam/styles.ts)把向上展开的
 * 菜单裁在输入卡上边缘 —— 3 个以上扩展就超出卡高,列表被切掉(用户报告 2026-10-18)。
 * 该 hook portal 到 React root,按"下方够不够"自动向上翻转,不再受任何祖先裁剪。
 */
export function ExtensionStatusCard({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const data = useExtensionRegistry(rpc);
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement | null>(null);

	const items = useMemo(() => (data?.extensions ?? []).filter(e => e.id.startsWith("extension-module:")), [data]);
	const running = items.filter(e => e.state === "active").length;

	// Declared before the early return below: hook order must not depend on
	// whether any extension happens to be running.
	const { renderMenu } = useFloatingMenu(open, setOpen, {
		className: "gui-ext-status-menu",
		anchor: triggerRef.current,
	});

	if (items.length === 0 || running === 0) return null;

	return (
		<div className="relative z-20 flex-shrink-0">
			<button
				ref={triggerRef}
				type="button"
				className="gui-mode-chip"
				title={t("settings.extensionsRunning", { count: String(running) })}
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen(v => !v)}
			>
				<Icon name="plug" className="h-3 w-3" />
				<span className="max-w-[120px] truncate">{t("settings.extensionsRunning", { count: String(running) })}</span>
			</button>
			{renderMenu(
				<div role="menu" aria-orientation="vertical">
					{items.map(ext => {
						const name = (ext.displayName || ext.name || ext.id).replace(/^extension-module:/, "");
						return (
							<div
								key={ext.id}
								role="menuitem"
								className="gui-ext-status-row"
								// Rows are informational; the menu is a status readout, so a
								// row activates nothing. tabIndex keeps arrow-key traversal
								// meaningful for screen readers.
								tabIndex={-1}
							>
								<span
									className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
										ext.state === "active" ? "bg-[var(--color-success)]" : "bg-[var(--color-text-faint)]"
									}`}
								/>
								<span className="min-w-0 flex-1 truncate text-[12px]">{name}</span>
								<span className="text-[11px] text-[var(--color-text-faint)]">
									{ext.state === "active" ? t("settings.extensionsStateRunning") : t("settings.extensionsStateDisabled")}
								</span>
							</div>
						);
					})}
				</div>,
			)}
		</div>
	);
}
