/**
 * 六字段能力缝声明：
 * - 名称+ns：`memory` 桌面 Cordis 插件、`settings.tab.memory` 设置页槽位。
 * - 输入：宿主传入的 rpc；页面读取 `settings.schema` 与既有 `memory.*` RPC。
 * - 输出：设置页「记忆」整页 —— 后端选择、工作区文件浏览、实时状态与维护操作。
 * - 生命周期：页面随设置页导航挂载/卸载；没有常驻进程或后台订阅。
 * - 启停：停用后槽位消失，SettingsView 回退内置 `MemorySection`。
 * - 冲突：独占 `settings.tab.memory`；不接管 `memory.*` RPC 的 daemon 实现。
 * - 检视入口：本目录与 `test/memory-plugin.test.tsx`。
 */
interface MemoryPluginApi {
	setLabel(label: string): void;
	slots: {
		register(component: {
			slot: "settings.tab.memory";
			moduleUrl: "./page.tsx";
			label: string;
			availability: "always";
		}): void;
	};
}

export const name = "musepi-memory";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: MemoryPluginApi): void {
	ctx.setLabel("MusePi 记忆");
	ctx.slots.register({
		slot: "settings.tab.memory",
		moduleUrl: "./page.tsx",
		label: "记忆",
		availability: "always",
	});
}
