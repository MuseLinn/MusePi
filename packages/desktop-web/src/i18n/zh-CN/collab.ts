export const collab = {
	// ── Collab link ───────────────────────────────────────────────────────────
	"Invalid relay URL: {url}": "无效的中继 URL：{url}",
	"Unsupported relay URL scheme: {scheme}": "不支持的中继 URL 协议：{scheme}",
	"relay link must be wss:// (plain ws:// is only allowed for localhost)":
		"中继链接必须为 wss://（纯 ws:// 仅允许用于 localhost）",
	"Invalid collab link: {url}": "无效的协作链接：{url}",
	"Collab link must contain a /r/<roomId> path": "协作链接必须包含 /r/<房间ID> 路径",
	"Collab link is missing the <key> part": "协作链接缺少 <key> 部分",
	"Collab link key must be 32 (view) or 48 (full) base64url bytes":
		"协作链接密钥必须为 32（只读）或 48（完整）个 base64url 字节",
	"browser crypto unavailable on insecure http: use localhost or the tunnel wss link":
		"当前页面无法执行浏览器加密（需 https 或 localhost）。本机请访问 localhost:端口；跨机请使用 /collab tunnel 的 https 链接",
	"plaintext session: not encrypted — anyone on this network can read it":
		"明文会话：未加密——同网段内的任何人都可以读取本会话",
} as const;

/** Key union for the collab domain (source of truth). */
export type CollabKey = keyof typeof collab;
