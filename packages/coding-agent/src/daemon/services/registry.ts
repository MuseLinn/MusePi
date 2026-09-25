import type { DaemonService } from "./types";

/**
 * 宿主服务注册表（L2）。纯 TS、零第三方依赖。
 *
 * 现状（P1 服务抽取期）：DaemonServer 在构造时注册各服务，巨型 switch
 * 的 case 逐个改为委托 `services.get(key).<method>(params)`；未委托的
 * case 必须存在于 `legacy-routes.ts` 清单（路由覆盖快照测试强制）。
 *
 * 未来（P2 cordis 适配期）：本类退化为兼容垫片——服务逐个迁移为 cordis
 * Service 后，get() 从 cordis Context 解析，`routeTable()` 由 Loader 配置
 * 生成。接口形状刻意保持两种实现都满足。
 */
export class HostServices {
	readonly #services = new Map<string, DaemonService>();

	register(service: DaemonService): void {
		if (this.#services.has(service.key)) {
			throw new Error(`HostServices: duplicate service key "${service.key}"`);
		}
		this.#services.set(service.key, service);
	}

	has(key: string): boolean {
		return this.#services.has(key);
	}

	keys(): string[] {
		return [...this.#services.keys()];
	}

	get<T extends DaemonService>(key: string): T {
		const service = this.#services.get(key);
		if (!service) throw new Error(`HostServices: unknown service "${key}"`);
		return service as T;
	}

	/** 聚合全部服务的路由表：route → serviceKey。重复认领同一路由即抛错
	 * （路由唯一归属是 P1 的硬纪律）。 */
	routeTable(): Map<string, string> {
		const table = new Map<string, string>();
		for (const service of this.#services.values()) {
			if (!service.routes) continue;
			for (const route of Object.keys(service.routes)) {
				const owner = table.get(route);
				if (owner) {
					throw new Error(`HostServices: route "${route}" claimed by both "${owner}" and "${service.key}"`);
				}
				table.set(route, service.key);
			}
		}
		return table;
	}
}
