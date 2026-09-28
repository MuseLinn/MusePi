import type { LoadExtensionsResult } from "../../extensibility/extensions/types";
import {
	clearExtensionDesignSystems,
	listDesignSystems,
	registerExtensionDesignSystem,
} from "../../presets/design-systems";
import type { DaemonService } from "./types";

/**
 * DesignSystemsService — 设计体系注册表（M3 §3）的 L2 宿主服务。
 *
 * 能力缝声明（M2.4）：
 * - 名称+ns：design-systems（RPC 路由 `design.systems.list`）。
 * - 输入：无 RPC 参数；deps 注入 `extensionRuntimeLoad()`（宿主接
 *   ExtensionService.getExtensionRuntimeLoad——按会话同源 discovery 分支
 *   执行扩展入口代码、10s TTL 缓存、随失效入口清）。session-less（注册表
 *   是宿主级共享视图，与 `media.providers` 同级）。
 * - 输出：`{ systems: DesignSystemListEntry[] }` —— 内置五套在前
 *   （source:"builtin"），扩展注册按注册序在后（source:"extension"）；
 *   每条含完整 config 字段（id/label/description/swatches/tokens/
 *   promptSection/templates?）+ source 徽章，供预览 rail 直渲染。
 * - 生命周期：每次调用先经 deps 拿扩展运行时加载结果，对
 *   runtime.pendingDesignSystemRegistrations 做「按 sourceId 先 clear 再
 *   register」的幂等重放（防撞契约：不清就 register 会抛 id 冲突），再
 *   返回注册表合并视图——装包 → invalidateExtensionsCache + 广播
 *   extensions.changed → GUI 重拉 → 本 RPC 内重载扩展并重放 → 新体系即见；
 *   没装包时 TTL 缓存内零额外开销。服务自身只记账宿主重放过的 sourceId
 *   集（#replayedSources），对「本次加载结果里已消失的来源」整源清除，
 *   保证卸载/禁用后列表不残留。
 * - 启停：always-on——注册表模块常驻，服务本体无可卸载状态（声明理由：
 *   与 media.providers 同一形态，列表是 GUI 空态的基础数据面）。
 * - 冲突：重放沿用注册表防撞契约（撞内置/撞已注册抛）；扩展加载失败
 *   （load errors）由 loader 归入 errors 数组、不产出 runtime 注册，天然
 *   跳过该源。注册/注销的权威契约归 `presets/design-systems.ts`。
 *   检视入口：本文件 + `presets/design-systems.ts` + 扩展 API
 *   `extensibility/extensions/types.ts`（DesignSystemConfig）。
 */

export interface DesignSystemsServiceDeps {
	/** 宿主级扩展运行时加载（宿主接 ExtensionService.getExtensionRuntimeLoad）。 */
	extensionRuntimeLoad(): Promise<LoadExtensionsResult>;
}

export class DesignSystemsService implements DaemonService {
	readonly key = "design-systems";
	readonly routes = {
		"design.systems.list": "listDesignSystems",
	} as const;

	readonly #deps: DesignSystemsServiceDeps;

	/** 宿主重放已写入注册表的 sourceId 集：重放时对「本次加载结果里已
	 *  消失的来源」做整源清除（clearExtensionDesignSystems），保证
	 *  marketplace.remove / 禁用后列表不残留 stale 体系。 */
	#replayedSources = new Set<string>();

	constructor(deps: DesignSystemsServiceDeps) {
		this.#deps = deps;
	}

	/** RPC design.systems.list：builtin + extension 合并列表（预览 rail 数据源）。 */
	async listDesignSystems(): Promise<{ systems: DesignSystemListEntry[] }> {
		await this.#replayExtensionDesignSystems();
		return {
			systems: listDesignSystems().map(({ config, source }) => ({
				...config,
				templates: config.templates ?? null,
				source,
			})),
		};
	}

	/**
	 * 宿主级幂等重放（M3 §3.7d 装包即见）：对扩展运行时加载结果里的
	 * pendingDesignSystemRegistrations，按 sourceId 先 clear 再 register。
	 * 同一 sourceId 连续重放不产生冲突异常；加载失败的扩展不进 runtime
	 * 注册，静默跳过；加载结果里消失的已重放来源被整源清除。
	 */
	async #replayExtensionDesignSystems(): Promise<void> {
		const pending = (await this.#deps.extensionRuntimeLoad()).runtime.pendingDesignSystemRegistrations;
		const currentSources = new Set(pending.map(registration => registration.sourceId));
		for (const sourceId of this.#replayedSources) {
			if (!currentSources.has(sourceId)) {
				clearExtensionDesignSystems(sourceId);
				this.#replayedSources.delete(sourceId);
			}
		}
		for (const sourceId of currentSources) {
			clearExtensionDesignSystems(sourceId);
			for (const { config } of pending.filter(registration => registration.sourceId === sourceId)) {
				registerExtensionDesignSystem(config, sourceId);
			}
			this.#replayedSources.add(sourceId);
		}
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
