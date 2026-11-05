import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useMemo, useRef, useState } from "react";
import type { RpcClient } from "../lib/rpc";
import { type ExtensionItem, useExtensionRegistry } from "../lib/slot-host";
import { useFloatingMenu } from "../lib/use-floating-menu";
import { Icon } from "../vendor/oc-icons";

/**
 * 运行中的 MusePi 插件(extension-module)状态读数:一个触发器加一层逐个扩展的
 * 运行/禁用明细。数据源共享单例 useExtensionRegistry(10s 轮询 + extensions.changed
 * 即时刷新),两个座位拿到的是同一份读数与同一个浮层。
 *
 * - `chip`(默认):composer 风格的玻璃胶囊,供独立入口使用;
 * - `inline`:会话信息卡「插件」分区上方的状态条,一行给出一眼可读的运行数,
 *   不改变分区自己的计数/折叠结构。
 *
 * 浮窗走 useFloatingMenu(全局唯一浮层实现):此前是组件内 `absolute bottom-full`
 * 的盒子,而会话 composer 恒为 `hero`,其外层 BorderBeam 的
 * `[data-beam] { overflow: hidden }`(vendor/border-beam/styles.ts)把向上展开的
 * 菜单裁在输入卡上边缘 —— 3 个以上扩展就超出卡高,列表被切掉(用户报告 2026-10-18)。
 * 该 hook portal 到 React root,按"下方够不够"自动向上翻转,不再受任何祖先裁剪。
 */
export function ExtensionStatusCard({
	rpc,
	variant = "chip",
	extensions,
}: {
	rpc: RpcClient | null;
	/** 容器形态。`inline` 只换触发器的外观,浮层与明细保持不变。 */
	variant?: "chip" | "inline";
	/** 宿主已订阅注册表时下发的同形条目;给了就不再在组件内开第二个订阅,
	 *  避免同一棵树里两个消费者只收到一次通知而读数分叉。 */
	extensions?: readonly ExtensionItem[];
}): ReactNode {
	const data = useExtensionRegistry(extensions ? null : rpc);
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement | null>(null);

	const items = useMemo(
		() =>
			(extensions ?? data?.extensions ?? []).filter(
				e => e.kind === "plugin-module" || e.kind === "extension-module",
			),
		[extensions, data],
	);
	const running = items.filter(e => e.state === "active").length;

	// Declared before the early return below: hook order must not depend on
	// whether any extension happens to be running.
	const { renderMenu } = useFloatingMenu(open, setOpen, {
		className: "gui-ext-status-menu",
		anchor: triggerRef.current,
	});

	if (items.length === 0 || running === 0) return null;

	const label = t("settings.extensionsRunning", { count: String(running) });
	const menu = renderMenu(
		<div role="menu" aria-orientation="vertical">
			{items.map(ext => {
				const name = ext.displayName || ext.name || ext.id;
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
							{ext.state === "active"
								? t("settings.extensionsStateRunning")
								: t("settings.extensionsStateDisabled")}
						</span>
					</div>
				);
			})}
		</div>,
	);

	if (variant === "inline") {
		return (
			<>
				<button
					ref={triggerRef}
					type="button"
					className="gui-session-info-plugin-status"
					title={label}
					aria-haspopup="menu"
					aria-expanded={open}
					onClick={() => setOpen(v => !v)}
				>
					<Icon name="pulse" className="gui-session-info-row-icon gui-session-info-plugin-status-icon" />
					<span className="gui-session-info-item-label">{label}</span>
					<Icon
						name="arrow-down-s"
						className={`gui-session-info-chev${open ? "" : " gui-session-info-chev--closed"}`}
					/>
				</button>
				{menu}
			</>
		);
	}

	return (
		<div className="relative z-20 flex-shrink-0">
			<button
				ref={triggerRef}
				type="button"
				className="gui-mode-chip"
				title={label}
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen(v => !v)}
			>
				<Icon name="plug" className="h-3 w-3" />
				<span className="max-w-[168px] truncate">{label}</span>
			</button>
			{menu}
		</div>
	);
}
