export const collab = {
	// ── Collab link ───────────────────────────────────────────────────────────
	"collab.invalidRelayUrlWithUrl": "无效的中继 URL：{url}",
	"collab.unsupportedRelayUrlSchemeWithScheme": "不支持的中继 URL 协议：{scheme}",
	"collab.relayLinkMustWss":
		"中继链接必须为 wss://（纯 ws:// 仅允许用于 localhost）",
	"collab.invalidCollabLinkWithUrl": "无效的协作链接：{url}",
	"collab.collabLinkMustContain": "协作链接必须包含 /r/<房间ID> 路径",
	"collab.collabLinkMissingKey": "协作链接缺少 <key> 部分",
	"collab.collabLinkKeyMust":
		"协作链接密钥必须为 32（只读）或 48（完整）个 base64url 字节",
	"collab.browserCryptoUnavailable.info":
		"当前页面无法执行浏览器加密（需 https 或 localhost）。本机请访问 localhost:端口；跨机请使用 /collab tunnel 的 https 链接",
	"collab.plaintextSessionNot.info":
		"明文会话：未加密——同网段内的任何人都可以读取本会话",
} as const;

/** Key union for the collab domain (source of truth). */
export type CollabKey = keyof typeof collab;
