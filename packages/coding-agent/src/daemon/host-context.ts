import { Context, type Fiber, type Plugin } from "@deepseek-ai/cordis";
import { logger } from "@musepi/pi-utils";
import type { DaemonService } from "./services/types";

/**
 * daemon 宿主 cordis 组合内核（P2 首刀，ADR 0001「cordis 收编边界与分层纪律」）。
 *
 * 能力缝声明（M2-2.4）：
 * - 输入：DaemonServer 构造完成后的 L2 服务集合（HostServices 注册表的
 *   同源实例，本文件是唯一 cordis 适配点——ADR 边界 2）。
 * - 输出：cordis 根 Context 上的服务提供（`ctx.<key>` 可解析）、检视面
 *   （registry size / 挂载键清单）、orderly shutdown 通路（fiber.dispose）。
 * - 生命周期：**逐服务声明**（`MountRegistryOptions.lifecycleByKey`）。未列入的
 *   服务 start/stop 权威仍在 P1 代码，挂载时代调——strangler-fig 的可回滚承诺
 *   由此成立（Context 拆掉即回 P1 形态）。列入 `"cordis"` 的服务由 apply 代调
 *   start、disposer 反向回收 stop：语义从"手写纪律"升级为"框架保证"，且
 *   disposer 一定跑得到（手写调用没有这个对称面）。当前唯一列入者是 schedule
 *   （收编第二刀）；其余服务逐个翻。
 * - 启停：随 daemon 进程创建/消亡；`dispose()` 在 daemon close 路径调用。
 *   冲突：路由唯一归属仍由 HostServices.routeTable 强制，cordis 不参与
 *   路由分发（垫片期注册表是 dispatch 权威）。
 *
 * 测试纪律（ADR 边界 3）：用真 cordis Context（纯内存、无 IO），不 mock。
 */

/** 挂载期选项。 */
export interface MountOptions {
	/**
	 * 生命周期权威："external"（默认，P2 双跑期）——挂载只 provide 不代调
	 * start/stop；"cordis"——start 即 apply、stop 即 disposer（effect 账本
	 * 反向回收），仅对已确认无副作用重复的服务启用。
	 */
	lifecycle?: "external" | "cordis";
}

export class DaemonHostContext {
	readonly #root = new Context();
	readonly #fibers = new Map<string, Fiber & PromiseLike<Fiber>>();

	/** Mount one L2 service as a Cordis plugin. */
	mount(service: DaemonService, opts?: MountOptions): Fiber & PromiseLike<Fiber> {
		const key = service.key;
		if (this.#fibers.has(key)) throw new Error(`DaemonHostContext: duplicate service key "${key}"`);
		const lifecycle = opts?.lifecycle ?? "external";
		const fiber = this.plugin({
			name: `daemon-service:${key}`,
			apply: ctx => {
				if (lifecycle === "cordis") service.start?.();
				ctx.provide(key, service);
				if (lifecycle === "cordis") return () => service.stop?.();
			},
		});
		this.#fibers.set(key, fiber);
		return fiber;
	}

	/** Mount a plugin outside the service registry, such as the dynamic group. */
	plugin(definition: Plugin.Object): Fiber & PromiseLike<Fiber> {
		const fiber = this.#root.plugin(definition);
		Promise.resolve(fiber).catch(err => {
			logger.error("DaemonHostContext: plugin mount failed", { name: definition.name, err });
		});
		return fiber;
	}

	get<T extends DaemonService>(key: string): T | undefined {
		return this.#root.get(key, false) as T | undefined;
	}

	inspect(): { keys: string[]; registrySize: number } {
		return { keys: [...this.#fibers.keys()], registrySize: this.#root.registry.size };
	}

	async dispose(): Promise<void> {
		try {
			await this.#root.fiber.dispose();
		} catch (err) {
			logger.warn("DaemonHostContext: dispose non-fatal", { err });
		}
		this.#fibers.clear();
	}
}

/** mountRegistryServices 的挂载期选项。 */
export interface MountRegistryOptions {
	/** 按服务键指定生命周期权威，缺省即全部 "external"（P2 双跑默认）。
	 *  翻成 "cordis" 的服务由 apply 代调 start、disposer 代调 stop——收编刀口
	 *  按服务逐个推进，未翻的仍由 P1 代码掌管生命周期。 */
	lifecycleByKey?: Readonly<Record<string, "external" | "cordis">>;
}

/** L2 服务挂载失败（daemon 启动期契约）。
 *
 * 失败必须在启动期暴露。服务缺席时路由表仍认领它的 RPC，调用会一路走到
 * 派发才炸在一个与根因无关的位置（spike 报告「启动失败传播」：daemon 要求
 * 服务 start 失败 = 进程启动失败）。带上服务键，运维才知道该看哪个服务。
 */
export class DaemonServiceMountError extends Error {
	readonly serviceKey: string;

	constructor(serviceKey: string, cause: unknown) {
		super(`Daemon service "${serviceKey}" failed to mount on the cordis host context`, { cause });
		this.name = "DaemonServiceMountError";
		this.serviceKey = serviceKey;
	}
}

/** 便捷工厂：把注册表里的全部服务以 external 生命周期挂载（P2 双跑默认）
 *  并**按注册序 await** 落定。
 *
 * 返回 fiber 句柄供调用方继续持有。任何一个服务 apply 抛错即以
 * {@link DaemonServiceMountError} 中止——调用方据此让 daemon 启动失败。
 * 重复键这类编程错误在挂载期就地抛（不进 await 循环），保持栈可读。
 */
export async function mountRegistryServices(
	hostContext: DaemonHostContext,
	services: Iterable<DaemonService>,
	options?: MountRegistryOptions,
): Promise<(Fiber & PromiseLike<Fiber>)[]> {
	const mounted: { key: string; fiber: Fiber & PromiseLike<Fiber> }[] = [];
	for (const service of services) {
		const lifecycle = options?.lifecycleByKey?.[service.key];
		mounted.push({
			key: service.key,
			fiber: hostContext.mount(service, lifecycle ? { lifecycle } : undefined),
		});
	}
	for (const { key, fiber } of mounted) {
		try {
			await fiber;
		} catch (err) {
			throw new DaemonServiceMountError(key, err);
		}
	}
	return mounted.map(m => m.fiber);
}
