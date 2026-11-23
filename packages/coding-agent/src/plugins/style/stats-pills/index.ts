/**
 * Composer 的「性能与用量」读数，作为插件提供。
 *
 * ## 为什么它是一个插件而不是宿主组件
 *
 * 这两个读数回答的是「这次对话用了多少、快不快」，属于**会话的观测面**，不是
 * 输入区的结构。宿主的 composer 只需要留一个座位（`conversation.composer.dock`）让人放读数，
 * 至于放什么、怎么算、显示成几行，应该是可替换的——用户可能想要更详细的读数，
 * 或者根本不想要这一行。
 *
 * 把它声明成插件还带来两个直接好处：
 *
 * 1. **可关**：不需要这一行的人可以停用它，而不是忍受它占位置；
 * 2. **可替换**：第三方可以写一个自己的读数插件挂到同一个座位，宿主的渲染
 *    代码一行不动。
 *
 * ## 两条条目，不是一个整体
 *
 * 座位是 list，两枚胶囊各注册一条条目（`id: "activity"` / `id: "usage"`，
 * `order` 0/1），与参考实现的颗粒度一致：第三方可以只替换其中一枚读数，
 * 保留另一枚。两条条目都从同一个 `session.contextUsage` 读数取数——它们彼此
 * 独立，不假设对方会替自己取数。
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

import type { PluginAPI } from "../../../extensibility/extensions/types";

/** 插件在 cordis 运行时与扩展中心的身份。 */
export const name = "musepi-stats-pills";

/** 不依赖任何宿主服务，也不发布服务——全部效果是注册一个座位组件。 */
export const inject = [] as const;
export const provide = [] as const;

/** Cordis 入口。 */
export function apply(ctx: PluginAPI): void {
	statsPills(ctx);
}

function statsPills(ctx: PluginAPI): void {
	// `conversation.composer.dock` 是输入卡下方的整行座位。两枚读数各占一条
	// 条目（参考实现同样是「一个胶囊一条条目」）：`id` 让另一份插件可以按 id
	// 只替换其中一枚，而不是拿走整行读数。
	//
	// `order` 0/1 固定阅读顺序：先看活动与速度，再看用量。
	ctx.slots.register({
		slot: "conversation.composer.dock",
		id: "activity",
		moduleUrl: "./ui/activity-pill.tsx",
		label: "活动与速度",
		order: 0,
	});
	ctx.slots.register({
		slot: "conversation.composer.dock",
		id: "usage",
		moduleUrl: "./ui/usage-pill.tsx",
		label: "用量",
		order: 1,
	});

	ctx.logger.info("[stats-pills] composer stats entries registered (conversation.composer.dock: activity, usage)");
}
