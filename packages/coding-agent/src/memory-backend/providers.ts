/**
 * 六字段能力缝声明（索引：docs/capability-seams.md「记忆后端 provider seam」）：
 * - 名称+ns：`MemoryBackendProvider`，`registerMemoryBackendProvider(provider)`。
 * - 输入：后端 id 与 `(settings) => MemoryBackend` 工厂。
 * - 输出：`resolveMemoryBackend` 优先返回该实现；disposer 恢复内置后端。
 * - 生命周期：插件 apply 时注册；扩展卸载/重载或 disposer 调用时注销。
 * - 启停：同一 id 只能有一个 provider；插件缺失时回退内置实现。
 * - 冲突：重复 id 拒绝；后端引擎仍是宿主领域服务，provider 只替换实现。
 * - 检视入口：本文件、`resolve.ts` 与 `test/memory-backend-provider.test.ts`。
 */
import type { Settings } from "../config/settings";
import type { MemoryBackend, MemoryBackendId } from "./types";

/**
 * A backend implementation contributed by a Cordis plugin. The provider owns
 * construction only; `start`, `clear`, `enqueue`, and the prompt hooks stay on
 * the returned backend.
 */
export interface MemoryBackendProvider {
	readonly id: MemoryBackendId;
	create(settings: Settings): Promise<MemoryBackend> | MemoryBackend;
}

const providers = new Map<MemoryBackendId, MemoryBackendProvider>();

/** Register one backend implementation. A second provider for the same id is
 *  refused rather than silently replacing the first; unregister before
 *  registering a replacement. */
export function registerMemoryBackendProvider(provider: MemoryBackendProvider): () => void {
	if (providers.has(provider.id)) {
		throw new Error(`A memory backend provider for "${provider.id}" is already registered.`);
	}
	providers.set(provider.id, provider);
	return () => {
		if (providers.get(provider.id) === provider) providers.delete(provider.id);
	};
}

export function findMemoryBackendProvider(id: MemoryBackendId): MemoryBackendProvider | undefined {
	return providers.get(id);
}
