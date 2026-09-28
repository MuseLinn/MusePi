import { type TranslationKey, t } from "@musepi/client-core";
import { useEffect, useState } from "react";
import type { RpcClient } from "../../lib/rpc";

/**
 * 设计体系数据源（M3.7b，docs/review/0.5.0-m3-mode-page-redesign.md §3）——
 * `design.systems.list` RPC（session-less，builtin + extension 合并视图）
 * 的 GUI 侧消费。会话 composer 的风格胶囊与欢迎页预览 rail 共用本
 * hook，保证两处选中态同源（各自面内一次拉取，列表是宿主级只读视图，
 * 重复调用幂等且廉价）。
 *
 * 降级：RPC 不可用（daemon 离线/旧版本不认识该方法）时回退
 * `FALLBACK_DESIGN_SYSTEMS`——内置五套的本地静态镜像（字段照抄 daemon
 * `presets/design-systems.ts` 的 BUILTIN_DESIGN_SYSTEMS，id 稳定），
 * 保证离线可用；扩展注册的体系离线时不可见（与 media providers 设置
 * 页同一降级口径）。
 */

/** `design.systems.list` 单条目的 GUI 消费面（promptSection/templates 预览面不用）。 */
export interface DesignSystemEntry {
	id: string;
	label: string;
	description: string;
	/** 调色板色卡（hex，≤6 色）——预览 rail / hover 卡渲染用。 */
	swatches: readonly string[];
	/** gui token 覆盖片段——hover 卡迷你 mock 渲染用。 */
	tokens: Record<string, string>;
	source: "builtin" | "extension";
}

/** 内置五 id → i18n labelKey（词表 composer 域；扩展体系直接用 RPC label）。 */
const BUILTIN_LABEL_KEYS: Record<string, TranslationKey> = {
	minimal: "design style minimal",
	glass: "design style glass",
	editorial: "design style editorial",
	neubrutalism: "design style neubrutalism",
	darkneon: "design style darkneon",
};

/** 展示名：内置五套走 i18n 词表（跟随界面语言），扩展用 RPC 原样 label。 */
export function designSystemLabel(entry: Pick<DesignSystemEntry, "id" | "label">): string {
	const key = BUILTIN_LABEL_KEYS[entry.id];
	return key ? t(key) : entry.label;
}

/**
 * 内置五套静态镜像（RPC 降级的本地数据面）。字段与 daemon
 * `presets/design-systems.ts` 保持一致；该文件是唯一事实源，这里的
 * 镜像只服务离线兜底，漂移以 daemon 为准（恢复连线后下一次拉取覆盖）。
 */
export const FALLBACK_DESIGN_SYSTEMS: readonly DesignSystemEntry[] = [
	{
		id: "minimal",
		label: "极简留白",
		description: "Neutral Minimal — 中性灰阶、大留白、发丝线分隔，小圆角，信息密度让位于呼吸感。",
		swatches: ["#1c1c1f", "#2a2a2e", "#6b6b70", "#8a8a90", "#d4d4d8", "#f5f5f6"],
		tokens: {
			"--bg": "oklch(0.98 0.004 60)",
			"--bg-raised": "oklch(1 0 0)",
			"--fg": "oklch(0.25 0.01 60)",
			"--fg-muted": "oklch(0.5 0.01 60)",
			"--border": "oklch(0 0 0 / 8%)",
			"--radius": "6px",
		},
		source: "builtin",
	},
	{
		id: "glass",
		label: "玻璃拟态",
		description: "Glassmorphism — 半透明玻璃面、模糊 backdrop、高光内缘与对角泽面，层次靠材质通透感。",
		swatches: ["#0f172a", "#334155", "#94a3b8", "#e2e8f0", "#f8fafc", "#38bdf8"],
		tokens: {
			"--glass-bg": "oklch(1 0 0 / 7%)",
			"--glass-bg-strong": "oklch(1 0 0 / 11%)",
			"--glass-border": "oklch(1 0 0 / 15%)",
			"--blur-3xl": "24px",
			"--radius-2xl": "16px",
		},
		source: "builtin",
	},
	{
		id: "editorial",
		label: "编辑杂志",
		description: "Editorial — 衬线标题、强字阶对比、分栏与引文排版，像纸质杂志的页面节奏。",
		swatches: ["#18181b", "#3f3f46", "#a1a1aa", "#e4e4e7", "#fafaf9", "#b45309"],
		tokens: {
			"--font-ui": "Georgia, 'Times New Roman', serif",
			"--fg": "oklch(0.2 0.01 60)",
			"--border": "oklch(0 0 0 / 12%)",
			"--radius": "2px",
		},
		source: "builtin",
	},
	{
		id: "neubrutalism",
		label: "新粗野",
		description: "Neubrutalism — 硬黑粗边框、平涂高饱和色块、硬投影、无渐变， raw 而直接的图形语言。",
		swatches: ["#ffdc58", "#ff6b6b", "#4ecdc4", "#1a1a1a", "#f7f7f7", "#7c5cff"],
		tokens: {
			"--border": "2px solid #1a1a1a",
			"--radius-xs": "0px",
			"--bg": "#f7f7f7",
			"--fg": "#1a1a1a",
		},
		source: "builtin",
	},
	{
		id: "darkneon",
		label: "暗黑霓虹",
		description: "Dark Neon — 深黑底 + 霓虹 accent 发光，高对比暗黑界面，光影来自辉光而非材质。",
		swatches: ["#05060a", "#0d1017", "#22d3ee", "#a3e635", "#e879f9", "#f8fafc"],
		tokens: {
			"--bg": "oklch(0.155 0.008 60)",
			"--bg-inset": "oklch(0.125 0.007 60)",
			"--accent": "oklch(0.83 0.15 195)",
			"--accent-muted": "oklch(0.83 0.15 195 / 18%)",
			"--fg": "oklch(0.95 0.01 240)",
		},
		source: "builtin",
	},
];

/** 拉取设计体系列表；失败静默回退内置静态镜像（离线可用）。
 *  扩展加载面变更（extensions.changed 广播：HMR / 扩展启停 / 装包）后
 *  重拉——chat 面常驻挂载（display:none 不卸载），装完设计体系包从能力
 *  中心返回时靠本事件即见新体系，而不是等下一次重挂（M3.7d 即见链路）。 */
export function useDesignSystems(rpc: RpcClient | null): DesignSystemEntry[] {
	const [systems, setSystems] = useState<DesignSystemEntry[]>([...FALLBACK_DESIGN_SYSTEMS]);
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		const pull = (): void => {
			void rpc
				.request<{ systems: DesignSystemEntry[] }>("design.systems.list", {})
				.then(res => {
					if (alive && Array.isArray(res?.systems) && res.systems.length > 0) {
						setSystems(res.systems);
					}
				})
				.catch(() => {
					// RPC 不可用（daemon 离线/旧版）：保留内置静态镜像。
				});
		};
		pull();
		const unlisten = rpc.addEventListener(event => {
			const payload = event.payload as { type?: string } | undefined;
			if (payload?.type === "extensions.changed") pull();
		});
		return () => {
			alive = false;
			unlisten();
		};
	}, [rpc]);
	return systems;
}
