export const auth = {
	// ── OAuth / Login ────────────────────────────────────────
	unconfigured: "未配置",
	"API key configured": "API 密钥已配置",
	"subscription configured": "订阅已配置",
	"Select provider to configure:": "选择要配置的提供商:",
	"Select provider to logout:": "选择要登出的提供商:",
	"API Key": "API 密钥",
	"• unconfigured": "· 未配置",
	"✓ configured": "✓ 已配置",

	// ── OAuth / Login ──────────────────────────────────────
	"Auth: None": "认证：无",
	"Auth: OAuth (authenticated)": "认证：OAuth（已认证）",
	"Enter your API key or token:": "输入您的 API 密钥或令牌：",
	"Enter your OAuth client ID:": "输入您的 OAuth 客户端 ID：",
	"Enter your OAuth client secret:": "输入您的 OAuth 客户端密钥：",
	"Enter OAuth scopes (space-separated):": "输入 OAuth 作用域（空格分隔）：",
	"Enter the OAuth authorization endpoint:": "输入 OAuth 授权端点：",
	"Enter the OAuth token endpoint:": "输入 OAuth 令牌端点：",
	"Provide API key/token manually.": "手动提供 API 密钥/令牌。",
	"Launching OAuth flow...": "正在启动 OAuth 流程…",
	"Launching browser for authorization...": "正在启动浏览器进行授权…",
	"OAuth parameters could not be discovered.": "无法发现 OAuth 参数。",
	"MCP OAuth flow cancelled by user": "MCP OAuth 流程已被用户取消",
	"MCP OAuth flow timed out": "MCP OAuth 流程已超时",
	"Authorization and Token URLs are required.": "需要提供授权和令牌 URL。",
	"No authentication required": "无需认证",
	"Save this configuration?": "保存此配置？",
	"  Edit OAuth settings": "  编辑 OAuth 设置",
	"Choose next action:": "选择下一步操作：",
} as const;

/** Key union for the auth domain (mirrors the desktop-web locale split). */
export type AuthKey = keyof typeof auth;
