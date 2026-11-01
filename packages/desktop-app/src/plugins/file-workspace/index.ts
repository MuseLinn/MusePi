import { FILE_WORKSPACE_SLOT } from "../../lib/file-workspace";

/**
 * 能力缝声明（索引：docs/capability-seams.md「Cordis 文件工作区」）：
 * - 名称+ns：`file-workspace` 桌面 Cordis 插件、`panel.tab.files` 动态面板槽位。
 * - 输入：宿主标签、草稿存储、外部定位、编辑历史与 daemon 文件 RPC。
 * - 输出：文件树、文本/Markdown 编辑、PDF/Office/媒体预览与引用工具。
 * - 生命周期：面板随插件 fiber 和槽位挂载/卸载；草稿与标签始终归宿主。
 * - 启停：停用时移除文件入口和渲染，不保留静态 FilePane 备用实现。
 * - 冲突：沿用 `files` 标签 ID，旧布局直接恢复，不建立第二套文件工作区。
 * - 检视入口：本目录与 `file-workspace-plugin.test.tsx`。
 */
interface FileWorkspacePluginApi {
	setLabel(label: string): void;
	registerComponent(component: {
		slot: typeof FILE_WORKSPACE_SLOT;
		moduleUrl: "./page.tsx";
		label: string;
		availability: "always";
	}): void;
}

export const name = "musepi-file-workspace";
export const inject = [] as const;
export const provide = [] as const;

export function apply(pi: FileWorkspacePluginApi): void {
	pi.setLabel("MusePi 文件工作区");
	pi.registerComponent({
		slot: FILE_WORKSPACE_SLOT,
		moduleUrl: "./page.tsx",
		label: "文件",
		availability: "always",
	});
}

export default apply;
