/**
 * Design system registry (M3 §3, docs/review/0.5.0-m3-mode-page-redesign.md)。
 *
 * 能力缝声明（M2.4）：
 * - 名称+ns：design-systems（daemon 侧设计体系注册表；RPC 面经
 *   DesignSystemsService 的 `design.systems.list` 暴露；prompt 注入消费
 *   走 `applyDesignSystemSection` → PromptComposer）。
 * - 输入：内置预设表 `BUILTIN_DESIGN_SYSTEMS`（id 稳定，会话已存引用，
 *   不得改名）+ 扩展经 `pi.registerDesignSystem()` 注册的配置
 *   （kebab-case id；撞内置/撞已注册即抛）。
 * - 输出：`listDesignSystems()`（builtin + extension 合并视图，带 source
 *   徽章）、`getDesignSystem(id)` 单体查询、
 *   `applyDesignSystemSection(composer, metadata)` 把命中体系的
 *   promptSection 注入会话 composer（source=design-system，order 40 位于
 *   mode 预设区块之后；未命中/空 id 不注入不炸）。
 * - 生命周期：模块级 Map，进程内常驻；扩展注册在会话初始化时重放
 *   （pending → register，与 media provider 同机制），扩展
 *   reload/unload 时按 sourceId 整源清除（ModelRegistry.clearSourceRegistrations
 *   统一入口）。
 * - 启停：always-on——注册表无状态可卸载，会话注入随 rebuildSystemPrompt
 *   每次重解析（扩展新注册的设计体系在下一次 prompt 重建即生效）。
 * - 冲突：内置 id 保留（minimal/glass/editorial/neubrutalism/darkneon）；
 *   扩展 id 撞内置抛 `registerDesignSystem: id "x" collides with a built-in
 *   design system`，撞扩展注册抛 `... is already registered`（照抄
 *   image-providers 防撞契约形态）。
 *   检视入口：本文件 + `extensibility/extensions/types.ts`（DesignSystemConfig）。
 */

import type { DesignSystemConfig } from "../extensibility/extensions/types";
import type { PromptComposer } from "../prompts/composer";

/**
 * Built-in design systems (stable ids — persisted sessions reference them).
 * swatches/tokens fragments reuse the existing gui token ladder
 * (client-core tokens.css / docs/gui-design.md §5s); no new tokens.
 */
export const BUILTIN_DESIGN_SYSTEMS: readonly DesignSystemConfig[] = [
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
		promptSection: {
			name: "design-system",
			order: 40,
			text: "设计体系「极简留白」(Neutral Minimal)：中性灰阶配色（近黑白灰，无彩色倾向），大面积留白，发丝线（1px 低对比）分隔而非卡片堆叠；圆角取小档（--radius-sm）；排版克制、字重对比弱；禁用阴影与渐变装饰，让内容层级靠间距与对比度建立。",
		},
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
		promptSection: {
			name: "design-system",
			order: 40,
			text: "设计体系「玻璃拟态」(Glassmorphism)：四层玻璃配方——半透明底（--glass-bg/--glass-bg-strong）、内缘高光 rim（--glass-edge-hi 上缘/--glass-edge-lo 下缘）、对角泽面（--glass-sheen 仅浮层）、双层投影（--glass-shadow）；内容必须衬在玻璃之下（blur 需要背后的内容）；圆角大档（--radius-2xl）；动效走 --spring-liquid 回弹曲线；禁止实色卡片替代玻璃面。",
		},
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
		promptSection: {
			name: "design-system",
			order: 40,
			text: "设计体系「编辑杂志」(Editorial)：衬线字体贯穿标题与正文，字阶对比强烈（标题大、引文更大）；版面用分栏、段落首字、分割线组织，像杂志页面而非应用界面；颜色以纸白底 + 近黑文字 + 单一点缀色；分隔用细线（--border 低透明），不用卡片阴影；圆角极小或为零。",
		},
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
		promptSection: {
			name: "design-system",
			order: 40,
			text: "设计体系「新粗野」(Neubrutalism)：平涂高饱和色块（黄/红/青/紫），2-3px 纯黑硬边框，硬偏移投影（无模糊、无渐变），圆角为零；按钮与卡片是「贴上去的纸片」，hover 用位移而非变色；字体粗黑、无衬线；整体 raw、直接、反精致。",
		},
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
		promptSection: {
			name: "design-system",
			order: 40,
			text: "设计体系「暗黑霓虹」(Dark Neon)：近黑深底（--bg/--bg-inset 暗色阶梯），单一霓虹 accent（青/品红/黄绿系）承担全部强调；层次靠发光与暗部对比——accent 发光描边、暗色卡片嵌套，不用浅色投影；文字高对比近白；暗黑模式下玻璃材质退化为 rim+泽面（blur 归零）。",
		},
	},
];

/** Builtin ids form the closed reserved base; extension ids must not shadow them. */
export function isBuiltinDesignSystemId(id: string): boolean {
	return BUILTIN_DESIGN_SYSTEMS.some(system => system.id === id);
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension design system registry (pi.registerDesignSystem)
// ═══════════════════════════════════════════════════════════════════════════

const extensionDesignSystems = new Map<string, { config: DesignSystemConfig; sourceId: string }>();

/** Register an extension design system. Throws when the id shadows a built-in or an existing registration. */
export function registerExtensionDesignSystem(config: DesignSystemConfig, sourceId: string): void {
	if (isBuiltinDesignSystemId(config.id)) {
		throw new Error(`registerDesignSystem: id "${config.id}" collides with a built-in design system`);
	}
	if (extensionDesignSystems.has(config.id)) {
		throw new Error(`registerDesignSystem: id "${config.id}" is already registered`);
	}
	extensionDesignSystems.set(config.id, { config, sourceId });
}

/** Remove one extension design system registration. No-op when unknown. */
export function unregisterExtensionDesignSystem(id: string): void {
	extensionDesignSystems.delete(id);
}

/** Remove every extension design system registered from one extension source. */
export function clearExtensionDesignSystems(sourceId: string): void {
	for (const [id, registration] of extensionDesignSystems) {
		if (registration.sourceId === sourceId) extensionDesignSystems.delete(id);
	}
}

/** All extension-registered design systems (registration order). */
export function getExtensionDesignSystems(): readonly DesignSystemConfig[] {
	return [...extensionDesignSystems.values()].map(registration => registration.config);
}

/** Look up one design system by id across built-ins and extensions. */
export function getDesignSystem(id: string): DesignSystemConfig | undefined {
	return BUILTIN_DESIGN_SYSTEMS.find(system => system.id === id) ?? extensionDesignSystems.get(id)?.config;
}

export interface ListedDesignSystem {
	config: DesignSystemConfig;
	source: "builtin" | "extension";
}

/** Merged registry view for `design.systems.list`: built-ins first, then extensions. */
export function listDesignSystems(): ListedDesignSystem[] {
	return [
		...BUILTIN_DESIGN_SYSTEMS.map(config => ({ config, source: "builtin" as const })),
		...getExtensionDesignSystems().map(config => ({ config, source: "extension" as const })),
	];
}

/**
 * Read `designSystemId` from session project metadata and resolve its prompt
 * section. Unknown/absent ids yield undefined (skip silently — never throws).
 */
export function resolveDesignSystemPromptSection(
	metadata: Record<string, unknown> | null | undefined,
): { name: string; order: number; text: string } | undefined {
	const id = metadata?.designSystemId;
	if (typeof id !== "string" || !id) return undefined;
	return getDesignSystem(id)?.promptSection;
}

/**
 * Session-guidance injection seam (docs/review/0.5.0-m3-mode-page-redesign.md
 * §3.2): sync the `design-system` composer section from project metadata.
 * Idempotent across rebuilds (removeBySource → re-add); leaves the composer
 * untouched when no valid system is selected.
 */
export function applyDesignSystemSection(
	composer: PromptComposer,
	metadata: Record<string, unknown> | null | undefined,
): void {
	composer.removeBySource("design-system");
	const section = resolveDesignSystemPromptSection(metadata);
	if (!section) return;
	composer.add({ ...section, source: "design-system" });
}
