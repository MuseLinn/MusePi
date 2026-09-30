/**
 * i18n 跨域重复键的容错检测（dsh LocaleRuntime fail-safe parity）。
 *
 * 历史事故：barrel 在模块加载时对跨域重复 key 直接 throw —— 一个重复
 * 文案键就能让整个 GUI 白屏（已发生两次）。现在的契约：
 *
 * - 检测永不抛错：冲突记入返回值并打一条带固定前缀的 console.error
 *   （devtools/日志可检索），UI 照常渲染；
 * - 词表合并仍由各语言 barrel 的 spread 完成（保住 `as const` 字面量
 *   类型 —— TranslationKey 依赖它），本模块只做纯函数检测；
 * - 重复键在测试里 fail-loud（见 i18n.test.ts 的 parity 断言），
 *   CI / `bun test` 必经路径把关，运行时只做无害降级。
 */

export interface DomainDuplicate {
	/** 先出现（被覆盖）的域文件。 */
	first: string;
	/** 后出现（生效）的域文件。 */
	second: string;
}

/** Diagnostics prefix — greppable in devtools, logs and CI output. */
export const I18N_DUPLICATE_LOG_PREFIX = "[musepi-i18n] duplicate key:";

/**
 * 扫描各域词表间的跨域重复键。纯函数、无模块级状态，同一进程内可被
 * 两种语言多次调用。同一 key 出现在 ≥3 个域时保留最早出现者作 first、
 * 记录最新覆盖者作 second（列表仍只出现一条，测试失败信息里可见双方）。
 */
export function collectDomainDuplicates(
	locale: string,
	parts: Record<string, Record<string, string>>,
): Record<string, DomainDuplicate> {
	const firstDomain = new Map<string, string>();
	const duplicates: Record<string, DomainDuplicate> = {};
	for (const [domain, dict] of Object.entries(parts)) {
		for (const key of Object.keys(dict)) {
			const first = firstDomain.get(key);
			if (first === undefined) {
				firstDomain.set(key, domain);
			} else if (first !== domain) {
				duplicates[key] = { first, second: domain };
			}
		}
	}
	const entries = Object.entries(duplicates);
	if (entries.length > 0) {
		// Loud but non-fatal: a duplicate must never white-screen the GUI again.
		console.error(
			`${I18N_DUPLICATE_LOG_PREFIX} ${entries.length} key(s) in ${locale} —`,
			entries.map(([key, d]) => `"${key}" (${d.first} & ${d.second})`).join(", "),
		);
	}
	return duplicates;
}
