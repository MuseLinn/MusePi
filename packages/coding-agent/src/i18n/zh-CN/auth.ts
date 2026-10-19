export const auth = {
	// ── OAuth / Login ────────────────────────────────────────
	"auth.unconfigured": "未配置",
	"auth.apiKeyConfigured": "API 密钥已配置",
	"auth.subscriptionConfigured": "订阅已配置",
	"auth.selectProviderConfigure": "选择要配置的提供商:",
	"auth.selectProviderLogout": "选择要登出的提供商:",
	"auth.apiKey": "API 密钥",
	"auth.unconfigured2": "· 未配置",
	"auth.configured": "✓ 已配置",

	// ── OAuth / Login ──────────────────────────────────────
	"auth.authNone": "认证：无",
	"auth.authOauth": "认证：OAuth（已认证）",
	"auth.enterYourApiKey": "输入您的 API 密钥或令牌：",
	"auth.enterYourOauthClient": "输入您的 OAuth 客户端 ID：",
	"auth.enterYourOauthClientSecret": "输入您的 OAuth 客户端密钥：",
	"auth.enterOauthScopes": "输入 OAuth 作用域（空格分隔）：",
	"auth.enterOauthAuthorizationEndpoint": "输入 OAuth 授权端点：",
	"auth.enterOauthTokenEndpoint": "输入 OAuth 令牌端点：",
	"auth.provideApiKeyToken": "手动提供 API 密钥/令牌。",
	"auth.launchingOauthFlow": "正在启动 OAuth 流程…",
	"auth.launchingBrowserAuthorization": "正在启动浏览器进行授权…",
	"auth.oauthParametersCouldNot": "无法发现 OAuth 参数。",
	"auth.mcpOauthFlowCancelled": "MCP OAuth 流程已被用户取消",
	"auth.mcpOauthFlowTimed": "MCP OAuth 流程已超时",
	"auth.authorizationTokenUrlsRequired": "需要提供授权和令牌 URL。",
	"auth.noAuthenticationRequired": "无需认证",
	"auth.saveConfiguration": "保存此配置？",
	"auth.editOauthSettings": "  编辑 OAuth 设置",
	"auth.chooseNextAction": "选择下一步操作：",
} as const;

/** Key union for the auth domain (mirrors the guest-client locale split). */
export type AuthKey = keyof typeof auth;
