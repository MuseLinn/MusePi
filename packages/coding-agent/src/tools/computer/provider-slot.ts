/**
 * 六字段能力缝声明（索引：docs/capability-seams.md「computer-use provider 槽位」）：
 * - 名称+ns：`ComputerProvider`；`computerProviders.register(provider, {ownerId?})`，
 *   便捷入口 `registerComputerProvider(provider, {ownerId?})`。
 * - 输入：provider 名与可选的 `release()`；槽位只锁名，不转发调用。
 * - 输出：`computerProviders.providerName`（冲突点名与诊断）；`ComputerSupervisor` 每轮写入
 *   `ComputerSessionSnapshot.computerProvider`，取接单中的 provider 名（空槽或释放中为 `builtin`）。
 * - 生命周期：宿主插件 apply 时注册；disposer 调用、扩展卸载或 owner 释放时注销。
 * - 启停：同一时刻只允许一个 provider；未注册时由 worker 内置 desktop 会话回答。
 * - 冲突：第二次注册拒绝并点名现任 provider；disposer 先停止接单（`provider` 立即为
 *   null，`providerName` 仍可诊断），再 await provider 自有工作，最后清空槽位。
 * - 检视入口：本文件、`supervisor.ts` 的 `ComputerSupervisor.run`、`owner-release.ts`、
 *   `test/computer-provider-slot.test.ts`。
 */
/**
 * Computer-use provider slot.
 *
 * A host that answers computer use with its own backend (an external driver, a
 * sandbox, a remote desktop) claims this slot and registers its own tool face.
 * The slot records who answers and owns the lifecycle; it never routes calls.
 *
 * One provider answers at a time. A second registration fails with the
 * incumbent's name — including a repeat of the same name, because the slot
 * tracks the registration rather than the string. Releasing stops admitting
 * work first, then awaits the provider's own teardown, so an owner ending its
 * session never leaves a half-closed provider behind.
 */

import { registerOwnerRelease } from "./owner-release";

/** One provider claiming the sole computer-use slot. */
export interface ComputerProvider {
	/** Stable name used in registration diagnostics, the session snapshot and the UI. */
	readonly name: string;
	/**
	 * Stops admitting calls and awaits the work this provider owns. Runs once,
	 * after the slot stopped naming this provider as the accepted answerer; the
	 * slot clears even when it throws.
	 *
	 * Ending the owner's session waits at most 3 s for this call
	 * (`agent-session.ts`), so settle inside that budget: abort outstanding work
	 * instead of letting it run to completion.
	 */
	release?(): void | Promise<void>;
}

interface Registration {
	provider: ComputerProvider;
	releasing: boolean;
	released?: Promise<void>;
}

/** Exclusive slot for the host provider that answers computer use. */
export class ComputerProviderSlot {
	#registration: Registration | null = null;

	/** Name of the registered provider, including while it is being released.
	 *  This is the conflict/diagnostic view; {@link provider} is the answerer. */
	get providerName(): string | null {
		return this.#registration?.provider.name ?? null;
	}

	/** The provider accepting work, or null when the slot is empty or the
	 *  incumbent is releasing. */
	get provider(): ComputerProvider | null {
		return this.#registration?.releasing === true ? null : (this.#registration?.provider ?? null);
	}

	/**
	 * Claims the slot until the returned disposer settles.
	 *
	 * The disposer is idempotent: the first call stops admitting work
	 * synchronously, then awaits {@link ComputerProvider.release}; later calls
	 * return the same promise. With an `ownerId` the disposer also runs when
	 * that owner's session ends.
	 */
	register(provider: ComputerProvider, options: { ownerId?: string } = {}): () => Promise<void> {
		const current = this.#registration;
		if (current !== null) {
			throw new Error(`computer provider "${current.provider.name}" is already registered`);
		}
		const registration: Registration = { provider, releasing: false };
		this.#registration = registration;
		const release = (): Promise<void> => {
			if (registration.released) return registration.released;
			registration.releasing = true;
			unregisterOwner();
			registration.released = (async () => {
				try {
					await provider.release?.();
				} finally {
					if (this.#registration === registration) this.#registration = null;
				}
			})();
			return registration.released;
		};
		const unregisterOwner = registerOwnerRelease(options.ownerId, release);
		return release;
	}
}

/** Process-wide slot the computer tool consults for each run. */
export const computerProviders = new ComputerProviderSlot();

/** Convenience wrapper over {@link computerProviders}. */
export function registerComputerProvider(
	provider: ComputerProvider,
	options?: { ownerId?: string },
): () => Promise<void> {
	return computerProviders.register(provider, options);
}
