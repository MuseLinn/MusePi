// ============================================================
// MusePi zh-CN locale — Chinese translations for setup & settings.
// Key naming: component.section.string — lowercase kebab.
// ============================================================

import type { TranslationMap } from "./index.ts";

export const zhCN: TranslationMap = {
	// Setup wizard
	"setup.title": "MusePi 设置向导",
	"setup.welcome": "欢迎使用 MusePi",
	"setup.welcome.desc": "MusePi 是一个 AI 编码助手终端。以下向导将帮助您完成基本设置。",
	"setup.provider": "选择 AI 提供商",
	"setup.provider.desc": "选择您的 AI 模型提供商。您也可以稍后在设置中添加更多。",
	"setup.provider.apiKey": "API 密钥",
	"setup.provider.apiKey.desc": "输入您的 API 密钥以开始使用。密钥存储在本地，不会上传。",
	"setup.provider.skip": "跳过",
	"setup.provider.verify": "验证连接",
	"setup.provider.verified": "连接成功",
	"setup.provider.failed": "连接失败，请检查密钥",
	"setup.theme": "选择主题",
	"setup.theme.desc": "选择一个您喜欢的外观主题。",
	"setup.done": "设置完成",
	"setup.done.desc": "您现在可以开始使用 MusePi 了！运行 /help 查看所有命令。",
	"setup.finish": "完成",
	"setup.next": "下一步",
	"setup.back": "上一步",
	"setup.locale": "界面语言",
	"setup.locale.desc": "选择 MusePi 界面的显示语言。",

	// Settings — general sections
	"settings.title": "设置",
	"settings.general": "通用",
	"settings.tools": "工具",
	"settings.model": "模型",
	"settings.ui": "界面",
	"settings.advisor": "顾问",
	"settings.memory": "记忆",
	"settings.swarm": "集群",
	"settings.lsp": "语言服务器",
	"settings.mcp": "MCP",
	"settings.compaction": "压缩",
	"settings.notifications": "通知",
	"settings.providers": "提供商",
	"settings.advanced": "高级",

	// Settings — locale
	"settings.locale": "界面语言",
	"settings.locale.desc": "更改 MusePi 界面的显示语言。需要重新加载。",

	// Settings — edit
	"settings.edit.hashline": "哈希行编辑",
	"settings.edit.hashline.desc": "使用标签锚定的差异补丁编辑，而非精确替换。",
	"settings.edit.enforceSeenLines": "强制已见行",
	"settings.edit.enforceSeenLines.desc": "拒绝编辑未在 read/grep 中显示的行（仅哈希行模式下生效）。",
	"settings.edit.toolDisplayStyle": "工具卡片样式",
	"settings.edit.toolDisplayStyle.desc": "'bordered'：边框线条风格；'filled'：实心背景填充。",

	// Settings — tool select
	"settings.toolSelect.enabled": "工具选择（实验性）",

	// Settings — tui
	"settings.tui.style": "TUI 样式",
	"settings.tui.modelInBorder": "标题栏显示模型名",

	// Settings — advisor
	"settings.advisor.enabled": "启用顾问",
	"settings.advisor.enabled.desc": "在后台运行一个 AI 顾问，审查您的操作并提供建议。",
	"settings.advisor.model": "顾问模型",
	"settings.advisor.model.desc": "用于顾问的模型。留空则使用会话默认模型。",

	// Settings — memory
	"settings.memory.enabled": "启用记忆",
	"settings.memory.scope": "记忆范围",
	"settings.memory.scope.project": "项目",
	"settings.memory.scope.global": "全局",

	// Settings — compaction
	"settings.compaction.strategy": "压缩策略",
	"settings.compaction.strategy.default": "默认",
	"settings.compaction.strategy.snapcompact": "快照压缩",

	// Settings — notifications
	"settings.notifications.enabled": "启用通知",
	"settings.notifications.condition": "通知条件",
	"settings.notifications.condition.always": "始终",
	"settings.notifications.condition.unfocused": "失去焦点时",

	// Common
	"common.yes": "是",
	"common.no": "否",
	"common.on": "开",
	"common.off": "关",
	"common.enabled": "已启用",
	"common.disabled": "已禁用",
	"common.save": "保存",
	"common.cancel": "取消",
	"common.close": "关闭",
	"common.loading": "加载中…",
	"common.error": "错误",
	"common.warning": "警告",
	"common.success": "成功",
	"common.search": "搜索",
	"common.filter": "筛选",
	"common.clear": "清除",
	"common.copy": "复制",
	"common.paste": "粘贴",
};
