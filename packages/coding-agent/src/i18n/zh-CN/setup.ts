export const setup = {
	// ── Setup wizard — tabs ──────────────────────────────────
	"Sign in": "登录",
	Model: "模型",
	Messages: "消息",
	Extensions: "扩展",

	// ── Setup wizard — splash ────────────────────────────────
	"OMP-aligned coding agent": "MusePi 对齐的编码助手",
	"Welcome! Let's get you set up in a few quick steps.": "欢迎！让我们快速完成设置。",
	"Press any key to begin...": "按任意键开始...",

	// ── Setup wizard — steps ─────────────────────────────────
	Step: "步骤",
	tab: "切换标签页",

	// ── Setup wizard — outro ─────────────────────────────────
	"Setup complete!": "设置完成！",
	"You're ready to start coding with MusePi.": "您已准备好使用 MusePi 开始编码。",
	"Press any key to begin.": "按任意键开始。",

	// ── Setup wizard — sign-in scene ─────────────────────────
	"Choose an AI provider": "选择 AI 提供商",
	"No providers available.": "没有可用的提供商。",
	subscription: "订阅",
	"API key": "API 密钥",
	"Type to search": "输入搜索...",
	"type to search": "输入搜索以过滤",

	// ── Setup wizard — model scene ───────────────────────────

	"No models available. Configure providers first.": "没有可用模型。请先配置提供商。",
	"Choose your default model (Enter to select).": "选择您的默认模型（回车确认）。",

	// ── Setup wizard — theme scene ───────────────────────────
	"Pick a theme": "选择一个主题",
	"Pick a theme (Enter to select).": "选择一个主题（回车确认）。",

	// ── Setup wizard — web search scene ──────────────────────
	"Pick a default web search provider": "选择默认网络搜索提供商",
	"Pick a default web search provider (Enter to toggle).": "选择默认网络搜索提供商（回车切换）。",
	"Configure in settings for more options": "在设置中配置更多选项",

	// ── Legacy setup wizard keys (new code no longer uses these) ──
	"Welcome to MusePi, the AI coding agent.": "欢迎使用 MusePi，AI 编程助手。",
	"Pick a theme. Navigate with arrow keys to preview.": "选择主题。用方向键浏览预览。",
	"Detected appearance": "检测到的外观",
	"Share anonymous usage data?": "分享匿名使用数据？",
	"Opting in stores a tracking identifier in settings.json and enables anonymous usage analytics.":
		"选择加入会在 settings.json 中存储跟踪标识符，并启用匿名使用分析。",

	// ── Setup wizard ───────────────────────────────────────
	"Choose glyph mode": "选择字形模式",
	"Pick the row that renders cleanly in your terminal.": "选择在终端中清晰显示的行。",
	"If a row shows boxes, tofu, or misaligned icons, pick another.":
		"如果某行显示方框、乱码或对齐错误的图标，请选另一行。",
	"Set up your providers": "设置您的提供商",
	"Sign in and pick a web search provider. Press Esc when you're done.":
		"登录并选择网络搜索提供商。完成后按 Esc 继续。",
	"Choose your default model": "选择默认模型",
	"Search configured models and save the model used for new sessions.": "搜索已配置的模型并保存新会话使用的模型。",
	"Discovering available models…": "正在发现可用模型…",
	"Type to search. Enter saves the highlighted model as your default.": "输入搜索。回车将高亮的模型保存为默认模型。",
	"Pick a provider to sign in — you can connect more than one.": "选择一个提供商登录——您可以连接多个。",
	"Starting OAuth flow…": "正在启动 OAuth 流程…",
	"Paste the returned code or redirect URL when prompted.": "提示时粘贴返回的代码或重定向 URL。",
	"Paste the authorization code (or full redirect URL):": "粘贴授权码（或完整重定向 URL）:",
	"Login cancelled.": "登录已取消。",
	"Choose another provider or press Esc to continue.": "选择另一个提供商或按 Esc 继续。",
	"Web search": "网络搜索",
	"Choose the provider the web_search tool should prefer.": "选择 web_search 工具首选提供商。",
	"Not configured yet — add its API key or sign in to enable it.": "尚未配置——添加 API 密钥或登录以启用。",
	"Automatically uses the first configured provider.": "自动使用第一个已配置的提供商。",
	"Checking availability…": "正在检查可用性…",
	"Handing off to the normal CLI…": "正在移交给正常 CLI…",
	"Cmd+click to open": "Cmd+点击打开",
	"Ctrl+click to open": "Ctrl+点击打开",
} as const;

/** Key union for the setup domain (mirrors the desktop-web locale split). */
export type SetupKey = keyof typeof setup;
