import { Context, type Fiber } from "@deepseek-ai/cordis";
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
 * - 生命周期：双跑期（P2）服务的 start/stop 权威仍在 P1 既有代码（注册表
 *   不编排生命周期，server.ts 仅 schedule.start() 一处临时调用），本文件
 *   挂载时**不代调** start/stop——cordis 卸载不回充副作用，Context 拆掉
 *   即无损回 P1 形态（strangler-fig 可回滚承诺）。首个真正 cordis 化服务
 *   （SessionService）落地时，按服务逐个把生命周期切给 cordis effect 账本。
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

	/** 挂载一个 L2 服务为 cordis 插件（provide = 服务键，未来 ctx.<key>）。
	 *  返回 fiber 句柄：await 它即等挂载落定（apply 完成、服务可解析）。 */
	mount(service: DaemonService, opts?: MountOptions): Fiber & PromiseLike<Fiber> {
		const key = service.key;
		if (this.#fibers.has(key)) {
			throw new Error(`DaemonHostContext: duplicate service key "${key}"`);
		}
		const lifecycle = opts?.lifecycle ?? "external";
		const fiber = this.#root.plugin({
			name: `daemon-service:${key}`,
			apply: ctx => {
				if (lifecycle === "cordis") service.start?.();
				ctx.provide(key, service);
				if (lifecycle === "cordis") return () => service.stop?.();
			},
		});
		this.#fibers.set(key, fiber);
		Promise.resolve(fiber).catch(err => {
			logger.error("DaemonHostContext: service mount failed", { key, err });
		});
		return fiber;
	}

	/** 双跑校验/调试入口：cordis 侧解析服务（与注册表同源实例）。 */
	get<T extends DaemonService>(key: string): T | undefined {
		return this.#root.get(key, false) as T | undefined;
	}

	/** 检视面：已挂载键 + cordis 注册表规模（cordisInspect 等价物的最小集）。 */
	inspect(): { keys: string[]; registrySize: number } {
		return { keys: [...this.#fibers.keys()], registrySize: this.#root.registry.size };
	}

	/** 拆卸根 Context：插件 fiber 全量卸载。双跑期（external 生命周期）
	 *  不触碰服务 stop——回滚后 P1 代码路径不受影响。幂等。 */
	async dispose(): Promise<void> {
		try {
			await this.#root.fiber.dispose();
		} catch (err) {
			logger.warn("DaemonHostContext: dispose non-fatal", { err });
		}
		this.#fibers.clear();
	}
}

/** 便捷工厂：把注册表里的全部服务以 external 生命周期挂载（P2 双跑默认）。 */
export function mountRegistryServices(
	hostContext: DaemonHostContext,
	services: Iterable<DaemonService>,
): (Fiber & PromiseLike<Fiber>)[] {
	const fibers: (Fiber & PromiseLike<Fiber>)[] = [];
	for (const service of services) {
		fibers.push(hostContext.mount(service));
	}
	return fibers;
}
