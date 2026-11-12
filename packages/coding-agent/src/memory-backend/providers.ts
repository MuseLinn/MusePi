/**
 * 六字段能力缝声明（索引：docs/capability-seams.md「记忆后端 provider seam」）：
 * - 名称+ns：`MemoryBackendProvider`，`registerMemoryBackendProvider(provider)`。
 * - 输入：后端 id、显示用 `label` / `description`、`(settings) => MemoryBackend` 工厂。
 * - 输出：`resolveMemoryBackend` 优先返回该实现；`memory.backend` 的枚举与设置
 *   选项由已注册 provider 合并而来；disposer 移除该后端并恢复内置实现。
 * - 生命周期：插件 apply 时注册；扩展卸载/重载或 disposer 调用时注销。
 * - 启停：同一 id 只能有一个 provider；插件缺失时回退内置实现。
 * - 冲突：重复 id 拒绝；后端引擎仍是宿主领域服务，provider 只替换或新增实现。
 * - 检视入口：本文件、`resolve.ts` 与 `test/memory-backend-provider.test.ts`。
 */
import type { Settings } from "../config/settings";
import type { MemoryBackend, MemoryBackendId } from "./types";

/**
 * A backend implementation contributed by a Cordis plugin. The provider owns
 * construction only; `start`, `clear`, `enqueue`, and the prompt hooks stay on
 * the returned backend.
 *
 * `label` and `description` are what the settings picker shows for a backend id
 * the host does not know; built-in ids keep their localized schema copy.
 */
export interface MemoryBackendProvider {
	readonly id: MemoryBackendId;
	readonly label?: string;
	readonly description?: string;
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

export interface MemoryBackendProviderReplacement {
	commit(): void;
	dispose(): void;
}

/**
 * Replace a provider while retaining the incumbent for a failed mount.
 * `dispose` restores the incumbent before `commit`, and unloads the successor after it.
 */
export function replaceMemoryBackendProvider(provider: MemoryBackendProvider): MemoryBackendProviderReplacement {
	const previous = providers.get(provider.id);
	providers.set(provider.id, provider);
	let committed = false;
	return {
		commit() {
			committed = true;
		},
		dispose() {
			if (providers.get(provider.id) !== provider) return;
			if (committed) providers.delete(provider.id);
			else if (previous) providers.set(provider.id, previous);
			else providers.delete(provider.id);
		},
	};
}

export function findMemoryBackendProvider(id: MemoryBackendId): MemoryBackendProvider | undefined {
	return providers.get(id);
}

/** Every registered backend, in registration order. */
export function listMemoryBackendProviders(): readonly MemoryBackendProvider[] {
	return [...providers.values()];
}

/** Backend ids a `memory.backend` choice may hold: the host's built-in ids plus
 *  every provider a plugin registered. The picker and the setting's enum share
 *  this list so a contributed backend is selectable without a host change. */
export function memoryBackendIds(builtIn: readonly string[]): readonly string[] {
	const ids = new Set<string>(builtIn);
	for (const provider of providers.values()) ids.add(provider.id);
	return [...ids];
}
