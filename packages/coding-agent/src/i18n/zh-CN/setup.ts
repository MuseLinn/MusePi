export const setup = {
	// ── Setup wizard — tabs ──────────────────────────────────
	"setup.signIn": "登录",
	"setup.model": "模型",
	"setup.messages": "消息",
	"setup.extensions": "扩展",

	// ── Setup wizard — splash ────────────────────────────────
	"setup.ompAlignedCodingAgent": "MusePi 对齐的编码助手",
	"setup.welcomeLetS.info": "欢迎！让我们快速完成设置。",
	"setup.pressAnyKeyBegin": "按任意键开始...",

	// ── Setup wizard — steps ─────────────────────────────────
	"setup.step": "步骤",
	"setup.tab": "切换标签页",

	// ── Setup wizard — outro ─────────────────────────────────
	"setup.setupComplete": "设置完成！",
	"setup.youReReadyStart": "您已准备好使用 MusePi 开始编码。",
	"setup.pressAnyKeyBegin2": "按任意键开始。",

	// ── Setup wizard — sign-in scene ─────────────────────────
	"setup.chooseAiProvider": "选择 AI 提供商",
	"setup.noProvidersAvailable": "没有可用的提供商。",
	"setup.subscription": "订阅",
	"setup.apiKey": "API 密钥",
	"setup.typeSearch": "输入搜索...",
	"setup.typeSearch2": "输入搜索以过滤",

	// ── Setup wizard — model scene ───────────────────────────

	"setup.noModelsAvailable.info": "没有可用模型。请先配置提供商。",
	"setup.chooseYourDefaultModel": "选择您的默认模型（回车确认）。",

	// ── Setup wizard — theme scene ───────────────────────────
	"setup.pickTheme": "选择一个主题",
	"setup.pickTheme2": "选择一个主题（回车确认）。",

	// ── Setup wizard — web search scene ──────────────────────
	"setup.pickDefaultWebSearch": "选择默认网络搜索提供商",
	"setup.pickDefaultWebSearchProvider": "选择默认网络搜索提供商（回车切换）。",
	"setup.configureSettingsMoreOptions": "在设置中配置更多选项",

	// ── Legacy setup wizard keys (new code no longer uses these) ──
	"setup.welcomeMusepiAi.info": "欢迎使用 MusePi，AI 编程助手。",
	"setup.pickThemeNavigate.info": "选择主题。用方向键浏览预览。",
	"setup.detectedAppearance": "检测到的外观",
	"setup.shareAnonymousUsageData": "分享匿名使用数据？",
	"setup.optingStoresTracking.info":
		"选择加入会在 settings.json 中存储跟踪标识符，并启用匿名使用分析。",

	// ── Setup wizard ───────────────────────────────────────
	"setup.chooseGlyphMode": "选择字形模式",
	"setup.pickRowRendersCleanly": "选择在终端中清晰显示的行。",
	"setup.rowShowsBoxes.info":
		"如果某行显示方框、乱码或对齐错误的图标，请选另一行。",
	"setup.setUpYourProviders": "设置您的提供商",
	"setup.signPickWeb.info":
		"登录并选择网络搜索提供商。完成后按 Esc 继续。",
	"setup.chooseYourDefaultModel2": "选择默认模型",
	"setup.searchConfiguredModelsSave": "搜索已配置的模型并保存新会话使用的模型。",
	"setup.discoveringAvailableModels": "正在发现可用模型…",
	"setup.typeSearchEnter.info": "输入搜索。回车将高亮的模型保存为默认模型。",
	"setup.pickProviderSign.info": "选择一个提供商登录——您可以连接多个。",
	"setup.startingOauthFlow": "正在启动 OAuth 流程…",
	"setup.pasteReturnedCodeRedirect": "提示时粘贴返回的代码或重定向 URL。",
	"setup.pasteAuthorizationCode": "粘贴授权码（或完整重定向 URL）:",
	"setup.loginCancelled": "登录已取消。",
	"setup.chooseAnotherProviderPress": "选择另一个提供商或按 Esc 继续。",
	"setup.webSearch": "网络搜索",
	"setup.chooseProviderWebSearch": "选择 web_search 工具首选提供商。",
	"setup.notConfiguredYet.info": "尚未配置——添加 API 密钥或登录以启用。",
	"setup.automaticallyUsesFirstConfigured": "自动使用第一个已配置的提供商。",
	"setup.checkingAvailability": "正在检查可用性…",
	"setup.handingOffNormalCli": "正在移交给正常 CLI…",
	"setup.cmdClickOpen": "Cmd+点击打开",
	"setup.ctrlClickOpen": "Ctrl+点击打开",
} as const;

/** Key union for the setup domain (mirrors the guest-client locale split). */
export type SetupKey = keyof typeof setup;
