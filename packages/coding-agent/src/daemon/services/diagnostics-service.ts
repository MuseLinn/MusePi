import type { DaemonService } from "./types";

/**
 * DiagnosticsService — 宿主服务的自检面（L2 宿主服务）。
 *
 * 能力缝声明：
 * - 名称/命名空间：`diagnostics`；RPC `system.services`。
 * - 输入：无参数。宿主注入两个只读快照源（cordis 挂载面 + 注册表），
 *   服务本身不持有任何缓存。
 * - 输出：`{ registrySize, services[{ key, lifecycle, routes }], lifecycle }`
 *   ——已挂载服务、每个服务的生命周期权威（cordis 代管或 external 自管）、
 *   它认领的 RPC，按 key 排序，另附两种权威的计数。
 * - 生命周期：无自有状态、无定时器；每次调用向宿主取一次快照。
 * - 启停：常驻，无启停副作用。
 * - 冲突：只读检视，不参与路由分发；不回答会话、设置或扩展问题。
 *
 * 为什么是运行时而不是生成物：注册表是路由归属的唯一权威，静态生成的服务
 * 清单会与运行中的挂载面漂移（哪个服务真的挂上了、谁管启停都只有 Context
 * 知道）。需要一份可读清单时，调这个 RPC 即可；模型与 /debug 看到的是同一
 * 份事实。
 */
export interface DaemonServiceCatalogEntry {
	key: string;
	lifecycle: "cordis" | "external";
	routes: string[];
}

export interface DaemonServiceCatalog {
	/** cordis 根 registry 的大小（服务之外还含插件提供的键）。 */
	registrySize: number;
	services: DaemonServiceCatalogEntry[];
	lifecycle: { cordis: number; external: number };
}

/** 宿主侧只读快照源：cordis 挂载面 + L2 注册表。 */
export interface DiagnosticsSources {
	inspect(): { keys: string[]; registrySize: number; lifecycles: Record<string, "external" | "cordis"> };
	services(): readonly Pick<DaemonService, "key" | "routes">[];
}

export class DiagnosticsService implements DaemonService {
	readonly key = "diagnostics";
	readonly routes = {
		"system.services": "list",
	} as const;

	readonly #sources: DiagnosticsSources;

	constructor(sources: DiagnosticsSources) {
		this.#sources = sources;
	}

	/** RPC `system.services`：已挂载服务清单 + 生命周期权威。 */
	list(): DaemonServiceCatalog {
		const snapshot = this.#sources.inspect();
		const mounted = new Set(snapshot.keys);
		const services = this.#sources
			.services()
			.filter(service => mounted.has(service.key))
			.map(service => ({
				key: service.key,
				lifecycle: snapshot.lifecycles[service.key] ?? "external",
				routes: Object.keys(service.routes ?? {}).sort(),
			}))
			.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
		const lifecycle = { cordis: 0, external: 0 };
		for (const service of services) lifecycle[service.lifecycle] += 1;
		return { registrySize: snapshot.registrySize, services, lifecycle };
	}
}
