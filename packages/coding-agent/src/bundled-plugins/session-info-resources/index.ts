/**
 * 会话信息卡「资源」分区，作为插件提供。
 *
 * ## 能力缝声明
 *
 * - 名称+ns：`musepi-session-info-resources` Cordis 插件，
 *   `chat.session-info.resources` 会话信息卡分区座位（前缀族声明在
 *   collab-proto `EXTENSION_SLOT_DECLARATION.prefixes`）。
 * - 输入：daemon 的 `system.resources` 采样——进程 rss/CPU%、整机 CPU%/内存。
 * - 输出：卡片内三行读数（MusePi / CPU / Memory），每行「标签 / 条 / 数值」。
 * - 生命周期：随卡片挂载；分区自己按 2s 轮询采样，卸载即停。
 * - 启停：停用或编译失败时座位没有占据者，卡片不渲染该分区（无内置回退）。
 * - 冲突：独占 `chat.session-info.resources`；不读写会话、事件、设置或连接面。
 * - 检视入口：本目录、`ui/resource-rows.ts`、`registration.test.ts`、
 *   `ui/resource-rows.test.ts`。
 *
 * ## 为什么它是一个插件而不是宿主组件
 *
 * 「进程占多少内存、这台机器现在多忙」是**会话的观测面**，不是信息卡的
 * 结构。卡片只需要留一个分区座位，放什么读数、画几行、要不要条形，应该
 * 可替换——不需要这一块的人可以停用它，第三方也能挂自己的实现，宿主的卡片
 * 代码一行不动。
 *
 * 资源读数不是会话元数据：缺了它卡片依然完整，所以这里没有内置回退。
 */

import type { PluginAPI } from "../../extensibility/extensions/types";

/** 插件在 cordis 运行时与扩展中心的身份。 */
export const name = "musepi-session-info-resources";

/** 不依赖任何宿主服务，也不发布服务——全部效果是注册一个座位组件。 */
export const inject = [] as const;
export const provide = [] as const;

/** Cordis 入口。 */
export function apply(ctx: PluginAPI): void {
	// 前缀族 `chat.session-info.` 由 collab-proto 声明，任意 id 合法；卡片按
	// 前缀自动挂载，除了 `plugins`/`agents` 这两个有专属座位与内置回退的分区。
	ctx.slots.register({
		slot: "chat.session-info.resources",
		moduleUrl: "./ui/resources-section.tsx",
		label: "资源",
	});

	ctx.logger.info("[session-info-resources] card section registered (chat.session-info.resources)");
}
