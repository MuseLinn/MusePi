/**
 * Creation surface domain — M3.7a design 模式页文案
 * （docs/review/0.5.0-m3-mode-page-redesign.md §2；六 tab 表单已整体退役，
 * 其字段级文案随表单一并删除）。
 * 面板复用 shell/settings 域既有通用键（如确认/删除按钮语义走
 * DialogFrame 既有键），此处只收创作面新增文案。
 */
export const creation = {
	// 模式页骨架（§2.1:overlay 骨架沿用 M3.1,内容物是模式页空态）
	"creation title": "创建",
	"creation close": "关闭创作面板",
	// 类型 chip 排（§2.3:六面分类法 + 模板 rail + 其他，单选）
	"creation tab prototype": "原型",
	"creation tab live artifact": "实况产物",
	"creation tab deck": "演示稿",
	"creation tab template": "模板",
	// 历史模板文件的 tab 可以是 "media"(daemon 不枚举校验),行徽标需要它
	"creation tab media": "媒体",
	"creation tab other": "其他",
	"creation media image": "图片",
	"creation media video": "视频",
	"creation media audio": "音频",
	// 输入框 placeholder（§2.4:随选中的类型 chip 变化）
	"creation placeholder prototype": "描述你想设计的界面、风格与情绪…",
	"creation placeholder live artifact": "描述这个实况产物要持续呈现的内容…",
	"creation placeholder deck": "描述演示稿的主题、篇幅与受众…",
	"creation placeholder image": "描述画面主体、风格与光线…",
	"creation placeholder video": "描述镜头、节奏与风格…",
	"creation placeholder audio": "描述声音的情绪、节奏与用途…",
	"creation placeholder template": "挑一个模板开始，或切到其他类型直接描述…",
	"creation placeholder other": "描述你想做的东西…",
	// 模板 rail（template chip 的内容区,§3.4 机制不变；composer 下方常驻展开）
	"creation templates title": "会话模板",
	"creation templates empty": "还没有模板。创建原型或演示稿后，可在创建成功的提示里保存为模板。",
	// 空态的「空白起步」等价路径（opendesign StartFromPicker 的 Blank 第一项）：
	// 聚焦 composer，直接输入发送即可建会话，空态不卡住用户。
	"creation templates blank start": "从空白开始：在上方输入需求并发送",
	"creation template delete": "删除",
	"creation template confirm delete": "删除模板「{name}」？此操作不可撤销。",
	"creation template unnamed": "未命名模板",
	// 创建成功 toast 上的保存入口（§3.4）
	"creation saved toast": "会话已创建",
	"creation template save action": "保存为模板",
	"creation template saved": "已保存为模板",
	// 素材策略 + 「高级 ▸」折叠（M3.7c §4：素材策略单选对齐 WorkBuddy
	// 「素材不足时的处理策略」语义；高级折叠承载类型特有字段，键与默认值
	// 沿用 M3.1 §3 逐字段对表 / M3.2 表单文案）
	"creation asset policy label": "素材",
	"creation asset policy ai image": "AI 生图",
	"creation asset policy placeholder": "色块占位",
	"creation advanced": "高级",
	"creation platform label": "平台",
	"creation platform responsive": "响应式",
	"creation platform web-desktop": "桌面 Web",
	"creation platform mobile-ios": "iOS",
	"creation platform mobile-android": "Android",
	"creation platform tablet": "平板",
	"creation platform desktop-app": "桌面应用",
	"creation fidelity label": "保真度",
	"creation fidelity wireframe": "线框",
	"creation fidelity high-fidelity": "高保真",
	"creation surface landing": "包含落地页",
	"creation surface os widgets": "包含 OS 控件",
	"creation speaker notes": "演讲者备注",
	"creation media model label": "模型",
	"creation media aspect label": "画幅",
	"creation media duration label": "时长",
	"creation media duration sec": "{sec} 秒",
	"creation media audio kind label": "类型",
	"creation media kind speech": "语音",
	"creation media kind sfx": "音效",
	"creation media voice label": "音色",
	"creation media voice placeholder": "音色名，如 warm-female",
	"creation media no providers": "暂无可用 provider，请在 设置 → 媒体生成 中配置。",
	"creation media not configured": "未配置",
	"creation media configured": "已配置",
} as const;

/** Key union for the creation domain (source of truth). */
export type CreationKey = keyof typeof creation;
