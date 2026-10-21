/**
 * Composer 的「性能与用量」读数，作为插件提供。
 *
 * ## 为什么它是一个插件而不是宿主组件
 *
 * 这两个读数回答的是「这次对话用了多少、快不快」，属于**会话的观测面**，不是
 * 输入区的结构。宿主的 composer 只需要留一个座位（`composer.dock`）让人放读数，
 * 至于放什么、怎么算、显示成几行，应该是可替换的——用户可能想要更详细的读数，
 * 或者根本不想要这一行。
 *
 * 把它声明成插件还带来两个直接好处：
 *
 * 1. **可关**：不需要这一行的人可以停用它，而不是忍受它占位置；
 * 2. **可替换**：第三方可以写一个自己的读数插件挂到同一个座位，宿主的渲染
 *    代码一行不动。
 *
 * ## 数据来源
 *
 * 全部来自宿主已有的 RPC，插件不新开后端：
 *
 * - `session.contextUsage` — token 用量、上下文占用、花费、缓存命中率；
 * - `session.stats` 一类的窗口统计由 `session.contextUsage` 的 usage 块覆盖。
 *
 * 这正是「插件只组合宿主已有能力」的形态：它不复制统计逻辑，只把读数画出来。
 */

import type { ExtensionAPI } from "../../extensibility/extensions/types";

/** 插件在 cordis 运行时与扩展中心的身份。 */
export const name = "musepi-stats-pills";

/** 不依赖任何宿主服务，也不发布服务——全部效果是注册一个座位组件。 */
export const inject = [] as const;
export const provide = [] as const;

/** Cordis 入口。 */
export function apply(pi: ExtensionAPI): void {
	statsPills(pi);
}

export default function statsPills(pi: ExtensionAPI): void {
	pi.setLabel("MusePi 性能与用量");

	// `composer.dock` 是输入卡下方的整行座位，正是这类「一行读数」
	// 该待的位置——读数属于 composer 的页脚行，跟在输入卡之后，不占用
	// 上方 dock 的状态行，也不会压在对话内容上。
	//
	// `order` 取一个较小值：统计行是页脚的第一行，排在其它停靠条目
	// 之前才符合阅读顺序（先看用量，再看其它提示）。
	pi.registerComponent({
		slot: "composer.dock",
		moduleUrl: "./ui/stats-row.tsx",
		label: "性能与用量",
		order: 10,
	});

	pi.logger.info("[stats-pills] composer stats row registered (composer.dock)");
}
