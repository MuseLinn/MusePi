/**
 * 六字段能力缝声明（docs/capability-seams.md 的 Cordis 行待补）：
 * - 名称+ns：`session-info` 桌面 Cordis 插件、`panel.tab.session-info` 动态面板槽位。
 * - 输入：宿主传入的 rpc、sessionId、cwd，以及既有 `session.list` /
 *   `session.contextUsage` / `settings.get` / `session.directories.list` 响应。
 * - 输出：右侧 rail 的“会话信息”入口与会话元数据、上下文占用、token 汇总。
 * - 生命周期：面板随插件 fiber 和槽位挂载/卸载，轮询只在该 tab 打开时运行。
 * - 启停：停用时移除 rail 入口与渲染，不保留静态备用面板。
 * - 冲突：独占 `panel.tab.session-info`；不接管内置 `context` 表面。
 * - 检视入口：本目录与 `session-info-plugin.test.tsx`。
 */
interface SessionInfoPluginApi {
	setLabel(label: string): void;
	registerComponent(component: {
		slot: "panel.tab.session-info";
		moduleUrl: "./page.tsx";
		label: string;
		availability: "always";
	}): void;
}

export const name = "musepi-session-info";
export const inject = [] as const;
export const provide = [] as const;

export function apply(pi: SessionInfoPluginApi): void {
	pi.setLabel("MusePi 会话信息");
	pi.registerComponent({
		slot: "panel.tab.session-info",
		moduleUrl: "./page.tsx",
		label: "会话信息",
		availability: "always",
	});
}

export default apply;
