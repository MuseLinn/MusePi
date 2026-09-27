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
	// 模板 rail（template chip 的内容区,§3.4 机制不变）
	"creation templates title": "会话模板",
	"creation templates empty": "还没有模板。创建原型或演示稿后，可在创建成功的提示里保存为模板。",
	"creation template delete": "删除",
	"creation template confirm delete": "删除模板「{name}」？此操作不可撤销。",
	"creation template unnamed": "未命名模板",
	// 创建成功 toast 上的保存入口（§3.4）
	"creation saved toast": "会话已创建",
	"creation template save action": "保存为模板",
	"creation template saved": "已保存为模板",
} as const;

/** Key union for the creation domain (source of truth). */
export type CreationKey = keyof typeof creation;
