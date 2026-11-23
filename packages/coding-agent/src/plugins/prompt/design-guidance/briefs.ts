/**
 * Brief text owned by the design-guidance plugin.
 *
 * The host no longer assembles this prose: it passes the current selection
 * (`designSystemId` / `assetPolicy`) into prompt assembly, and the plugin
 * renders the one matching brief. Extension-registered design systems carry
 * their own text in the registry, so the plugin falls back to it for ids it
 * does not own.
 */

/** One instruction per built-in design system id. */
export const BUILTIN_DESIGN_SYSTEM_BRIEFS = {
	minimal:
		"设计体系「极简留白」(Neutral Minimal)：中性灰阶配色（近黑白灰，无彩色倾向），大面积留白，发丝线（1px 低对比）分隔而非卡片堆叠；圆角取小档（--radius-sm）；排版克制、字重对比弱；禁用阴影与渐变装饰，让内容层级靠间距与对比度建立。",
	glass: "设计体系「玻璃拟态」(Glassmorphism)：四层玻璃配方——半透明底（--glass-bg/--glass-bg-strong）、内缘高光 rim（--glass-edge-hi 上缘/--glass-edge-lo 下缘）、对角泽面（--glass-sheen 仅浮层）、双层投影（--glass-shadow）；内容必须衬在玻璃之下（blur 需要背后的内容）；圆角大档（--radius-2xl）；动效走 --spring-liquid 回弹曲线；禁止实色卡片替代玻璃面。",
	editorial:
		"设计体系「编辑杂志」(Editorial)：衬线字体贯穿标题与正文，字阶对比强烈（标题大、引文更大）；版面用分栏、段落首字、分割线组织，像杂志页面而非应用界面；颜色以纸白底 + 近黑文字 + 单一点缀色；分隔用细线（--border 低透明），不用卡片阴影；圆角极小或为零。",
	neubrutalism:
		"设计体系「新粗野」(Neubrutalism)：平涂高饱和色块（黄/红/青/紫），2-3px 纯黑硬边框，硬偏移投影（无模糊、无渐变），圆角为零；按钮与卡片是「贴上去的纸片」，hover 用位移而非变色；字体粗黑、无衬线；整体 raw、直接、反精致。",
	darkneon:
		"设计体系「暗黑霓虹」(Dark Neon)：近黑深底（--bg/--bg-inset 暗色阶梯），单一霓虹 accent（青/品红/黄绿系）承担全部强调；层次靠发光与暗部对比——accent 发光描边、暗色卡片嵌套，不用浅色投影；文字高对比近白；暗黑模式下玻璃材质退化为 rim+泽面（blur 归零）。",
} as const;

export type BuiltinDesignSystemId = keyof typeof BUILTIN_DESIGN_SYSTEM_BRIEFS;

/** One instruction per asset-policy value. */
export const ASSET_POLICY_BRIEFS = {
	"ai-image":
		"素材策略（AI 生图）：产物中需要图片/视频素材的引用处,一律调用媒体生成工具产出真实素材——图片走 generate_image 工具,视频走 agnes_video_gen 工具,按产物语境选择合适的画幅与时长;不得以占位色块或外链图片代替实际生成。",
	placeholder:
		"素材策略（色块占位）：产物中需要图片/视频素材的引用处,一律用色块加文字标注占位（标注写清素材用途与建议画幅/时长）,布局按真实素材的尺寸与比例预留;禁止调用 generate_image、agnes_video_gen 等任何媒体生成工具。",
} as const;

export type AssetPolicy = keyof typeof ASSET_POLICY_BRIEFS;

/** Whether an id names a brief this plugin owns (rather than an extension's). */
export function isBuiltinDesignSystemBriefId(id: string): id is BuiltinDesignSystemId {
	return Object.hasOwn(BUILTIN_DESIGN_SYSTEM_BRIEFS, id);
}
