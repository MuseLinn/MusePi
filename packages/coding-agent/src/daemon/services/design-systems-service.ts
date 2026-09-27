import { listDesignSystems } from "../../presets/design-systems";
import type { DaemonService } from "./types";

/**
 * DesignSystemsService — 设计体系注册表（M3 §3）的 L2 宿主服务。
 *
 * 能力缝声明（M2.4）：
 * - 名称+ns：design-systems（RPC 路由 `design.systems.list`）。
 * - 输入：无参数；session-less（注册表是宿主级共享视图，与
 *   `media.providers` 同级）。
 * - 输出：`{ systems: DesignSystemListEntry[] }` —— 内置五套在前
 *   （source:"builtin"），扩展注册按注册序在后（source:"extension"）；
 *   每条含完整 config 字段（id/label/description/swatches/tokens/
 *   promptSection/templates?）+ source 徽章，供预览 rail 直渲染。
 * - 生命周期：无进程内状态——每次调用直读注册表模块；start/stop 无副作用。
 * - 启停：always-on——注册表模块常驻，服务本体无可卸载状态（声明理由：
 *   与 media.providers 同一形态，列表是 GUI 空态的基础数据面）。
 * - 冲突：无——只读视图；注册/注销的防撞契约归 `presets/design-systems.ts`。
 *   检视入口：本文件 + `presets/design-systems.ts` + 扩展 API
 *   `extensibility/extensions/types.ts`（DesignSystemConfig）。
 */
export class DesignSystemsService implements DaemonService {
	readonly key = "design-systems";
	readonly routes = {
		"design.systems.list": "listDesignSystems",
	} as const;

	/** RPC design.systems.list：builtin + extension 合并列表（预览 rail 数据源）。 */
	async listDesignSystems(): Promise<{ systems: DesignSystemListEntry[] }> {
		return {
			systems: listDesignSystems().map(({ config, source }) => ({
				...config,
				templates: config.templates ?? null,
				source,
			})),
		};
	}
}

export type DesignSystemListEntry = {
	id: string;
	label: string;
	description: string;
	swatches: readonly string[];
	tokens: Record<string, string>;
	promptSection: { name: string; order: number; text: string };
	templates: unknown[] | null;
	source: "builtin" | "extension";
};
