/**
 * L2 宿主服务层公共类型（P1 服务抽取）。
 *
 * 设计约束见 `docs/review/0.5.0-m2-daemon-host-layering.md`：
 * L2 是纯 TS、零 cordis 依赖的服务注册表；cordis 试点（M2-2.9）成功后
 * 服务逐个迁移为 cordis Service（ctx.<key> 与本 key 同名），注册表退化
 * 为兼容垫片。因此 key 命名即未来 ctx 服务键，不得随意更改。
 *
 * 能力缝纪律（roadmap M2-2.4）：每个 DaemonService 实现的头注释必须
 * 声明自己的接缝——输入（RPC 路由/事件）、输出（返回值/广播）、
 * 生命周期（start/stop 的副作用与可逆性）。
 */
export interface DaemonService {
	/** 稳定服务键（未来 cordis 化的 ctx.<key>）。 */
	readonly key: string;

	/** 本服务认领的 RPC 路由：route → 方法名。注册表聚合成路由表，
	 * 路由覆盖快照测试据此强制"每个 case 必须归属某服务或 legacy 清单"。 */
	readonly routes?: Readonly<Record<string, string>>;

	/** 服务启动（无状态服务可不实现）。 */
	start?(): Promise<void> | void;

	/** 服务停止：反向卸载 start/构造的全部副作用（cordis effect 语义
	 * 等价物），供未来热重载与 orderly shutdown 使用。 */
	stop?(): Promise<void> | void;
}
