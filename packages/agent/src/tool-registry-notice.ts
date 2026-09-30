/**
 * Tool-registry change notice（dsh developer/message 回灌 parity）。
 *
 * 热插拔（扩展/插件启停）在两步模型请求之间改变 wire 工具集时，
 * agent-loop 把这条通知以 developer 角色消息注入当前上下文（模型可见，
 * 位置贴近变化点；provider 前缀缓存只在追加处向前增长）。文本格式与
 * coding-agent 的 convertToLlm 重建路径（session 树里的 tool_registry
 * custom_message 条目）共用本函数，保证 live 注入与 resume 重放逐字一致。
 *
 * dsh 对支持 tool_addition/tool_removal wire 块的路由（DeepSeek）发类型化
 * 块、其余路由剥离 developer 消息只换声明表；我们的 provider 走 OpenAI
 * 兼容家族（pi-ai 的 developer 角色序列化为 developer/system），文本通知
 * 是跨 provider 的公共分母。
 */
export function formatToolRegistryNotice(added: readonly string[], removed: readonly string[]): string {
	const lines: string[] = [];
	for (const name of added) lines.push(`Tool added: ${name}`);
	for (const name of removed) lines.push(`Tool removed: ${name}`);
	return lines.join("\n");
}
